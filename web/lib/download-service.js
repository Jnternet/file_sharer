// 下载者侧服务：记录区里点"下载"才会发起；收到的数据先落盘校验，等用户显式保存。

import { decodeDataFrame } from './framing.js';
import { KIND, downloadRequestMessage, parsePayload } from './protocol.js';
import { createRelayChannel } from './relay-channel.js';
import { Receiver } from './receiver.js';

export function createDownloadService({
  relay,
  store,
  receiverFactory = (options) => new Receiver(options),
  onEvent = () => {},
  ackIntervalBytes,
}) {
  if (!relay || !store) {
    throw new TypeError('createDownloadService 需要 relay 与 store');
  }
  const receivers = new Map(); // peerId -> Receiver
  const streamOwners = new Map(); // streamId -> peerId
  const requests = new Map(); // shareId -> { peerId, streamId, entry }
  // 只在这里做"解析 + 分发"：接收核心有自己的队列，长任务不能阻塞路由。
  let routing = Promise.resolve();
  let nextStreamId = 1;

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // 回调异常不影响服务
    }
  };

  function receiverFor(peerId) {
    let receiver = receivers.get(peerId);
    if (!receiver) {
      receiver = receiverFactory({
        store,
        channel: createRelayChannel({ relay, peerId }),
        onEvent: (event) => emit({ ...event, peerId }),
        ackIntervalBytes,
      });
      receivers.set(peerId, receiver);
    }
    return receiver;
  }

  return {
    /**
     * 用户在记录区点了「下载」：这时才告知分享者开始传输。
     * @returns {{streamId:number}}
     */
    request(peerId, entry) {
      const streamId = nextStreamId;
      nextStreamId = nextStreamId >= 0xffffffff ? 1 : nextStreamId + 1;

      const receiver = receiverFor(peerId);
      receiver.expect({ shareId: entry.shareId, streamId, peerId });
      streamOwners.set(streamId, peerId);
      requests.set(entry.shareId, { peerId, streamId, entry });

      const sent = relay.relay(peerId, downloadRequestMessage({ shareId: entry.shareId, streamId }));
      if (!sent) {
        receiver.forget(entry.shareId);
        streamOwners.delete(streamId);
        requests.delete(entry.shareId);
        throw new Error('转发连接未就绪，请稍后重试');
      }
      emit({ type: 'requested', shareId: entry.shareId, peerId, streamId });
      return { streamId };
    },

    handlePayload(from, raw) {
      routing = routing
        .then(() => {
          let message;
          try {
            message = parsePayload(raw);
          } catch (error) {
            emit({ type: 'protocol-error', error, from });
            return;
          }
          if (
            message.k === KIND.MANIFEST ||
            message.k === KIND.CANCEL ||
            message.k === KIND.ERROR
          ) {
            const receiver = receivers.get(from);
            if (!receiver) {
              emit({ type: 'unexpected-payload', from, message });
              return;
            }
            if (message.k === KIND.MANIFEST) {
              streamOwners.set(message.streamId, from);
            }
            void receiver.handlePayload(message);
            return;
          }
          emit({ type: 'ignored', from, message });
        })
        .catch((error) => emit({ type: 'error', error }));
      return routing;
    },

    handleBinary(bytes) {
      let frame;
      try {
        frame = decodeDataFrame(bytes);
      } catch (error) {
        emit({ type: 'protocol-error', error });
        return routing;
      }
      const peerId = streamOwners.get(frame.streamId);
      const receiver = peerId ? receivers.get(peerId) : null;
      if (!receiver) {
        // 没有请求过的流：丢弃，不落盘
        emit({ type: 'unexpected-frame', streamId: frame.streamId });
        return routing;
      }
      void receiver.handleBinary(bytes);
      return routing;
    },

    markPeerClosed(peerId) {
      receivers.get(peerId)?.markClosed();
      emit({ type: 'peer-closed', peerId });
    },

    async flushAcks() {
      for (const receiver of receivers.values()) {
        await receiver.flushAcks();
      }
    },

    readChunks(shareId, fileIndex) {
      const request = requests.get(shareId);
      const receiver = request ? receivers.get(request.peerId) : null;
      if (!receiver) {
        throw new Error(`没有该记录的下载上下文：${shareId}`);
      }
      return receiver.readChunks(shareId, fileIndex);
    },

    async deleteTransfer(shareId) {
      const request = requests.get(shareId);
      requests.delete(shareId);
      const receiver = request ? receivers.get(request.peerId) : null;
      if (receiver) {
        await receiver.deleteTransfer(shareId);
        return;
      }
      await store.deleteTransfer(shareId);
    },

    requestOf(shareId) {
      return requests.get(shareId) ?? null;
    },

    get requestedShareIds() {
      return [...requests.keys()];
    },

    async drain() {
      await routing;
      for (const receiver of receivers.values()) {
        await receiver.drain();
      }
    },
  };
}
