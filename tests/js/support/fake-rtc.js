// 极简 RTCPeerConnection / RTCDataChannel 替身，用于在 Node 里测试 mesh 逻辑。

export function createFakeRtcNetwork() {
  const peers = new Map(); // "owner->peer" -> FakePeerConnection
  const stats = { connections: 0, offers: 0, answers: 0, dataChannels: 0 };

  class FakeDataChannel {
    constructor(label) {
      this.label = label;
      this.readyState = 'connecting';
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      this.bufferedAmountLowThreshold = 0;
      this.peer = null;
      this.listeners = new Map();
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, new Set());
      }
      this.listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
      this.listeners.get(type)?.delete(handler);
    }

    dispatch(type, event = {}) {
      for (const handler of this.listeners.get(type) ?? []) {
        handler(event);
      }
    }

    open() {
      this.readyState = 'open';
      this.dispatch('open');
    }

    send(data) {
      if (this.readyState !== 'open' || this.peer?.readyState !== 'open') {
        throw new Error('通道未打开');
      }
      const payload =
        typeof data === 'string'
          ? data
          : data instanceof Uint8Array
            ? data.slice().buffer
            : data;
      this.peer.dispatch('message', { data: payload });
    }

    close() {
      if (this.readyState === 'closed') {
        return;
      }
      this.readyState = 'closed';
      this.dispatch('close');
      this.peer?.close();
    }
  }

  class FakePeerConnection {
    constructor(owner, peer) {
      this.owner = owner;
      this.peer = peer;
      this.connectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.candidates = [];
      this.pending = [];
      this.onicecandidate = null;
      this.ondatachannel = null;
      this.onconnectionstatechange = null;
      stats.connections += 1;
    }

    createDataChannel(label, options) {
      void options;
      stats.dataChannels += 1;
      const channel = new FakeDataChannel(label);
      this.pending.push(channel);
      return channel;
    }

    async createOffer() {
      stats.offers += 1;
      return { type: 'offer', sdp: `${this.owner}->${this.peer}`, from: this.owner, to: this.peer };
    }

    async createAnswer() {
      stats.answers += 1;
      return { type: 'answer', sdp: `${this.owner}->${this.peer}`, from: this.owner, to: this.peer };
    }

    async setLocalDescription(description) {
      this.localDescription = description;
      if (description.type === 'answer') {
        completeHandshake(this);
      }
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }

    async addIceCandidate(candidate) {
      this.candidates.push(candidate);
    }

    close() {
      if (this.connectionState === 'closed') {
        return;
      }
      this.connectionState = 'closed';
      for (const channel of this.pending) {
        channel.close();
      }
      this.onconnectionstatechange?.();
    }

    setState(state) {
      this.connectionState = state;
      this.onconnectionstatechange?.();
    }
  }

  function completeHandshake(responder) {
    const initiator = peers.get(`${responder.peer}->${responder.owner}`);
    if (!initiator) {
      return;
    }
    const initiatorChannel = initiator.pending[0];
    const responderChannel = new FakeDataChannel(initiatorChannel?.label ?? 'fs');
    initiatorChannel.peer = responderChannel;
    responderChannel.peer = initiatorChannel;
    responder.pending.push(responderChannel);
    initiator.setState('connected');
    responder.setState('connected');
    responder.ondatachannel?.({ channel: responderChannel });
    initiatorChannel.open();
    responderChannel.open();
  }

  return {
    stats,
    /** mesh 的 createConnection 注入点。 */
    connect(owner, peer) {
      const key = `${owner}->${peer}`;
      const existing = peers.get(key);
      if (existing && existing.connectionState === 'closed') {
        peers.delete(key);
      }
      if (!peers.has(key)) {
        peers.set(key, new FakePeerConnection(owner, peer));
      }
      return peers.get(key);
    },
    get(owner, peer) {
      return peers.get(`${owner}->${peer}`);
    },
    reset() {
      peers.clear();
    },
  };
}
