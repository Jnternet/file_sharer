import test from 'node:test';
import assert from 'node:assert/strict';

import { createRelayChannel } from '../../web/lib/relay-channel.js';

function fakeRelay({ online = true } = {}) {
  return {
    sent: [],
    bound: [],
    binaries: [],
    boundTo: null,
    relay(to, payload) {
      if (!online) {
        return false;
      }
      this.sent.push({ to, payload });
      return true;
    },
    bind(to) {
      if (!online) {
        return Promise.reject(new Error('连接已断开'));
      }
      this.boundTo = to;
      this.bound.push(to);
      return Promise.resolve(to);
    },
    sendBinary(bytes) {
      if (!online) {
        throw new Error('连接已断开');
      }
      this.binaries.push(bytes);
      return true;
    },
  };
}

test('文本负载定向转发，不做任何 JSON 序列化', async () => {
  const relay = fakeRelay();
  const channel = createRelayChannel({ relay, peerId: 's2' });
  const message = { k: 'manifest', shareId: 'a'.repeat(32) };
  await channel.send(message);

  assert.equal(relay.sent.length, 1);
  assert.equal(relay.sent[0].to, 's2');
  assert.equal(relay.sent[0].payload, message, '对象原样传递（服务器不解析）');
});

test('二进制帧先绑定目标再发送', async () => {
  const relay = fakeRelay();
  const channel = createRelayChannel({ relay, peerId: 's2' });
  await channel.sendBinary(new Uint8Array([1, 2, 3]));

  assert.deepEqual(relay.bound, ['s2']);
  assert.equal(relay.binaries.length, 1);
  assert.deepEqual([...relay.binaries[0]], [1, 2, 3]);
});

test('转发连接不可用时抛错（不静默丢消息）', async () => {
  const relay = fakeRelay({ online: false });
  const channel = createRelayChannel({ relay, peerId: 's2' });
  await assert.rejects(channel.send({ k: 'cancel' }), /未就绪/);
  await assert.rejects(channel.sendBinary(new Uint8Array([1])), /连接已断开/);
});

test('构造参数校验', () => {
  assert.throws(() => createRelayChannel({}), TypeError);
  assert.throws(() => createRelayChannel({ relay: fakeRelay() }), TypeError);
});
