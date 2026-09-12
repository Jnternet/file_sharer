// 把"定向转发通道"适配成传输核心需要的 Channel 接口。

export function createRelayChannel({ relay, peerId }) {
  if (!relay || !peerId) {
    throw new TypeError('createRelayChannel 需要 relay 与 peerId');
  }
  return {
    peerId,
    /** 文本负载（对象）——服务器只转发，不解析。 */
    async send(message) {
      if (!relay.relay(peerId, message)) {
        throw new Error('转发连接未就绪，消息未发出');
      }
    },
    /** 二进制数据帧——先确保绑定了目标，再发。 */
    async sendBinary(bytes) {
      await relay.bind(peerId);
      relay.sendBinary(bytes);
    },
  };
}
