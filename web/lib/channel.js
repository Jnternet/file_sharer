// 把 RTCDataChannel 适配成传输核心需要的 Channel 接口，并做数据通道级背压。

export const HIGH_WATER = 8 * 1024 * 1024;
export const LOW_WATER = 1024 * 1024;

export function adaptDataChannel(channel, { onOpen, onClose, onError } = {}) {
  channel.binaryType = 'arraybuffer';
  if (onOpen) {
    channel.addEventListener('open', () => onOpen());
  }
  if (onClose) {
    channel.addEventListener('close', () => onClose());
  }
  if (onError) {
    channel.addEventListener('error', (event) => onError(event));
  }
  return {
    sendText(text) {
      if (channel.readyState !== 'open') {
        throw new Error(`数据通道未打开（${channel.readyState}）`);
      }
      channel.send(text);
    },
    async sendBinary(bytes) {
      await waitForDrain(channel);
      if (channel.readyState !== 'open') {
        throw new Error(`数据通道未打开（${channel.readyState}）`);
      }
      channel.send(bytes);
    },
    onMessage(handler) {
      channel.addEventListener('message', (event) => {
        const data = event.data;
        if (typeof data === 'string') {
          handler({ text: data });
        } else {
          handler({ binary: new Uint8Array(data) });
        }
      });
    },
    onClose(handler) {
      channel.addEventListener('close', () => handler());
    },
    get readyState() {
      return channel.readyState;
    },
    get bufferedAmount() {
      return channel.bufferedAmount ?? 0;
    },
    close() {
      try {
        channel.close();
      } catch {
        // 已经关闭时忽略
      }
    },
  };
}

/**
 * 数据通道背压：缓冲超过高水位就等 bufferedamountlow。
 * 这是应用层 ACK 流控之外的第二道保险（防止消息在浏览器内部排队）。
 */
export async function waitForDrain(
  channel,
  { highWater = HIGH_WATER, lowWater = LOW_WATER, timeoutMs = 10_000 } = {},
) {
  const buffered = channel.bufferedAmount ?? 0;
  if (buffered <= highWater || typeof channel.addEventListener !== 'function') {
    return;
  }
  if ('bufferedAmountLowThreshold' in channel) {
    channel.bufferedAmountLowThreshold = lowWater;
  }
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    channel.addEventListener('bufferedamountlow', finish);
  });
}
