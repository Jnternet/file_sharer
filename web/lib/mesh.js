// WebRTC 直连网格：在线名单里每个 peer 建立一条 DataChannel。
//
// 双向同时发起会产生 glare，因此用 ID 大小做确定性的"主叫方"选举：
// 只有 selfId < peerId 的一侧发起 offer，另一侧等 offer。

import { adaptDataChannel } from './channel.js';

export const CHANNEL_LABEL = 'file-sharer';
export const DEFAULT_ICE_SERVERS = [];

export function shouldInitiate(selfId, peerId) {
  return String(selfId) < String(peerId);
}

export function createPeerMesh({
  selfId,
  iceServers = DEFAULT_ICE_SERVERS,
  signaling,
  createConnection,
  onEvent = () => {},
  onChannel = () => {},
  retryDelayMs = 2000,
  maxRetries = 3,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!selfId || !signaling || typeof createConnection !== 'function') {
    throw new TypeError('createPeerMesh 需要 selfId / signaling / createConnection');
  }
  const links = new Map();
  const knownPeers = new Set();
  const retries = new Map();
  let closed = false;

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // 回调异常不影响连接
    }
  };

  function createLink(peerId) {
    const pc = createConnection(peerId, { iceServers });
    const link = { peerId, pc, wrapper: null, adopted: false, connected: false, retries: 0, timer: null };
    links.set(peerId, link);

    pc.onicecandidate = (event) => {
      if (event?.candidate) {
        signaling.signal(peerId, { candidate: event.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      emit({ type: 'state', peerId, state });
      if (state === 'failed' || state === 'disconnected') {
        scheduleRetry(link);
      }
    };
    pc.ondatachannel = (event) => adopt(link, event.channel);
    return link;
  }

  function linkFor(peerId) {
    return links.get(peerId) ?? createLink(peerId);
  }

  function adopt(link, channel) {
    if (link.adopted) {
      // 双方同时开了通道：保留先到的那条
      channel.close?.();
      return;
    }
    link.adopted = true;
    link.wrapper = adaptDataChannel(channel, {
      onOpen: () => {
        link.connected = true;
        retries.delete(link.peerId);
        emit({ type: 'open', peerId: link.peerId });
        onChannel({ peerId: link.peerId, channel: link.wrapper });
      },
      onClose: () => {
        link.connected = false;
        emit({ type: 'channel-closed', peerId: link.peerId });
        if (knownPeers.has(link.peerId)) {
          scheduleRetry(link);
        }
      },
    });
  }

  function scheduleRetry(link) {
    if (closed || link.timer || !knownPeers.has(link.peerId)) {
      return;
    }
    if (!shouldInitiate(selfId, link.peerId)) {
      // 被动方不做定时重连：立刻清掉这条死链路，等主叫方重新发起 offer。
      // （若保留旧链路，新的 offer 会落到已关闭的连接上，永远建不起来）
      teardown(link.peerId);
      return;
    }
    const attempts = retries.get(link.peerId) ?? 0;
    if (attempts >= maxRetries) {
      emit({ type: 'gave-up', peerId: link.peerId });
      return;
    }
    retries.set(link.peerId, attempts + 1);
    link.timer = setTimeoutFn(() => {
      link.timer = null;
      teardown(link.peerId);
      if (knownPeers.has(link.peerId) && shouldInitiate(selfId, link.peerId)) {
        void initiate(linkFor(link.peerId));
      }
    }, retryDelayMs);
    emit({ type: 'retry', peerId: link.peerId, attempt: attempts + 1 });
  }

  function teardown(peerId) {
    const link = links.get(peerId);
    if (!link) {
      return;
    }
    links.delete(peerId);
    if (link.timer) {
      clearTimeoutFn(link.timer);
    }
    try {
      link.wrapper?.close();
      link.pc.close();
    } catch {
      // 忽略关闭时的异常
    }
    emit({ type: 'closed', peerId });
  }

  async function initiate(link) {
    if (closed || link.adopted) {
      return;
    }
    adopt(link, link.pc.createDataChannel(CHANNEL_LABEL, { ordered: true }));
    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    signaling.signal(link.peerId, { sdp: link.pc.localDescription ?? offer });
  }

  async function handleSignal(from, data) {
    if (closed || !from || !data) {
      return;
    }
    if (data.sdp) {
      const existing = links.get(from);
      if (existing && !existing.connected) {
        // 旧链路已经死掉：先拆掉，保证新 offer 落在新连接上
        teardown(from);
      }
      const link = linkFor(from);
      if (data.sdp.type === 'offer') {
        await link.pc.setRemoteDescription(data.sdp);
        const answer = await link.pc.createAnswer();
        await link.pc.setLocalDescription(answer);
        signaling.signal(from, { sdp: link.pc.localDescription ?? answer });
      } else {
        await link.pc.setRemoteDescription(data.sdp);
      }
      return;
    }
    if (data.candidate) {
      const link = links.get(from);
      if (link) {
        try {
          await link.pc.addIceCandidate(data.candidate);
        } catch (error) {
          emit({ type: 'candidate-error', peerId: from, error });
        }
      }
    }
  }

  return {
    /** 根据最新在线名单增删连接。 */
    setPeers(peers = []) {
      if (closed) {
        return;
      }
      const ids = new Set(peers.map((peer) => peer.id));
      knownPeers.clear();
      for (const id of ids) {
        knownPeers.add(id);
      }
      for (const id of [...links.keys()]) {
        if (!ids.has(id)) {
          teardown(id);
          retries.delete(id);
        }
      }
      for (const peer of peers) {
        if (links.has(peer.id)) {
          continue;
        }
        if (shouldInitiate(selfId, peer.id)) {
          void initiate(linkFor(peer.id));
        }
      }
    },
    handleSignal,
    isConnected(peerId) {
      return links.get(peerId)?.connected ?? false;
    },
    get connectedPeers() {
      return [...links.values()].filter((link) => link.connected).map((link) => link.peerId);
    },
    get peerIds() {
      return [...links.keys()];
    },
    close() {
      closed = true;
      for (const id of [...links.keys()]) {
        teardown(id);
      }
    },
  };
}
