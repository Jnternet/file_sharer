// 接收核心：控制消息解析 → 块落盘 → 流控 ACK → 完成后复算 SHA-256。
//
// 通过依赖注入（store / channel）与浏览器解耦，因此可以在 Node 里跑完整协议回环测试。

import { decodeDataFrame } from './framing.js';
import { chunkRange } from './plan.js';
import {
  FILE_STATUS,
  MESSAGE,
  TRANSFER_STATUS,
  ackMessage,
  errorMessage,
  fileDoneMessage,
  parseControl,
  resumeStateMessage,
  transferDoneMessage,
} from './protocol.js';
import { Sha256 } from './sha256.js';

export const ACK_INTERVAL_BYTES = 2 * 1024 * 1024; // 2 MiB

export class Receiver {
  #store;
  #channel;
  #onEvent;
  #ackInterval;
  #transfers = new Map();
  #ackedBytes = new Map();
  #activeTransferId = null;
  #queue = Promise.resolve();
  #closed = false;

  constructor({ store, channel, ackIntervalBytes = ACK_INTERVAL_BYTES, onEvent = () => {} }) {
    if (!store || !channel) {
      throw new TypeError('Receiver 需要 store 与 channel');
    }
    this.#store = store;
    this.#channel = channel;
    this.#ackInterval = ackIntervalBytes;
    this.#onEvent = onEvent;
  }

  attach() {
    this.#channel.onMessage((message) => {
      this.#enqueue(() => this.#handleMessage(message));
    });
    this.#channel.onClose(() => {
      this.#closed = true;
      this.#emit({ type: 'channel-closed' });
    });
    return this;
  }

  /** 已落盘的传输（供 UI 展示与下载）。 */
  async listTransfers() {
    return this.#store.listTransfers();
  }

  async readChunks(transferId, fileIndex) {
    return this.#store.readChunks(transferId, fileIndex);
  }

  async deleteTransfer(transferId) {
    this.#transfers.delete(transferId);
    await this.#store.deleteTransfer(transferId);
  }

  /** 外部定时器可以周期性调用，保证长时间没有新块时进度不卡住。 */
  async flushAcks() {
    for (const state of this.#transfers.values()) {
      for (const file of state.files) {
        if (file.received > 0) {
          // 强制回一次进度，即使还没到批量间隔
          const key = `${state.manifest.transferId}/${file.i}`;
          if ((this.#ackedBytes.get(key) ?? 0) >= file.received) {
            continue;
          }
        }
        await this.#sendAck(state, file, true);
      }
    }
  }

  /** 等待当前队列跑完（测试与收尾用）。 */
  async drain() {
    await this.#queue;
  }

  #enqueue(task) {
    this.#queue = this.#queue.then(task).catch((error) => {
      this.#emit({ type: 'error', error });
    });
    return this.#queue;
  }

  async #handleMessage(message) {
    if (message?.binary) {
      await this.#handleFrame(message.binary);
      return;
    }
    let control;
    try {
      control = parseControl(message?.text);
    } catch (error) {
      this.#emit({ type: 'protocol-error', error });
      return;
    }

    switch (control.t) {
      case MESSAGE.MANIFEST:
        await this.#handleManifest(control);
        return;
      case MESSAGE.CANCEL:
        this.#emit({ type: 'cancelled', transferId: control.transferId, reason: control.reason });
        return;
      case MESSAGE.ERROR:
        this.#emit({ type: 'remote-error', code: control.code, message: control.message });
        return;
      default:
        // 接收端不需要 ack/file-done/transfer-done/resume-state，忽略即可
        this.#emit({ type: 'ignored', message: control });
        return;
    }
  }

  async #handleManifest(manifest) {
    const existing = await this.#loadState(manifest);
    const state = existing ?? {
      manifest,
      files: manifest.files.map((file) => ({
        ...file,
        received: 0,
        chunks: 0,
        verified: false,
      })),
    };
    state.manifest = manifest;
    this.#transfers.set(manifest.transferId, state);
    this.#activeTransferId = manifest.transferId;

    await this.#store.saveManifest(manifest);
    this.#emit({
      type: 'manifest',
      manifest,
      resumedBytes: state.files.reduce((sum, file) => sum + file.received, 0),
    });

    await this.#send(
      resumeStateMessage({
        transferId: manifest.transferId,
        files: state.files.map((file) => ({ i: file.i, received: file.received })),
      }),
    );

    // 已经有完整数据的文件（含 0 字节文件）立即进入校验
    for (const file of state.files) {
      if (!file.verified && file.received >= file.size) {
        await this.#finishFile(state, file);
      }
    }
  }

  async #loadState(manifest) {
    const stored = await this.#store.loadTransfer(manifest.transferId);
    if (!stored) {
      return null;
    }
    if (!sameFiles(stored.manifest, manifest)) {
      // 内容寻址下不应发生：同 ID 不同内容说明数据不可信，直接丢弃重来
      this.#emit({ type: 'discarded', transferId: manifest.transferId });
      await this.#store.deleteTransfer(manifest.transferId);
      return null;
    }
    return {
      manifest,
      files: manifest.files.map((file) => {
        const storedFile = stored.files.find((candidate) => candidate.i === file.i);
        const received = Math.min(storedFile?.received ?? 0, file.size);
        return {
          ...file,
          received,
          chunks: storedFile?.chunks ?? 0,
          // 即使看起来已经收满，也要重新校验一次（校验通过才算数）
          verified: false,
        };
      }),
    };
  }

  async #handleFrame(bytes) {
    const state = this.#transfers.get(this.#activeTransferId);
    if (!state) {
      this.#emit({ type: 'unexpected-frame' });
      return;
    }
    let frame;
    try {
      frame = decodeDataFrame(bytes);
    } catch (error) {
      this.#emit({ type: 'protocol-error', error, transferId: state.manifest.transferId });
      return;
    }

    const file = state.files[frame.fileIndex];
    if (!file) {
      await this.#send(
        errorMessage({
          transferId: state.manifest.transferId,
          code: 'unknown-file',
          message: `文件序号 ${frame.fileIndex} 不在 manifest 中`,
        }),
      );
      return;
    }

    let range;
    try {
      range = chunkRange(file.size, frame.chunkIndex, state.manifest.chunkSize);
    } catch (error) {
      await this.#send(
        errorMessage({
          transferId: state.manifest.transferId,
          code: 'bad-chunk',
          message: error.message,
        }),
      );
      return;
    }
    if (frame.payload.length !== range.length) {
      await this.#send(
        errorMessage({
          transferId: state.manifest.transferId,
          code: 'bad-chunk-length',
          message: `块 ${frame.chunkIndex} 长度应为 ${range.length}，实际 ${frame.payload.length}`,
        }),
      );
      return;
    }

    const nextExpected = file.received / state.manifest.chunkSize;
    if (frame.chunkIndex < nextExpected) {
      // 断点续传/重传时的重复块：幂等忽略，但仍然回 ACK
      await this.#sendAck(state, file, true);
      return;
    }
    if (frame.chunkIndex > nextExpected) {
      await this.#send(
        errorMessage({
          transferId: state.manifest.transferId,
          code: 'out-of-order',
          message: `期望块 ${nextExpected}，实际收到 ${frame.chunkIndex}`,
        }),
      );
      return;
    }

    await this.#store.putChunk({
      transferId: state.manifest.transferId,
      fileIndex: file.i,
      chunkIndex: frame.chunkIndex,
      bytes: frame.payload,
    });
    file.received += range.length;
    file.chunks += 1;

    this.#emit({
      type: 'progress',
      transferId: state.manifest.transferId,
      fileIndex: file.i,
      received: file.received,
      size: file.size,
      transferReceived: state.files.reduce((sum, candidate) => sum + candidate.received, 0),
      transferTotal: state.manifest.totalBytes,
    });

    await this.#sendAck(state, file, false);

    if (file.received >= file.size) {
      await this.#finishFile(state, file);
    }
  }

  async #sendAck(state, file, force) {
    const key = `${state.manifest.transferId}/${file.i}`;
    const last = this.#ackedBytes.get(key) ?? 0;
    if (!force && file.received - last < this.#ackInterval) {
      return;
    }
    this.#ackedBytes.set(key, file.received);
    await this.#send(
      ackMessage({
        transferId: state.manifest.transferId,
        i: file.i,
        received: file.received,
        totalReceived: state.files.reduce((sum, candidate) => sum + candidate.received, 0),
      }),
    );
  }

  /** 落盘数据复算 SHA-256：这是"下载完成后"的那一道校验。 */
  async #finishFile(state, file) {
    const hasher = new Sha256();
    for await (const chunk of this.#store.readChunks(state.manifest.transferId, file.i)) {
      hasher.update(chunk);
    }
    const actual = hasher.hex();

    if (actual === file.sha256) {
      file.verified = true;
      this.#emit({
        type: 'file-done',
        transferId: state.manifest.transferId,
        fileIndex: file.i,
        path: file.path,
        size: file.size,
        sha256: actual,
        status: FILE_STATUS.OK,
      });
      await this.#send(
        fileDoneMessage({
          transferId: state.manifest.transferId,
          i: file.i,
          status: FILE_STATUS.OK,
          sha256: actual,
        }),
      );
    } else {
      // 校验失败：丢弃该文件的所有块，要求发送方从 0 重传
      await this.#store.deleteFile(state.manifest.transferId, file.i);
      file.received = 0;
      file.chunks = 0;
      file.verified = false;
      this.#ackedBytes.delete(`${state.manifest.transferId}/${file.i}`);
      this.#emit({
        type: 'file-done',
        transferId: state.manifest.transferId,
        fileIndex: file.i,
        path: file.path,
        size: file.size,
        sha256: actual,
        status: FILE_STATUS.HASH_MISMATCH,
      });
      await this.#send(
        fileDoneMessage({
          transferId: state.manifest.transferId,
          i: file.i,
          status: FILE_STATUS.HASH_MISMATCH,
          sha256: actual,
          message: '接收数据校验失败，已丢弃并要求重传',
        }),
      );
    }

    if (state.files.every((candidate) => candidate.verified)) {
      this.#emit({ type: 'complete', transferId: state.manifest.transferId, manifest: state.manifest });
      await this.#send(
        transferDoneMessage({
          transferId: state.manifest.transferId,
          status: TRANSFER_STATUS.OK,
        }),
      );
    }
  }

  async #send(message) {
    await this.#channel.sendText(JSON.stringify(message));
  }

  #emit(event) {
    try {
      this.#onEvent(event);
    } catch {
      // 事件回调的异常不应影响传输主流程
    }
  }
}

function sameFiles(storedManifest, manifest) {
  if (!storedManifest || storedManifest.files.length !== manifest.files.length) {
    return false;
  }
  return manifest.files.every((file, index) => {
    const stored = storedManifest.files[index];
    return stored.path === file.path && stored.size === file.size && stored.sha256 === file.sha256;
  });
}
