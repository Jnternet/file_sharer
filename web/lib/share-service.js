// 分享者侧服务：维护"记录区条目"（只登记位置），并在**收到下载请求时**才开始发送。

import { DEFAULT_CHUNK_SIZE } from './plan.js';
import { KIND, errorMessage, indexMessage, parsePayload } from './protocol.js';
import { createRelayChannel } from './relay-channel.js';

export function createShareService({
  relay,
  senderFactory,
  senderName = '分享者',
  chunkSize = DEFAULT_CHUNK_SIZE,
  onEvent = () => {},
}) {
  if (!relay || typeof senderFactory !== 'function') {
    throw new TypeError('createShareService 需要 relay 与 senderFactory');
  }
  const shares = new Map(); // shareId -> { entry, source }
  const active = new Map(); // shareId -> { streamId, peerId, sender }
  // 路由队列只做短任务（解析 + 分发），传输任务排在自己的队列里，
  // 两者分离，否则"长任务等路由、路由等长任务"会互锁。
  let routing = Promise.resolve();
  let streams = Promise.resolve();

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // 回调异常不影响服务
    }
  };

  const list = () => [...shares.values()].map((share) => share.entry);

  function beginTransfer(from, message) {
    const share = shares.get(message.shareId);
    if (!share) {
      relay.relay(
        from,
        errorMessage({ shareId: message.shareId, code: 'unknown-share', message: '该记录已不存在' }),
      );
      emit({ type: 'request-rejected', shareId: message.shareId, reason: 'unknown-share' });
      return;
    }
    if (active.has(message.shareId)) {
      relay.relay(
        from,
        errorMessage({
          shareId: message.shareId,
          code: 'busy',
          message: '该文件正在传输，请稍后再试',
        }),
      );
      emit({ type: 'request-rejected', shareId: message.shareId, reason: 'busy' });
      return;
    }

    const sender = senderFactory({
      source: share.source,
      channel: createRelayChannel({ relay, peerId: from }),
    });
    active.set(message.shareId, { streamId: message.streamId, peerId: from, sender });
    emit({
      type: 'download-started',
      shareId: message.shareId,
      streamId: message.streamId,
      peerId: from,
    });

    // 一次只保留一条外出流（服务器按连接绑定二进制转发目标），因此这里串行排队
    streams = streams
      .then(async () => {
        try {
          await sender.send({
            shareId: message.shareId,
            streamId: message.streamId,
            kind: share.entry.kind,
            files: share.entry.files,
            senderName,
          });
          emit({ type: 'served', shareId: message.shareId, peerId: from });
        } catch (error) {
          emit({ type: 'serve-failed', shareId: message.shareId, peerId: from, error });
        } finally {
          active.delete(message.shareId);
        }
      })
      .catch((error) => emit({ type: 'error', error }));
  }

  return {
    /** 登记一个条目（只保存"位置"与数据源引用，不发送任何字节）。 */
    add(entry, source) {
      shares.set(entry.shareId, { entry, source });
      emit({ type: 'added', entry });
      return entry.shareId;
    },

    remove(shareId) {
      const share = shares.get(shareId);
      if (!share) {
        return false;
      }
      active.get(shareId)?.sender.abort(new Error('分享者已取消该记录'));
      shares.delete(shareId);
      emit({ type: 'removed', shareId });
      return true;
    },

    list,
    has: (shareId) => shares.has(shareId),
    get size() {
      return shares.size;
    },
    get activeShareIds() {
      return [...active.keys()];
    },

    /** 处理来自某个会话的负载。 */
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
          if (message.k === KIND.INDEX_REQUEST) {
            relay.relay(from, indexMessage({ entries: list() }));
            emit({ type: 'index-sent', to: from, count: shares.size });
            return;
          }
          if (message.k === KIND.DOWNLOAD_REQUEST) {
            beginTransfer(from, message);
            return;
          }
          // 传输过程中的反馈（resume-state / ack / file-done / ...）
          const task = message.shareId ? active.get(message.shareId) : undefined;
          if (task && task.peerId === from) {
            // 不 await：Sender 内部自带队列，这里只负责投递
            void task.sender.handlePayload(message);
            return;
          }
          emit({ type: 'ignored', from, message });
        })
        .catch((error) => emit({ type: 'error', error }));
      return routing;
    },

    abortAll() {
      for (const task of active.values()) {
        task.sender.abort(new Error('分享已停止'));
      }
      active.clear();
    },

    async drain() {
      await routing;
      await streams;
    },
  };
}
