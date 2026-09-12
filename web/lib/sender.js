// 分享者侧：只有在收到 download-request 之后才读文件、发字节。

import { encodeDataFrame } from './framing.js';
import { DEFAULT_CHUNK_SIZE, chunkCount, chunkRange, nextChunkIndex } from './plan.js';
import {
  FILE_STATUS,
  KIND,
  cancelMessage,
  manifestMessage,
  parsePayload,
} from './protocol.js';
import { Sha256 } from './sha256.js';
import { SendWindow } from './window.js';

export const DEFAULT_WINDOW_BYTES = 8 * 1024 * 1024; // 8 MiB
export const DEFAULT_RESUME_TIMEOUT_MS = 30_000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;

/**
 * 登记前的预哈希（"上传前校验"）：只读本地文件，不发送任何字节。
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
      onProgress?.({
        fileIndex: i,
        path: info.path,
        processedBytes: processed,
        totalBytes: source.totalBytes,
      });
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
  #sentBytes = 0;

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

  get shareId() {
    return this.#manifest?.shareId ?? null;
  }

  get streamId() {
    return this.#manifest?.streamId ?? null;
  }

  get sentBytes() {
    return this.#sentBytes;
  }

  get aborted() {
    return this.#aborted;
  }

  async drain() {
    await this.#queue;
  }

  /**
   * 开始一次传输。只应由"收到 download-request"这一路径调用。
   * @returns {Promise<{shareId:string, manifest:object}>}
   */
  async send({ shareId, streamId, kind, files, senderName }) {
    const manifest = manifestMessage({
      shareId,
      streamId,
      kind,
      senderName,
      chunkSize: this.#chunkSize,
      files,
    });
    this.#manifest = manifest;
    this.#emit({ type: 'manifest', shareId, streamId, manifest });

    const resumePromise = this.#awaitResumeState(shareId);
    await this.#send(manifest);
    const resume = await resumePromise;
    const resumedByIndex = new Map(resume.files.map((file) => [file.i, file.received]));
    this.#emit({
      type: 'resumed',
      shareId,
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
      this.#emit({ type: 'retry', shareId, files: failed, round });
    }

    this.#emit({ type: 'complete', shareId, manifest });
    return { shareId, manifest };
  }

  /** 处理下载者发回的负载（ack / resume-state / file-done / ...）。 */
  handlePayload(raw) {
    this.#queue = this.#queue
      .then(() => this.#handlePayload(raw))
      .catch((error) => {
        this.#emit({ type: 'error', error, shareId: this.#manifest?.shareId });
      });
    return this.#queue;
  }

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
        cancelMessage({ shareId: this.#manifest.shareId, reason: error.message }),
      ).catch(() => {});
    }
    return error;
  }

  async #handlePayload(raw) {
    let message;
    try {
      message = parsePayload(raw);
    } catch (error) {
      this.#emit({ type: 'protocol-error', error });
      return;
    }
    if (message.shareId && this.#manifest && message.shareId !== this.#manifest.shareId) {
      this.#emit({ type: 'ignored', message });
      return;
    }

    switch (message.k) {
      case KIND.RESUME_STATE: {
        const waiters = this.#resumeWaiters;
        this.#resumeWaiters = [];
        for (const waiter of waiters) {
          waiter.resolve(message);
        }
        return;
      }
      case KIND.ACK: {
        this.#windows.get(message.i)?.ack(message.received);
        return;
      }
      case KIND.FILE_DONE: {
        this.#emit({
          type: 'file-done',
          shareId: message.shareId,
          fileIndex: message.i,
          status: message.status,
          sha256: message.sha256,
        });
        this.#fileStatus.set(message.i, message.status);
        const waiter = this.#fileWaiters.get(message.i);
        if (waiter) {
          this.#fileWaiters.delete(message.i);
          waiter.resolve(message.status);
        }
        return;
      }
      case KIND.TRANSFER_DONE:
        this.#emit({
          type: 'remote-complete',
          shareId: message.shareId,
          status: message.status,
        });
        return;
      case KIND.CANCEL:
        this.#fail(new Error(`下载方取消：${message.reason}`));
        return;
      case KIND.ERROR:
        this.#fail(new Error(`下载方报错（${message.code}）：${message.message}`));
        return;
      default:
        this.#emit({ type: 'ignored', message });
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
      await this.#channel.sendBinary(
        encodeDataFrame(this.#manifest.streamId, file.i, index, bytes),
      );
      window.add(length);
      sent += length;
      this.#sentBytes += length;
      this.#emit({
        type: 'progress',
        shareId: this.#manifest.shareId,
        streamId: this.#manifest.streamId,
        fileIndex: file.i,
        path: file.path,
        sent,
        size: file.size,
        resumedFrom: startChunk * chunkSize,
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
      shareId: this.#manifest.shareId,
      streamId: this.#manifest.streamId,
      fileIndex: file.i,
      path: file.path,
      size: file.size,
      sha256: actual,
    });
  }

  #awaitResumeState(shareId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`等待下载方的断点信息超时（${this.#resumeTimeoutMs}ms）`));
      }, this.#resumeTimeoutMs);
      this.#resumeWaiters.push({
        resolve: (message) => {
          clearTimeout(timer);
          if (message.shareId !== shareId) {
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
    await this.#channel.send(message);
  }

  #emit(event) {
    try {
      this.#onEvent(event);
    } catch {
      // 事件回调异常不影响传输
    }
  }
}
