// 发送核心：预哈希 → manifest → 断点续传 → 窗口流控 → 传输中复算 → 校验失败重传。

import { encodeDataFrame } from './framing.js';
import {
  DEFAULT_CHUNK_SIZE,
  chunkCount,
  chunkRange,
  nextChunkIndex,
  transferIdFromHashes,
} from './plan.js';
import {
  FILE_STATUS,
  MESSAGE,
  cancelMessage,
  manifestMessage,
  parseControl,
} from './protocol.js';
import { Sha256 } from './sha256.js';
import { SendWindow } from './window.js';

export const DEFAULT_WINDOW_BYTES = 8 * 1024 * 1024; // 8 MiB
export const DEFAULT_RESUME_TIMEOUT_MS = 30_000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;

/**
 * 发送前的预哈希（需求 R6 的"上传前校验"）。
 *
 * @param {{fileCount:number,totalBytes:number,file:(i:number)=>object,read:(i:number,offset:number,length:number)=>Promise<Uint8Array>}} source
 * @returns {Promise<Array<{i:number,path:string,size:number,mime?:string,sha256:string}>>}
 */
export async function hashSource(source, { chunkSize = DEFAULT_CHUNK_SIZE, onProgress } = {}) {
  const files = [];
  let processed = 0;
  for (let i = 0; i < source.fileCount; i++) {
    const info = source.file(i);
    const hasher = new Sha256();
    for (let offset = 0; offset < info.size; offset += chunkSize) {
      const length = Math.min(chunkSize, info.size - offset);
      const bytes = await source.read(i, offset, length);
      if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
        throw new Error(
          `读取 ${info.path} 的第 ${offset} 字节处得到 ${bytes?.length} 字节，期望 ${length}`,
        );
      }
      hasher.update(bytes);
      processed += length;
      onProgress?.({ fileIndex: i, path: info.path, processedBytes: processed, totalBytes: source.totalBytes });
    }
    files.push({
      i,
      path: info.path,
      size: info.size,
      mime: info.mime,
      sha256: hasher.hex(),
    });
  }
  return files;
}

export class Sender {
  #source;
  #channel;
  #chunkSize;
  #windowBytes;
  #resumeTimeoutMs;
  #verifyTimeoutMs;
  #maxRetries;
  #onEvent;
  #queue = Promise.resolve();
  #manifest = null;
  #windows = new Map();
  #fileStatus = new Map();
  #fileWaiters = new Map();
  #resumeWaiters = [];
  #aborted = null;

  constructor({
    source,
    channel,
    chunkSize = DEFAULT_CHUNK_SIZE,
    windowBytes = DEFAULT_WINDOW_BYTES,
    resumeTimeoutMs = DEFAULT_RESUME_TIMEOUT_MS,
    verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
    maxRetries = 1,
    onEvent = () => {},
  }) {
    if (!source || !channel) {
      throw new TypeError('Sender 需要 source 与 channel');
    }
    this.#source = source;
    this.#channel = channel;
    this.#chunkSize = chunkSize;
    this.#windowBytes = windowBytes;
    this.#resumeTimeoutMs = resumeTimeoutMs;
    this.#verifyTimeoutMs = verifyTimeoutMs;
    this.#maxRetries = maxRetries;
    this.#onEvent = onEvent;
  }

  attach() {
    this.#channel.onMessage((message) => {
      this.#enqueue(() => this.#handleMessage(message));
    });
    this.#channel.onClose(() => {
      this.abort(new Error('数据通道已关闭'));
    });
    return this;
  }

  get transferId() {
    return this.#manifest?.transferId ?? null;
  }

  get aborted() {
    return this.#aborted;
  }

  /** 等待内部消息队列处理完（测试/收尾用）。 */
  async drain() {
    await this.#queue;
  }

  /**
   * 发送一批文件（files 来自 hashSource，kind 来自 buildSelectionPlan）。
   * @returns {Promise<{transferId:string, manifest:object}>}
   */
  async send({ kind, files, senderName }) {
    const transferId = transferIdFromHashes(files);
    const manifest = manifestMessage({
      transferId,
      kind,
      senderName,
      chunkSize: this.#chunkSize,
      files,
    });
    this.#manifest = manifest;
    this.#emit({ type: 'manifest', manifest });

    const resumePromise = this.#awaitResumeState(manifest.transferId);
    await this.#send(manifest);
    const resume = await resumePromise;
    const resumedByIndex = new Map(resume.files.map((file) => [file.i, file.received]));
    this.#emit({
      type: 'resumed',
      transferId,
      resumedBytes: [...resumedByIndex.values()].reduce((sum, value) => sum + value, 0),
    });

    const verified = new Set();
    let round = 0;
    for (;;) {
      const todo = manifest.files.filter((file) => !verified.has(file.i));
      if (todo.length === 0) {
        break;
      }
      const waiting = [];
      for (const file of todo) {
        const from = round === 0 ? Math.min(resumedByIndex.get(file.i) ?? 0, file.size) : 0;
        if (from < file.size) {
          await this.#streamFile(file, from);
        }
        waiting.push(this.#waitFileDone(file.i, this.#verifyTimeoutMs));
      }
      const statuses = await Promise.all(waiting);

      const failed = [];
      todo.forEach((file, index) => {
        if (statuses[index] === FILE_STATUS.OK) {
          verified.add(file.i);
        } else {
          failed.push(file.i);
        }
      });
      if (failed.length === 0) {
        break;
      }
      if (round >= this.#maxRetries) {
        throw new Error(`文件校验失败且重试次数已用尽：序号 ${failed.join('、')}`);
      }
      round += 1;
      for (const fileIndex of failed) {
        this.#fileStatus.delete(fileIndex);
        this.#fileWaiters.delete(fileIndex);
      }
      this.#emit({ type: 'retry', transferId, files: failed, round });
    }

    this.#emit({ type: 'complete', transferId, manifest });
    return { transferId, manifest };
  }

  /** UI 取消：通知对端并让所有等待中的窗口失败。 */
  abort(reason) {
    if (this.#aborted) {
      return this.#aborted;
    }
    const error = reason instanceof Error ? reason : new Error(String(reason ?? '已取消'));
    this.#aborted = error;
    for (const window of this.#windows.values()) {
      window.fail(error);
    }
    for (const waiter of this.#resumeWaiters) {
      waiter.reject(error);
    }
    this.#resumeWaiters = [];
    for (const waiter of this.#fileWaiters.values()) {
      waiter.reject(error);
    }
    this.#fileWaiters.clear();
    if (this.#manifest) {
      void this.#send(
        cancelMessage({ transferId: this.#manifest.transferId, reason: error.message }),
      ).catch(() => {});
    }
    return error;
  }

  #enqueue(task) {
    this.#queue = this.#queue
      .then(task)
      .catch((error) => {
        this.#emit({ type: 'error', error, transferId: this.#manifest?.transferId });
      });
    return this.#queue;
  }

  async #handleMessage(message) {
    if (message?.binary) {
      // 发送方不接收数据帧
      this.#emit({ type: 'unexpected-binary', transferId: this.#manifest?.transferId });
      return;
    }
    let control;
    try {
      control = parseControl(message?.text);
    } catch (error) {
      this.#emit({ type: 'protocol-error', error });
      return;
    }
    if (control.transferId && this.#manifest && control.transferId !== this.#manifest.transferId) {
      this.#emit({ type: 'ignored', message: control });
      return;
    }

    switch (control.t) {
      case MESSAGE.RESUME_STATE: {
        const waiters = this.#resumeWaiters;
        this.#resumeWaiters = [];
        for (const waiter of waiters) {
          waiter.resolve(control);
        }
        return;
      }
      case MESSAGE.ACK: {
        this.#windows.get(control.i)?.ack(control.received);
        return;
      }
      case MESSAGE.FILE_DONE: {
        this.#emit({
          type: 'file-done',
          transferId: control.transferId,
          fileIndex: control.i,
          status: control.status,
          sha256: control.sha256,
        });
        this.#fileStatus.set(control.i, control.status);
        const waiter = this.#fileWaiters.get(control.i);
        if (waiter) {
          this.#fileWaiters.delete(control.i);
          waiter.resolve(control.status);
        }
        return;
      }
      case MESSAGE.TRANSFER_DONE:
        this.#emit({
          type: 'remote-complete',
          transferId: control.transferId,
          status: control.status,
        });
        return;
      case MESSAGE.CANCEL: {
        this.#fail(new Error(`对端取消：${control.reason}`));
        return;
      }
      case MESSAGE.ERROR: {
        this.#fail(new Error(`对端报错（${control.code}）：${control.message}`));
        return;
      }
      default:
        this.#emit({ type: 'ignored', message: control });
        return;
    }
  }

  async #streamFile(file, fromBytes) {
    const chunkSize = this.#chunkSize;
    const totalChunks = chunkCount(file.size, chunkSize);
    const startChunk = nextChunkIndex(fromBytes, chunkSize);
    const window = new SendWindow(this.#windowBytes);
    window.prime(startChunk * chunkSize);
    this.#windows.set(file.i, window);

    const hasher = new Sha256();
    let sent = startChunk * chunkSize;
    for (let index = 0; index < totalChunks; index++) {
      if (this.#aborted) {
        throw this.#aborted;
      }
      const { offset, length } = chunkRange(file.size, index, chunkSize);
      const bytes = await this.#source.read(file.i, offset, length);
      if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
        const error = new Error(`${file.path} 读取异常：期望 ${length} 字节，实际 ${bytes?.length}`);
        error.code = 'source-read';
        this.#fail(error);
        throw error;
      }
      // 传输中复算：断点之前的部分也重新读一遍，保证整份内容都被校验
      hasher.update(bytes);
      if (index < startChunk) {
        continue;
      }
      await window.waitForRoom(length);
      await this.#channel.sendBinary(encodeDataFrame(file.i, index, bytes));
      window.add(length);
      sent += length;
      this.#emit({
        type: 'progress',
        transferId: this.#manifest.transferId,
        fileIndex: file.i,
        path: file.path,
        sent,
        size: file.size,
        resumedFrom: startChunk * chunkSize,
        // 当前在途（已发未确认）字节：UI 可直接展示，测试用于验证流控不变量
        inflight: window.inflight,
      });
    }

    const actual = hasher.hex();
    if (actual !== file.sha256) {
      const error = new Error(`${file.path} 在传输过程中被修改，已中止（本地复算哈希不一致）`);
      error.code = 'source-changed';
      this.#fail(error);
      throw error;
    }
    this.#emit({
      type: 'file-sent',
      transferId: this.#manifest.transferId,
      fileIndex: file.i,
      path: file.path,
      size: file.size,
      sha256: actual,
    });
  }

  #awaitResumeState(transferId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`等待接收方断点信息超时（${this.#resumeTimeoutMs}ms）`));
      }, this.#resumeTimeoutMs);
      this.#resumeWaiters.push({
        resolve: (message) => {
          clearTimeout(timer);
          if (message.transferId !== transferId) {
            reject(new Error('收到了其它传输的断点信息'));
            return;
          }
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  #waitFileDone(fileIndex, timeoutMs) {
    if (this.#fileStatus.has(fileIndex)) {
      return Promise.resolve(this.#fileStatus.get(fileIndex));
    }
    let waiter = this.#fileWaiters.get(fileIndex);
    if (!waiter) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      waiter = { promise, resolve, reject, timer: null };
      this.#fileWaiters.set(fileIndex, waiter);
    }
    if (waiter.timer === null) {
      waiter.timer = setTimeout(() => {
        this.#fileWaiters.delete(fileIndex);
        waiter.reject(new Error(`等待文件 ${fileIndex} 的校验结果超时（${timeoutMs}ms）`));
      }, timeoutMs);
    }
    return waiter.promise.finally(() => clearTimeout(waiter.timer));
  }

  #fail(error) {
    this.#aborted = error;
    for (const window of this.#windows.values()) {
      window.fail(error);
    }
    for (const waiter of this.#fileWaiters.values()) {
      waiter.reject(error);
    }
    this.#fileWaiters.clear();
  }

  async #send(message) {
    await this.#channel.sendText(JSON.stringify(message));
  }

  #emit(event) {
    try {
      this.#onEvent(event);
    } catch {
      // 事件回调异常不影响传输
    }
  }
}
