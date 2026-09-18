// WebSocket 客户端：只做三件事——建立会话、拉取会话列表、定向转发（文本/二进制）。
//
// 服务器不会主动推送任何东西，因此所有"通知"都是本客户端请求的结果。

const MESSAGE = {
  HELLO: 'hello',
  WELCOME: 'welcome',
  SESSIONS: 'sessions',
  RELAY: 'relay',
  BIND: 'bind',
  UNBIND: 'unbind',
  BOUND: 'bound',
  ERROR: 'error',
};

export function createRelayClient({
  url,
  name,
  socketFactory = (target) => new WebSocket(target),
  reconnectMs = 1500,
  requestTimeoutMs = 8000,
  onEvent = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let socket = null;
  let selfId = null;
  let closed = false;
  let reconnectTimer = null;
  let reconnectDelay = reconnectMs;
  let boundTo = null;
  const waiting = { sessions: [], bind: [] };

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // 回调异常不影响连接
    }
  };

  const send = (payload) => {
    if (!socket || socket.readyState !== 1) {
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  };

  function settle(kind, error, value) {
    const list = waiting[kind];
    waiting[kind] = [];
    for (const waiter of list) {
      clearTimeoutFn(waiter.timer);
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve(value);
      }
    }
  }

  function waitFor(kind) {
    return new Promise((resolve, reject) => {
      const timer = setTimeoutFn(() => {
        waiting[kind] = waiting[kind].filter((waiter) => waiter.timer !== timer);
        reject(new Error(`${kind} 请求超时`));
      }, requestTimeoutMs);
      waiting[kind].push({ resolve, reject, timer });
    });
  }

  function handleText(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      emit({ type: 'bad-message', raw });
      return;
    }
    switch (message.t) {
      case MESSAGE.WELCOME:
        selfId = message.self?.id ?? null;
        reconnectDelay = reconnectMs;
        emit({ type: 'welcome', self: message.self });
        break;
      case MESSAGE.SESSIONS:
        settle('sessions', null, message.sessions ?? []);
        break;
      case MESSAGE.BOUND:
        boundTo = message.to ?? null;
        settle('bind', null, message.to ?? null);
        break;
      case MESSAGE.RELAY:
        emit({ type: 'relay', from: message.from, payload: message.payload });
        break;
      case MESSAGE.ERROR: {
        const error = Object.assign(new Error(message.message ?? message.code), {
          code: message.code,
        });
        if (waiting.bind.length > 0) {
          settle('bind', error);
        } else if (waiting.sessions.length > 0) {
          settle('sessions', error);
        } else {
          emit({ type: 'error', code: message.code, message: message.message });
        }
        break;
      }
      default:
        emit({ type: 'unknown', message });
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) {
      return;
    }
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 1.6, 15_000);
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (closed) {
      return;
    }
    socket = socketFactory(url);
    // 浏览器 WebSocket 默认 binaryType='blob'，不设置的话二进制帧会变成 Blob 被丢掉
    if ('binaryType' in socket) {
      socket.binaryType = 'arraybuffer';
    }
    socket.onopen = () => {
      send({ t: MESSAGE.HELLO, name });
      emit({ type: 'open' });
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        handleText(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        emit({ type: 'binary', bytes: new Uint8Array(event.data) });
      } else if (ArrayBuffer.isView(event.data)) {
        emit({
          type: 'binary',
          bytes: new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength),
        });
      }
    };
    socket.onclose = () => {
      selfId = null;
      boundTo = null;
      settle('sessions', new Error('连接已断开'));
      settle('bind', new Error('连接已断开'));
      emit({ type: 'closed' });
      scheduleReconnect();
    };
    socket.onerror = () => emit({ type: 'socket-error' });
  }

  return {
    connect,
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeoutFn(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
    },
    /** 拉取在线会话（拉取，不是被推送）。 */
    listSessions() {
      const promise = waitFor('sessions');
      if (!send({ t: MESSAGE.SESSIONS })) {
        settle('sessions', new Error('连接尚未就绪'));
      }
      return promise;
    },
    /** 定向转发一段 JSON 负载。 */
    relay(to, payload) {
      return send({ t: MESSAGE.RELAY, to, payload });
    },
    /** 把本连接后续的二进制帧绑定到某个会话。 */
    bind(to) {
      if (boundTo === to) {
        return Promise.resolve(to);
      }
      const promise = waitFor('bind');
      if (!send({ t: MESSAGE.BIND, to })) {
        settle('bind', new Error('连接尚未就绪'));
      }
      return promise;
    },
    unbind() {
      boundTo = null;
      send({ t: MESSAGE.UNBIND });
    },
    /** 发送二进制帧（服务器原样转发给绑定的目标）。 */
    sendBinary(bytes) {
      if (!socket || socket.readyState !== 1) {
        throw new Error('转发连接未就绪');
      }
      if (!boundTo) {
        throw new Error('尚未绑定转发目标');
      }
      socket.send(bytes);
      return true;
    },
    get selfId() {
      return selfId;
    },
    get boundTo() {
      return boundTo;
    },
    get connected() {
      return Boolean(selfId);
    },
  };
}
