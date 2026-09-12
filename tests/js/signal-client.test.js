import test from 'node:test';
import assert from 'node:assert/strict';

import { createSignalClient } from '../../web/lib/signal-client.js';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
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
  const client = createSignalClient({
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

test('连接后立即用 hello 注册显示名', () => {
  const { client, events } = setup();
  client.connect();
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'ws://example/ws');

  socket.open();
  assert.deepEqual(socket.sent, [{ t: 'hello', name: '我的设备' }]);
  assert.ok(events.some((event) => event.type === 'open'));
});

test('welcome / peers / signal / error 分别派发事件', () => {
  const { client, events } = setup();
  client.connect();
  const socket = FakeSocket.instances[0];
  socket.open();

  socket.receive({
    t: 'welcome',
    self: { id: 'p1', name: '我的设备' },
    peers: [{ id: 'p2', name: '手机' }],
    ice_servers: ['stun:example.org:3478'],
    max_peers: 64,
  });
  assert.equal(client.selfId, 'p1');
  assert.deepEqual(client.peers, [{ id: 'p2', name: '手机' }]);
  assert.deepEqual(client.iceServers, ['stun:example.org:3478']);
  assert.equal(client.connected, true);
  const welcome = events.find((event) => event.type === 'welcome');
  assert.equal(welcome.maxPeers, 64);

  socket.receive({ t: 'peers', peers: [] });
  assert.deepEqual(client.peers, []);

  socket.receive({ t: 'signal', from: 'p2', data: { sdp: 'v=0' } });
  const signal = events.find((event) => event.type === 'signal');
  assert.equal(signal.from, 'p2');
  assert.equal(signal.data.sdp, 'v=0');

  socket.receive({ t: 'error', code: 'unknown-peer', message: '目标不在线' });
  assert.ok(events.some((event) => event.type === 'error' && event.code === 'unknown-peer'));

  socket.receive({ t: '未来消息' });
  assert.ok(events.some((event) => event.type === 'unknown'));

  socket.onmessage?.({ data: '不是 JSON' });
  assert.ok(events.some((event) => event.type === 'bad-message'));
});

test('signal / requestPeers 只在连接可用时发送', () => {
  const { client } = setup();
  client.connect();
  const socket = FakeSocket.instances[0];

  assert.equal(client.signal('p2', { sdp: 'x' }), false, '未连接时不应发送');
  socket.open();
  assert.equal(client.signal('p2', { sdp: 'x' }), true);
  assert.equal(client.requestPeers(), true);
  assert.deepEqual(socket.sent.at(-2), { t: 'signal', to: 'p2', data: { sdp: 'x' } });
  assert.deepEqual(socket.sent.at(-1), { t: 'list' });
});

test('连接断开后自动重连（延迟可注入）', () => {
  const { client, events, timers } = setup();
  client.connect();
  const first = FakeSocket.instances[0];
  first.open();

  first.close();
  assert.ok(events.some((event) => event.type === 'closed'));
  assert.equal(client.connected, false);
  assert.equal(timers.length, 1, '应当安排一次重连');
  assert.equal(FakeSocket.instances.length, 1);

  timers[0].fn();
  assert.equal(FakeSocket.instances.length, 2, '重连应当新建连接');
  assert.equal(FakeSocket.instances[1].url, 'ws://example/ws');
});

test('close() 之后不再重连', () => {
  const { client, timers } = setup();
  client.connect();
  const socket = FakeSocket.instances[0];
  socket.open();

  client.close();
  assert.equal(socket.closed, true);
  assert.equal(timers.length, 0, '主动关闭不应安排重连');
  assert.equal(FakeSocket.instances.length, 1);
});
