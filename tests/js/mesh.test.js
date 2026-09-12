import test from 'node:test';
import assert from 'node:assert/strict';

import { createPeerMesh, shouldInitiate } from '../../web/lib/mesh.js';
import { flush } from './support/harness.js';
import { createFakeRtcNetwork } from './support/fake-rtc.js';

function createRouter() {
  const meshes = new Map();
  return {
    meshes,
    add(id, mesh) {
      meshes.set(id, mesh);
    },
    signalingFor(id) {
      return {
        signal(to, data) {
          void meshes.get(to)?.handleSignal(id, data);
        },
      };
    },
  };
}

async function connectTwo(t, { selfA = 'p1', selfB = 'p2', network = createFakeRtcNetwork() } = {}) {
  const router = createRouter();
  const channels = { [selfA]: [], [selfB]: [] };
  const events = { [selfA]: [], [selfB]: [] };
  const built = {};
  for (const selfId of [selfA, selfB]) {
    built[selfId] = createPeerMesh({
      selfId,
      signaling: router.signalingFor(selfId),
      createConnection: (peerId) => network.connect(selfId, peerId),
      retryDelayMs: 1,
      onEvent: (event) => events[selfId].push(event),
      onChannel: (info) => channels[selfId].push(info),
    });
    router.add(selfId, built[selfId]);
  }
  built[selfA].setPeers([{ id: selfB, name: 'B' }]);
  built[selfB].setPeers([{ id: selfA, name: 'A' }]);
  await flush();
  t.after(() => {
    built[selfA].close();
    built[selfB].close();
  });
  return { router, network, channels, events, meshA: built[selfA], meshB: built[selfB] };
}

test('shouldInitiate：ID 小的一侧主叫（确定性选举）', () => {
  assert.equal(shouldInitiate('p1', 'p2'), true);
  assert.equal(shouldInitiate('p2', 'p1'), false);
  assert.equal(shouldInitiate('p10', 'p9'), true, '字典序比较：p10 < p9');
  assert.equal(shouldInitiate('p9', 'p10'), false);
});

test('双向上线：只建一条数据通道，双向可收发', async (t) => {
  const { channels, network, meshA, meshB } = await connectTwo(t);

  assert.equal(network.stats.dataChannels, 1, '只有小 ID 侧主叫');
  assert.equal(network.stats.connections, 2, '每侧只建一个 PeerConnection（answer 不应触发重建）');
  assert.equal(network.stats.answers, 1);
  assert.equal(channels.p1.length, 1);
  assert.equal(channels.p2.length, 1);
  assert.deepEqual(meshA.connectedPeers, ['p2']);
  assert.deepEqual(meshB.connectedPeers, ['p1']);

  const fromA = [];
  const fromB = [];
  channels.p2[0].channel.onMessage((message) => fromA.push(message));
  channels.p1[0].channel.onMessage((message) => fromB.push(message));

  await channels.p1[0].channel.sendText('你好');
  await channels.p1[0].channel.sendBinary(new Uint8Array([1, 2, 3]));
  await channels.p2[0].channel.sendText('回执');
  await flush();

  assert.deepEqual(fromA[0], { text: '你好' });
  assert.deepEqual([...fromA[1].binary], [1, 2, 3]);
  assert.deepEqual(fromB[0], { text: '回执' });
});

test('对端离开：连接被关闭并从连接表移除', async (t) => {
  const { channels, meshA, meshB } = await connectTwo(t);

  meshB.setPeers([]); // B 看到 A 离开了（名单变化）
  meshA.setPeers([]);
  await flush();

  assert.equal(meshA.connectedPeers.length, 0);
  assert.equal(meshB.connectedPeers.length, 0);
  assert.equal(meshA.peerIds.length, 0);
  assert.equal(channels.p1[0].channel.readyState, 'closed');
});

test('通道意外关闭：按退避重连并重新建立通道', async (t) => {
  const { channels, events, network } = await connectTwo(t);
  const firstChannel = channels.p1[0].channel;

  firstChannel.close(); // 模拟链路中断
  await flush(2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flush();

  assert.ok(
    events.p1.some((event) => event.type === 'retry'),
    '应当触发重连',
  );
  assert.equal(channels.p1.length, 2, '重连后应当再次交付通道');
  assert.equal(network.stats.dataChannels, 2);
});

test('重复的 ondatachannel 只采纳第一条', async (t) => {
  const network = createFakeRtcNetwork();
  const router = createRouter();
  const channels = [];
  const meshA = createPeerMesh({
    selfId: 'p1',
    signaling: router.signalingFor('p1'),
    createConnection: (peerId) => network.connect('p1', peerId),
    onChannel: (info) => channels.push(info),
  });
  const meshB = createPeerMesh({
    selfId: 'p2',
    signaling: router.signalingFor('p2'),
    createConnection: (peerId) => network.connect('p2', peerId),
    onChannel: () => {},
  });
  router.add('p1', meshA);
  router.add('p2', meshB);
  t.after(() => {
    meshA.close();
    meshB.close();
  });
  meshA.setPeers([{ id: 'p2' }]);
  meshB.setPeers([{ id: 'p1' }]);
  await flush();
  assert.equal(channels.length, 1);

  // 对端又送来一条通道：应当被立即关闭，不产生第二条"打开"事件
  const duplicate = network.get('p2', 'p1').createDataChannel('duplicate');
  network.get('p2', 'p1').ondatachannel({ channel: duplicate });
  await flush();
  assert.equal(channels.length, 1, '永远只有一条数据通道');
  assert.equal(duplicate.readyState, 'closed', '重复通道应被关闭');
});
