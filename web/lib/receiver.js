// 下载者侧：只接收"自己点过下载"的流，落盘、校验，然后等用户显式保存。
//
// 关键约束（需求"不无操作直接下载"）：
//   * 没有 expect() 过的 shareId/streamId，manifest 会被忽略；
//   * 没见过的 streamId 的二进制帧会被直接丢弃；
//   * 校验通过后只是把状态标成 complete，绝不自动触发下载。

import { decodeDataFrame } from './framing.js';
import { chunkRange } from './plan.js';
import {
  FILE_STATUS,
  KIND,
  TRANSFER_STATUS,
  ackMessage,
  errorMessage,
  fileDoneMessage,
  parsePayload,
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
  #expected = new Map(); // shareId -> { streamId, peerId }
  #byStream = new Map(); // streamId -> state
  #transfers = new Map(); // shareId -> state
  #ackedBytes = new Map();
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

  /** 只有在用户点了"下载"之后才登记期待，服务器/对端推来的其他流一律不收。 */
  expect({ shareId, streamId, peerId }) {
    this.#expected.set(shareId, { streamId, peerId });
  }

  forget(shareId) {
    this.#expected.delete(shareId);
  }

  get expectedShareIds() {
    return [...this.#expected.keys()];
  }

  async listTransfers() {
    return this.#store.listTransfers();
  }

  /** 返回异步迭代器（不要包成 Promise，否则 for await 无法迭代）。 */
  readChunks(shareId, fileIndex) {
    return this.#store.readChunks(shareId, fileIndex);
  }

  async deleteTransfer(shareId) {
    const state = this.#transfers.get(shareId);
    if (state) {
      this.#byStream.delete(state.streamId);
      this.#transfers.delete(shareId);
    }
    await this.#store.deleteTransfer(shareId);
  }

  markClosed() {
    this.#closed = true;
    this.#emit({ type: 'channel-closed' });
  }

  /** 外部定时器可周期调用，保证长时间没有新块时进度不卡住。 */
  async flushAcks() {
    for (const state of this.#transfers.values()) {
      for (const file of state.files) {
        if (file.received > 0) {
          const key = `${state.shareId}/${file.i}`;
          if ((this.#ackedBytes.get(key) ?? 0) >= file.received) {
            continue;
          }
        }
        await this.#sendAck(state, file, true);
      }
    }
  }

  async drain() {
    await this.#queue;
  }

  /** 处理对端发来的负载消息（由服务层投递）。 */
  handlePayload(raw) {
    return this.#enqueue(async () => {
      let message;
      try {
        message = parsePayload(raw);
      } catch (error) {
        this.#emit({ type: 'protocol-error', error });
        return;
      }
      switch (message.k) {
        case KIND.MANIFEST:
          await this.#handleManifest(message);
          return;
        case KIND.CANCEL:
          this.#emit({ type: 'cancelled', shareId: message.shareId, reason: message.reason });
          return;
        case KIND.ERROR:
          this.#emit({ type: 'remote-error', code: message.code, message: message.message });
          return;
        default:
          // 下载者不需要 ack/file-done/transfer-done/index 等
          this.#emit({ type: 'ignored', message });
          return;
      }
    });
  }

  /** 处理二进制数据帧（由服务层投递，服务器不解析）。 */
  handleBinary(bytes) {
    return this.#enqueue(async () => {
      let frame;
      try {
        frame = decodeDataFrame(bytes);
      } catch (error) {
        this.#emit({ type: 'protocol-error', error });
        return;
      }
      const state = this.#byStream.get(frame.streamId);
      if (!state) {
        // 没有请求过的流：直接丢弃（不无操作直接下载）
        this.#emit({ type: 'unexpected-frame', streamId: frame.streamId });
        return;
      }
      await this.#handleFrame(state, frame);
    });
  }

  #enqueue(task) {
    this.#queue = this.#queue.then(task).catch((error) => {
      this.#emit({ type: 'error', error });
    });
    return this.#queue;
  }

  async #handleManifest(manifest) {
    const expected = this.#expected.get(manifest.shareId);
    if (!expected || expected.streamId !== manifest.streamId) {
      this.#emit({ type: 'unexpected-manifest', shareId: manifest.shareId });
      return;
    }

    const existing = await this.#loadState(manifest);
    const state = existing ?? {
      shareId: manifest.shareId,
      streamId: manifest.streamId,
      peerId: expected.peerId,
      manifest,
      files: manifest.files.map((file) => ({
        ...file,
        received: 0,
        chunks: 0,
        verified: false,
      })),
    };
    state.manifest = manifest;
    state.streamId = manifest.streamId;
    this.#transfers.set(manifest.shareId, state);
    this.#byStream.set(manifest.streamId, state);

    await this.#store.saveManifest(manifest);
    this.#emit({
      type: 'manifest',
      shareId: manifest.shareId,
      peerId: state.peerId,
      manifest,
      resumedBytes: state.files.reduce((sum, file) => sum + file.received, 0),
    });

    await this.#send(
      resumeStateMessage({
        shareId: manifest.shareId,
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
    const stored = await this.#store.loadTransfer(manifest.shareId);
    if (!stored) {
      return null;
    }
    if (!sameFiles(stored.manifest, manifest)) {
      this.#emit({ type: 'discarded', shareId: manifest.shareId });
      await this.#store.deleteTransfer(manifest.shareId);
      return null;
    }
    return {
      shareId: manifest.shareId,
      streamId: manifest.streamId,
      peerId: this.#expected.get(manifest.shareId)?.peerId ?? null,
      manifest,
      files: manifest.files.map((file) => {
        const storedFile = stored.files.find((candidate) => candidate.i === file.i);
        return {
          ...file,
          received: Math.min(storedFile?.received ?? 0, file.size),
          chunks: storedFile?.chunks ?? 0,
          // 即使看起来已经收满，也要重新校验一次
          verified: false,
        };
      }),
    };
  }

  async #handleFrame(state, frame) {
    const file = state.files[frame.fileIndex];
    if (!file) {
      await this.#send(
        errorMessage({
          shareId: state.shareId,
          code: 'unknown-file',
          message: `文件序号 ${frame.fileIndex} 不在清单中`,
        }),
      );
      return;
    }

    let range;
    try {
      range = chunkRange(file.size, frame.chunkIndex, state.manifest.chunkSize);
    } catch (error) {
      await this.#send(
        errorMessage({ shareId: state.shareId, code: 'bad-chunk', message: error.message }),
      );
      return;
    }
    if (frame.payload.length !== range.length) {
      await this.#send(
        errorMessage({
          shareId: state.shareId,
          code: 'bad-chunk-length',
          message: `块 ${frame.chunkIndex} 长度应为 ${range.length}，实际 ${frame.payload.length}`,
        }),
      );
      return;
    }

    const nextExpected = file.received / state.manifest.chunkSize;
    if (frame.chunkIndex < nextExpected) {
      await this.#sendAck(state, file, true); // 重复块：幂等忽略
      return;
    }
    if (frame.chunkIndex > nextExpected) {
      await this.#send(
        errorMessage({
          shareId: state.shareId,
          code: 'out-of-order',
          message: `期望块 ${nextExpected}，实际收到 ${frame.chunkIndex}`,
        }),
      );
      return;
    }

    await this.#store.putChunk({
      shareId: state.shareId,
      fileIndex: file.i,
      chunkIndex: frame.chunkIndex,
      bytes: frame.payload,
    });
    file.received += range.length;
    file.chunks += 1;

    this.#emit({
      type: 'progress',
      shareId: state.shareId,
      streamId: state.streamId,
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
    const key = `${state.shareId}/${file.i}`;
    const last = this.#ackedBytes.get(key) ?? 0;
    if (!force && file.received - last < this.#ackInterval) {
      return;
    }
    this.#ackedBytes.set(key, file.received);
    await this.#send(
      ackMessage({
        shareId: state.shareId,
        i: file.i,
        received: file.received,
        totalReceived: state.files.reduce((sum, candidate) => sum + candidate.received, 0),
      }),
    );
  }

  /** 落盘数据复算 SHA-256：这是"下载完成后"的那道校验。 */
  async #finishFile(state, file) {
    const hasher = new Sha256();
    for await (const chunk of this.#store.readChunks(state.shareId, file.i)) {
      hasher.update(chunk);
    }
    const actual = hasher.hex();

    if (actual === file.sha256) {
      file.verified = true;
      this.#emit({
        type: 'file-done',
        shareId: state.shareId,
        fileIndex: file.i,
        path: file.path,
        size: file.size,
        sha256: actual,
        status: FILE_STATUS.OK,
      });
      await this.#send(
        fileDoneMessage({
          shareId: state.shareId,
          i: file.i,
          status: FILE_STATUS.OK,
          sha256: actual,
        }),
      );
    } else {
      await this.#store.deleteFile(state.shareId, file.i);
      file.received = 0;
      file.chunks = 0;
      file.verified = false;
      this.#ackedBytes.delete(`${state.shareId}/${file.i}`);
      this.#emit({
        type: 'file-done',
        shareId: state.shareId,
        fileIndex: file.i,
        path: file.path,
        size: file.size,
        sha256: actual,
        status: FILE_STATUS.HASH_MISMATCH,
      });
      await this.#send(
        fileDoneMessage({
          shareId: state.shareId,
          i: file.i,
          status: FILE_STATUS.HASH_MISMATCH,
          sha256: actual,
          message: '接收数据校验失败，已丢弃并要求重传',
        }),
      );
    }

    if (state.files.every((candidate) => candidate.verified)) {
      // 只是标记完成：真正的保存要用户点按钮
      this.#emit({ type: 'complete', shareId: state.shareId, manifest: state.manifest });
      await this.#send(
        transferDoneMessage({ shareId: state.shareId, status: TRANSFER_STATUS.OK }),
      );
    }
  }

  async #send(message) {
    if (this.#closed) {
      return;
    }
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

function sameFiles(storedManifest, manifest) {
  if (!storedManifest || storedManifest.files.length !== manifest.files.length) {
    return false;
  }
  return manifest.files.every((file, index) => {
    const stored = storedManifest.files[index];
    return stored.path === file.path && stored.size === file.size && stored.sha256 === file.sha256;
  });
}
