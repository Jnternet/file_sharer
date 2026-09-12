import test from 'node:test';
import assert from 'node:assert/strict';

import { createRelayClient } from '../../web/lib/relay-client.js';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  send(payload) {
    this.sent.push(typeof payload === 'string' ? JSON.parse(payload) : payload);
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  receiveBinary(bytes) {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
}
FakeSocket.instances = [];

function setup({ events = [], timers = [] } = {}) {
  FakeSocket.instances = [];
  const client = createRelayClient({
    url: 'ws://example/ws',
    name: '我的设备',
    socketFactory: (url) => new FakeSocket(url),
    onEvent: (event) => events.push(event),
    setTimeoutFn: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeoutFn: () => {},
  });
  return { client, events, timers };
}

test('连接后 hello 注册，服务器只回自己的会话信息', () => {
  const { client, events } = setup();
  client.connect();
  const socket = FakeSocket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent, [{ t: 'hello', name: '我的设备' }]);

  socket.receive({ t: 'welcome', self: { id: 's1', name: '我的设备' } });
  assert.equal(client.selfId, 's1');
  assert.equal(client.connected, true);
  assert.ok(events.some((event) => event.type === 'welcome'));
});

test('会话列表是拉取：请求-应答配对', async () => {
  const { client } = setup();
  client.connect();
  const socket = FakeSocket.instances[0];
  socket.open();

  const promise = client.listSessions();
  assert.deepEqual(socket.sent.at(-1), { t: 'sessions' });
  socket.receive({ t: 'sessions', sessions: [{ id: 's2', name: '手机' }] });
  assert.deepEqual(await promise, [{ id: 's2', name: '手机' }]);
});

test('定向转发：payload 原样发出，收到的 relay 事件带 from', () => {
  const { client, events } = setup();
  client.connect();
  const socket = FakeSocket.instances[0];
  socket.open();

  assert.equal(client.relay('s2', { k: 'index-request' }), true);
  assert.deepEqual(socket.sent.at(-1), {
    t: 'relay',
    to: 's2',
    payload: { k: 'index-request' },
  });

  socket.receive({ t: 'relay', from: 's2', payload: { k: 'index', entries: [] } });
  const relayed = events.find((event) => event.type === 'relay');
  assert.equal(relayed.from, 's2');
  assert.deepEqual(relayed.payload, { k: 'index', entries: [] });
});

test('bind 后才能发二进制帧，未绑定时抛错', async () => {
  const { client } = setup();
  client.connect();
  const socket = FakeSocket.instances[0];
  socket.open();

  assert.throws(() => client.sendBinary(new Uint8Array([1, 2])), /尚未绑定/);

  const binding = client.bind('s2');
  assert.deepEqual(socket.sent.at(-1), { t: 'bind', to: 's2' });
  socket.receive({ t: 'bound', to: 's2' });
  assert.equal(await binding, 's2');
  assert.equal(client.boundTo, 's2');

  client.sendBinary(new Uint8Array([3, 4]));
  assert.deepEqual(socket.sent.at(-1), new Uint8Array([3, 4]));

  // 二次绑定同一目标不再发请求（缓存）
  const sentBefore = socket.sent.length;
  assert.equal(await client.bind('s2'), 's2');
  assert.equal(socket.sent.length, sentBefore);
});

test('服务端错误会拒绝挂起的请求', async () => {
  const { client } = setup();
  client.connect();
  const socket = FakeSocket.instances[0];
  socket.open();

  const binding = client.bind('s404');
  socket.receive({ t: 'error', code: 'unknown-session', message: 's404 不在线' });
  await assert.rejects(binding, /不在线/);
});

test('二进制响应以 binary 事件派发', () => {
  const { client, events } = setup();
  client.connect();
  const socket = FakeSocket.instances[0];
  socket.open();

  socket.receiveBinary(new Uint8Array([9, 8, 7]));
  const binary = events.find((event) => event.type === 'binary');
  assert.deepEqual([...binary.bytes], [9, 8, 7]);
});

test('断开后自动重连（可注入定时器），主动 close 不再重连', () => {
  const { client, events, timers } = setup();
  client.connect();
  const first = FakeSocket.instances[0];
  first.open();

  first.close();
  assert.ok(events.some((event) => event.type === 'closed'));
  assert.equal(client.connected, false);
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.equal(FakeSocket.instances.length, 2);

  client.close();
  assert.equal(timers.length, 1, '主动关闭不应再安排重连');
});

test('连接未就绪时 relay 返回 false，而不是抛错', () => {
  const { client } = setup();
  assert.equal(client.relay('s2', { k: 'x' }), false);
});
