import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptDataChannel, waitForDrain } from '../../web/lib/channel.js';

function fakeChannel({ readyState = 'open', bufferedAmount = 0 } = {}) {
  return {
    readyState,
    bufferedAmount,
    bufferedAmountLowThreshold: 0,
    binaryType: 'blob',
    sent: [],
    closed: false,
    listeners: new Map(),
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, new Set());
      }
      this.listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      this.listeners.get(type)?.delete(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of this.listeners.get(type) ?? []) {
        handler(event);
      }
    },
    send(data) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
      this.readyState = 'closed';
      this.dispatch('close');
    },
  };
}

test('适配层：字符串与二进制消息分别投递', () => {
  const raw = fakeChannel();
  const channel = adaptDataChannel(raw);
  const received = [];
  channel.onMessage((message) => received.push(message));

  raw.dispatch('message', { data: 'text' });
  raw.dispatch('message', { data: new Uint8Array([9, 8]).buffer });

  assert.deepEqual(received[0], { text: 'text' });
  assert.deepEqual([...received[1].binary], [9, 8]);
  assert.equal(raw.binaryType, 'arraybuffer');
});

test('未打开时发送会报错，打开后正常发送', async () => {
  const raw = fakeChannel({ readyState: 'connecting' });
  const channel = adaptDataChannel(raw);
  assert.throws(() => channel.sendText('x'), /未打开/);
  await assert.rejects(channel.sendBinary(new Uint8Array([1])), /未打开/);

  raw.readyState = 'open';
  channel.sendText('x');
  await channel.sendBinary(new Uint8Array([2]));
  assert.deepEqual(raw.sent.map((item) => (typeof item === 'string' ? item : [...item])), [
    'x',
    [2],
  ]);
});

test('open/close/error 回调被桥接', () => {
  const raw = fakeChannel();
  const events = [];
  adaptDataChannel(raw, {
    onOpen: () => events.push('open'),
    onClose: () => events.push('close'),
    onError: () => events.push('error'),
  });
  raw.dispatch('open');
  raw.dispatch('error');
  raw.dispatch('close');
  assert.deepEqual(events, ['open', 'error', 'close']);
});

test('高水位背压：等待 bufferedamountlow', async () => {
  const raw = fakeChannel({ bufferedAmount: 9 * 1024 * 1024 });
  const promise = waitForDrain(raw, { highWater: 1024, lowWater: 512, timeoutMs: 1000 });

  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, '缓冲过高时必须等待');
  assert.equal(raw.bufferedAmountLowThreshold, 512, '应设置低水位阈值');

  raw.bufferedAmount = 0;
  raw.dispatch('bufferedamountlow');
  await promise;
  assert.equal(settled, true);
});

test('背压超时会兜底放行（不永久卡死）', async () => {
  const raw = fakeChannel({ bufferedAmount: 9 * 1024 * 1024 });
  await waitForDrain(raw, { highWater: 1024, timeoutMs: 5 });
});

test('低缓冲时立即返回，不做无谓等待', async () => {
  const raw = fakeChannel({ bufferedAmount: 10 });
  await waitForDrain(raw, { highWater: 1024 });
});
