import test from 'node:test';
import assert from 'node:assert/strict';

import { SendWindow } from '../../web/lib/window.js';

test('窗口记账：add/ack 与可用空间', () => {
  const window = new SendWindow(100);
  assert.equal(window.inflight, 0);
  assert.equal(window.available, 100);

  window.add(60);
  assert.equal(window.inflight, 60);
  assert.equal(window.available, 40);
  assert.equal(window.canSend(40), true);
  assert.equal(window.canSend(41), false);

  window.ack(50);
  assert.equal(window.inflight, 10);
  window.ack(60);
  assert.equal(window.inflight, 0);
});

test('过期的 ack 不会让窗口虚增', () => {
  const window = new SendWindow(100);
  window.add(80);
  window.ack(50);
  window.ack(20);
  assert.equal(window.inflight, 30);
  assert.throws(() => window.ack(-5), RangeError);
});

test('ack 不会把 inflight 拉到负数（接收端超报）', () => {
  const window = new SendWindow(100);
  window.add(10);
  window.ack(999);
  assert.equal(window.inflight, 0);
});

test('waitForRoom 在窗口放不下时阻塞，ack 后放行', async () => {
  const window = new SendWindow(100);
  window.add(100);

  let resolved = false;
  const waiting = window.waitForRoom(100).then(() => {
    resolved = true;
  });

  await Promise.resolve();
  assert.equal(resolved, false, '没有空间时不应立即放行');

  window.ack(50);
  await Promise.resolve();
  assert.equal(resolved, false, '空间仍不足时不应放行');

  window.ack(100);
  await waiting;
  assert.equal(resolved, true);
});

test('waitForRoom 空间充足时立即完成', async () => {
  const window = new SendWindow(10);
  await window.waitForRoom(10);
  await window.waitForRoom(0);
});

test('多个等待者按当前可用空间放行（软闸门，不预留）', async () => {
  const window = new SendWindow(100);
  window.add(100);

  const order = [];
  const first = window.waitForRoom(60).then(() => order.push('first'));
  const second = window.waitForRoom(61).then(() => order.push('second'));

  window.ack(60); // inflight=40，可用 60：只有 first 能被放行
  await first;
  assert.deepEqual(order, ['first']);

  window.ack(100); // inflight=0，可用 100：second 放行
  await second;
  assert.deepEqual(order, ['first', 'second']);
});

test('失败会拒绝所有等待者并阻止后续发送', async () => {
  const window = new SendWindow(10);
  window.add(10);
  const waiting = window.waitForRoom(10);

  const boom = new Error('连接断开');
  window.fail(boom);

  await assert.rejects(waiting, /连接断开/);
  assert.equal(window.canSend(0), false);
  await assert.rejects(window.waitForRoom(1), /连接断开/);
  assert.equal(window.failing, boom);
  window.add(5); // 记账本身不报错
  window.ack(5); // 失败后 ack 是空操作
});

test('参数校验', () => {
  assert.throws(() => new SendWindow(0), RangeError);
  assert.throws(() => new SendWindow(-1), RangeError);
  assert.throws(() => new SendWindow(NaN), RangeError);

  const window = new SendWindow(10);
  assert.throws(() => window.add(-1), RangeError);
  assert.throws(() => window.add(1.5), RangeError);
});
