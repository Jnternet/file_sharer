// 内存版"服务器 + 转发客户端"：行为与真实服务器一致（定向转发、按绑定转发二进制、
// 只有请求-应答没有广播），用于在 Node 里做记录区/下载的协议回环测试。

import { sha256Hex } from '../../../web/lib/sha256.js';

export function createRelayNetwork() {
  const sessions = new Map(); // id -> { id, name }
  const clients = new Map(); // id -> client
  const stats = { payloads: 0, binaryFrames: 0, bytes: 0, sessions: 0 };
  let seq = 1;
  let nextStreamSeed = 1;

  function deliver(to, event) {
    const client = clients.get(to);
    if (!client || client.dropped) {
      return false;
    }
    queueMicrotask(() => {
      for (const handler of client.listeners) {
        handler(event);
      }
    });
    return true;
  }

  function createClient({ name = '访客', dropAfterBytes = Infinity, tamperFirstFrames = 0 } = {}) {
    let selfId = null;
    let boundTo = null;
    let dropped = false;
    let sentBytes = 0;
    let framesSent = 0;
    const listeners = [];
    const client = {
      name,
      listeners,
      get dropped() {
        return dropped;
      },
      get selfId() {
        return selfId;
      },
      get boundTo() {
        return boundTo;
      },
      get connected() {
        return Boolean(selfId) && !dropped;
      },
      onEvent(handler) {
        listeners.push(handler);
      },
      connect() {
        if (dropped) {
          throw new Error('连接已断开');
        }
        const id = selfId ?? `s${seq++}`;
        selfId = id;
        sessions.set(id, { id, name });
        clients.set(id, client);
        stats.sessions = sessions.size;
        queueMicrotask(() => {
          for (const handler of listeners) {
            handler({ type: 'welcome', self: { id, name } });
          }
        });
        return id;
      },
      close() {
        if (dropped) {
          return;
        }
        dropped = true;
        if (selfId) {
          sessions.delete(selfId);
          clients.delete(selfId);
          stats.sessions = sessions.size;
        }
        for (const handler of listeners) {
          handler({ type: 'closed' });
        }
      },
      drop() {
        client.close();
      },
      async listSessions() {
        if (dropped) {
          throw new Error('连接已断开');
        }
        return [...sessions.values()]
          .filter((session) => session.id !== selfId)
          .map((session) => ({ ...session }));
      },
      relay(to, payload) {
        if (dropped || !selfId) {
          return false;
        }
        if (!sessions.has(to)) {
          queueMicrotask(() => {
            for (const handler of listeners) {
              handler({ type: 'error', code: 'unknown-session', message: `${to} 不在线` });
            }
          });
          return false;
        }
        stats.payloads += 1;
        return deliver(to, { type: 'relay', from: selfId, payload });
      },
      async bind(to) {
        if (dropped || !selfId) {
          throw new Error('连接已断开');
        }
        if (!sessions.has(to)) {
          throw new Error(`${to} 不在线`);
        }
        boundTo = to;
        return to;
      },
      unbind() {
        boundTo = null;
      },
      sendBinary(bytes) {
        if (dropped) {
          throw new Error('连接已断开');
        }
        if (!boundTo) {
          throw new Error('尚未绑定转发目标');
        }
        if (sentBytes >= dropAfterBytes) {
          client.close();
          throw new Error('连接已断开');
        }
        sentBytes += bytes.length;
        framesSent += 1;
        stats.binaryFrames += 1;
        stats.bytes += bytes.length;
        let payload = bytes.slice();
        if (framesSent <= tamperFirstFrames) {
          payload[payload.length - 1] ^= 0xff; // 篡改最后一个字节
        }
        deliver(boundTo, { type: 'binary', bytes: payload });
        if (sentBytes >= dropAfterBytes) {
          client.close();
        }
        return true;
      },
      nextStreamId() {
        return nextStreamSeed++;
      },
    };
    return client;
  }

  return { stats, createClient };
}

/** 把 relay 客户端的事件接到分享/下载服务上（等价于 app.js 里的接线）。 */
export function wireClient(client, { shareService, downloadService, onEvent = () => {} } = {}) {
  client.onEvent((event) => {
    onEvent(event);
    if (event.type === 'relay') {
      void shareService?.handlePayload(event.from, event.payload);
      void downloadService?.handlePayload(event.from, event.payload);
    } else if (event.type === 'binary') {
      void downloadService?.handleBinary(event.bytes);
    }
  });
}

/** 内存文件源（read 返回共享 buffer 视图，便于测试"传输中被改"）。 */
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
    mutate(i, offset, value) {
      prepared[i].bytes[offset] = value;
    },
    bytes(i) {
      return prepared[i].bytes;
    },
  };
}

/** 记录区条目里的数据源工厂（顺序与 plan.files 一致）。 */
export function sourceFactoryFor(filesByPath) {
  return (ordered) =>
    createBufferSource(
      ordered.map((entry) => ({ path: entry.path, bytes: filesByPath.get(entry.path) })),
    );
}

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

export async function collectStored(store, shareId, fileIndex) {
  const parts = [];
  let total = 0;
  for await (const chunk of store.readChunks(shareId, fileIndex)) {
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

export async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 等到事件列表里出现指定类型的事件（协议是异步的，用它替代固定 sleep）。 */
export async function waitForEvent(events, type, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find((event) => event.type === type);
    if (hit) {
      return hit;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `等待事件 ${type} 超时，已收到：${events.map((event) => event.type).join(', ')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
