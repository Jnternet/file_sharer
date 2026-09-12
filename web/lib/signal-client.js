// 信令客户端：连接 /ws，维护在线名单，转发 SDP/ICE。

export function createSignalClient({
  url,
  name,
  socketFactory = (target) => new WebSocket(target),
  reconnectMs = 1500,
  onEvent = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let socket = null;
  let closed = false;
  let selfId = null;
  let peers = [];
  let iceServers = [];
  let reconnectTimer = null;
  let reconnectDelay = reconnectMs;

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

  function handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      emit({ type: 'bad-message', raw });
      return;
    }
    switch (message.t) {
      case 'welcome':
        selfId = message.self?.id ?? null;
        peers = message.peers ?? [];
        iceServers = message.ice_servers ?? [];
        reconnectDelay = reconnectMs;
        emit({
          type: 'welcome',
          self: message.self,
          peers,
          iceServers,
          maxPeers: message.max_peers,
        });
        break;
      case 'peers':
        peers = message.peers ?? [];
        emit({ type: 'peers', peers });
        break;
      case 'signal':
        emit({ type: 'signal', from: message.from, data: message.data });
        break;
      case 'error':
        emit({ type: 'error', code: message.code, message: message.message });
        break;
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
    socket.onopen = () => {
      send({ t: 'hello', name });
      emit({ type: 'open' });
    };
    socket.onmessage = (event) => handleMessage(event.data);
    socket.onclose = () => {
      selfId = null;
      peers = [];
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
    signal(to, data) {
      return send({ t: 'signal', to, data });
    },
    requestPeers() {
      return send({ t: 'list' });
    },
    get selfId() {
      return selfId;
    },
    get peers() {
      return peers;
    },
    get iceServers() {
      return iceServers;
    },
    get connected() {
      return Boolean(selfId);
    },
  };
}
