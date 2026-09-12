// Node 侧的测试替身：内存数据通道、内存文件源、慢速存储、数据收集工具。
//
// 这些替身让"发送核心 ↔ 接收核心"的完整协议可以在没有浏览器的情况下回环测试。

import { sha256Hex } from '../../../web/lib/sha256.js';

/**
 * 一对内存数据通道。
 * @param {{dropAfterBytes?:number, tamperFirstBinary?:number, latencyMs?:number}} options
 */
export function createChannelPair({ dropAfterBytes = Infinity, tamperFirstBinary = 0, latencyMs = 0 } = {}) {
  const handlers = {
    a: { message: [], close: [] },
    b: { message: [], close: [] },
  };
  const stats = {
    bytesAToB: 0,
    bytesBToA: 0,
    binaryFramesAToB: 0,
    acked: 0,
    maxInflight: 0,
    dropped: false,
  };
  let dropped = false;
  let tampered = 0;

  const wait = () =>
    latencyMs > 0 ? new Promise((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve();

  const fire = (side, kind, payload) => {
    for (const handler of handlers[side][kind]) {
      handler(payload);
    }
  };

  const deliver = async (side, message) => {
    await wait();
    if (dropped) {
      return;
    }
    if (message.binary) {
      const bytes = message.binary;
      if (side === 'a') {
        stats.bytesAToB += bytes.length;
        stats.binaryFramesAToB += 1;
        stats.maxInflight = Math.max(stats.maxInflight, stats.bytesAToB - stats.acked);
      } else {
        stats.bytesBToA += bytes.length;
      }
    } else if (side === 'b') {
      // 接收端 → 发送端的控制消息：用于统计"已确认进度"以观察流控
      try {
        const parsed = JSON.parse(message.text);
        if (parsed.t === 'ack') {
          stats.acked = parsed.received;
          stats.maxInflight = Math.max(stats.maxInflight, stats.bytesAToB - stats.acked);
        }
      } catch {
        // 非 JSON 消息不影响测试
      }
    }
    fire(side === 'a' ? 'b' : 'a', 'message', message);
  };

  const makeSide = (self, peer) => ({
    onMessage(handler) {
      handlers[self].message.push(handler);
    },
    onClose(handler) {
      handlers[self].close.push(handler);
    },
    async sendText(text) {
      if (dropped) {
        throw new Error('数据通道已断开');
      }
      await deliver(self, { text });
    },
    async sendBinary(bytes) {
      if (dropped) {
        throw new Error('数据通道已断开');
      }
      let payload = bytes;
      if (self === 'a' && tampered < tamperFirstBinary) {
        tampered += 1;
        payload = bytes.slice();
        payload[payload.length - 1] ^= 0xff; // 篡改最后一个字节
      }
      await deliver(self, { binary: payload });
      if (self === 'a' && stats.bytesAToB >= dropAfterBytes) {
        drop();
      }
      void peer;
    },
    close() {
      drop();
    },
    get stats() {
      return stats;
    },
  });

  const sideA = makeSide('a', 'b');
  const sideB = makeSide('b', 'a');

  function drop() {
    if (dropped) {
      return;
    }
    dropped = true;
    stats.dropped = true;
    fire('a', 'close', {});
    fire('b', 'close', {});
  }

  return { a: sideA, b: sideB, drop, stats };
}

/** 内存文件源：read() 返回共享底层 buffer 的视图（便于测试"传输中被修改"）。 */
export function createBufferSource(files) {
  const prepared = files.map((file) => ({
    path: file.path,
    mime: file.mime ?? 'application/octet-stream',
    bytes: file.bytes,
  }));
  return {
    fileCount: prepared.length,
    totalBytes: prepared.reduce((sum, file) => sum + file.bytes.length, 0),
    file(i) {
      const entry = prepared[i];
      return { path: entry.path, size: entry.bytes.length, mime: entry.mime };
    },
    async read(i, offset, length) {
      return prepared[i].bytes.subarray(offset, offset + length);
    },
    /** 测试用：直接改动底层数据，模拟传输过程中源文件被修改。 */
    mutate(i, offset, value) {
      prepared[i].bytes[offset] = value;
    },
    sha256(i) {
      return sha256Hex(prepared[i].bytes);
    },
    bytes(i) {
      return prepared[i].bytes;
    },
  };
}

/** 目标哈希（不读数据，只按内容生成） */
export function hashOf(bytes) {
  return sha256Hex(bytes);
}

export function randomBytes(length, seed = 7) {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

/** 在 store 上包一层延迟，用来观察流控与并发行为。 */
export function withLatency(store, { putChunkMs = 0 } = {}) {
  return {
    ...store,
    async putChunk(args) {
      if (putChunkMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, putChunkMs));
      }
      return store.putChunk(args);
    },
  };
}

/** 把落盘的块按顺序拼回一个 Uint8Array。 */
export async function collectStored(store, transferId, fileIndex) {
  const parts = [];
  let total = 0;
  for await (const chunk of store.readChunks(transferId, fileIndex)) {
    parts.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 等所有微任务/定时器回调跑完。 */
export async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
