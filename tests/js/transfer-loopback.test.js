import test from 'node:test';
import assert from 'node:assert/strict';

import { createDownloadService } from '../../web/lib/download-service.js';
import { encodeDataFrame } from '../../web/lib/framing.js';
import { Sender } from '../../web/lib/sender.js';
import { createShareService } from '../../web/lib/share-service.js';
import { buildShareEntry } from '../../web/lib/share-index.js';
import { createMemoryStore } from '../../web/lib/store-memory.js';
import { KIND, indexRequestMessage, manifestMessage } from '../../web/lib/protocol.js';
import {
  collectStored,
  createRelayNetwork,
  flush,
  randomBytes,
  sourceFactoryFor,
  waitForEvent,
  wireClient,
} from './support/relay-harness.js';

const CHUNK = 64; // 测试用小分块，协议行为与 1 MiB 一致

function fakeFile(path, bytes) {
  return { name: path.split('/').pop(), size: bytes.length, type: 'application/octet-stream' };
}

async function setup({
  files,
  chunkSize = CHUNK,
  windowBytes = CHUNK * 4,
  store = createMemoryStore(),
  ownerOptions = {},
  downloaderOptions = {},
} = {}) {
  const network = createRelayNetwork();
  const owner = network.createClient({ name: '分享者', ...ownerOptions });
  const downloader = network.createClient({ name: '下载者', ...downloaderOptions });
  const third = network.createClient({ name: '旁观者' });
  owner.connect();
  downloader.connect();
  third.connect();

  const events = { owner: [], downloader: [], third: [] };
  const shares = createShareService({
    relay: owner,
    senderName: '分享者',
    onEvent: (event) => events.owner.push(event),
    senderFactory: ({ source, channel }) =>
      new Sender({
        source,
        channel,
        chunkSize,
        windowBytes,
        resumeTimeoutMs: 1000,
        verifyTimeoutMs: 2000,
        onEvent: (event) => events.owner.push(event),
      }),
  });
  const downloads = createDownloadService({
    relay: downloader,
    store,
    ackIntervalBytes: chunkSize,
    onEvent: (event) => events.downloader.push(event),
  });

  wireClient(owner, { shareService: shares });
  wireClient(downloader, { downloadService: downloads });
  wireClient(third, { onEvent: (event) => events.third.push(event) });

  const filesByPath = new Map(files.map((file) => [file.path, file.bytes]));
  const built = await buildShareEntry({
    entries: files.map((file) => ({ file: fakeFile(file.path, file.bytes), path: file.path })),
    sourceFactory: sourceFactoryFor(filesByPath),
    chunkSize,
  });
  shares.add(built.entry, built.source);
  await flush(2);

  return { network, owner, downloader, third, events, shares, downloads, store, ...built };
}

test('登记之后零字节：没有点击下载就不会传输', async () => {
  const ctx = await setup({ files: [{ path: 'note.bin', bytes: randomBytes(CHUNK * 2, 1) }] });

  await flush(10);

  assert.equal(ctx.network.stats.binaryFrames, 0, '没有请求就不应发送任何数据帧');
  assert.equal(ctx.network.stats.bytes, 0);
  assert.equal(ctx.network.stats.payloads, 0, '连控制消息也不应主动发出');
  assert.ok(!ctx.events.owner.some((event) => event.type === 'download-started'));
  assert.ok(!ctx.events.owner.some((event) => event.type === 'served'));
});

test('记录区是拉取来的：索引只含文件位置（名称/大小/哈希）', async () => {
  const bytes = randomBytes(CHUNK + 5, 2);
  const ctx = await setup({ files: [{ path: '相册/a.bin', bytes }] });

  // 索引响应是普通 relay 事件，用一个原始监听器收下来
  const received = [];
  ctx.downloader.onEvent((event) => {
    if (event.type === 'relay') {
      received.push(event.payload);
    }
  });
  ctx.downloader.relay(ctx.owner.selfId, indexRequestMessage());
  await flush(4);

  assert.equal(received.length, 1);
  assert.equal(received[0].k, KIND.INDEX);
  assert.equal(received[0].entries.length, 1);
  const entry = received[0].entries[0];
  assert.equal(entry.shareId, ctx.entry.shareId);
  assert.equal(entry.files[0].sha256, ctx.entry.files[0].sha256);
  assert.equal(entry.totalBytes, bytes.length);
  assert.equal(
    'content' in entry.files[0] || 'bytes' in entry.files[0],
    false,
    '索引里不能有文件内容',
  );
  assert.equal(ctx.network.stats.binaryFrames, 0, '拉取索引不传文件字节');
});

test('点击下载才传输：数据一致、双方事件完整、旁观者收不到任何东西', async () => {
  const bytes = randomBytes(CHUNK * 3 + 17, 3);
  const ctx = await setup({ files: [{ path: 'report.bin', bytes }] });

  const { streamId } = ctx.downloads.request(ctx.owner.selfId, ctx.entry);
  assert.ok(streamId >= 1);
  const complete = await waitForEvent(ctx.events.downloader, 'complete');
  assert.equal(complete.shareId, ctx.entry.shareId);

  const stored = await collectStored(ctx.store, ctx.entry.shareId, 0);
  assert.deepEqual([...stored], [...bytes], '接收到的数据必须与源文件逐字节一致');

  const statuses = ctx.events.downloader
    .filter((event) => event.type === 'file-done')
    .map((event) => event.status);
  assert.deepEqual(statuses, ['ok']);
  assert.ok(ctx.events.owner.some((event) => event.type === 'download-started'));
  assert.ok(ctx.events.owner.some((event) => event.type === 'served'));
  assert.equal(ctx.events.owner.find((event) => event.type === 'served').shareId, ctx.entry.shareId);

  assert.equal(ctx.network.stats.binaryFrames, 4, '4 个分块');
  assert.deepEqual(
    ctx.events.third.filter((event) => event.type !== 'welcome'),
    [],
    '旁观者不应收到任何消息（不广播）',
  );
});

test('没有请求过的流被直接丢弃（不无操作直接下载）', async () => {
  const bytes = randomBytes(CHUNK, 4);
  const ctx = await setup({ files: [{ path: 'x.bin', bytes }] });
  const rogue = ctx.network.createClient({ name: '陌生会话' });
  rogue.connect();
  await flush(1);

  const manifest = manifestMessage({
    shareId: ctx.entry.shareId,
    streamId: 4242,
    kind: 'single',
    senderName: '陌生会话',
    chunkSize: CHUNK,
    files: ctx.entry.files,
  });
  rogue.relay(ctx.downloader.selfId, manifest);
  await rogue.bind(ctx.downloader.selfId);
  rogue.sendBinary(encodeDataFrame(4242, 0, 0, bytes));
  await flush(6);

  assert.ok(
    ctx.events.downloader.some((event) => event.type === 'unexpected-payload'),
    '未请求的 manifest 必须被忽略',
  );
  assert.ok(
    ctx.events.downloader.some((event) => event.type === 'unexpected-frame'),
    '未请求的二进制帧必须被丢弃',
  );
  assert.equal((await collectStored(ctx.store, ctx.entry.shareId, 0)).length, 0, '不得落盘');
});

test('断点续传：中断后重新点击下载，只补传剩余分块', async () => {
  const bytes = randomBytes(CHUNK * 8, 5);
  const files = [{ path: 'big.bin', bytes }];
  const store = createMemoryStore();
  const first = await setup({
    files,
    store,
    ownerOptions: { dropAfterBytes: CHUNK * 3 },
  });

  first.downloads.request(first.owner.selfId, first.entry);
  await waitForEvent(first.events.owner, 'serve-failed');
  await flush(4);
  const partial = await collectStored(store, first.entry.shareId, 0);
  assert.equal(partial.length, CHUNK * 3, '断开前应恰好落盘 3 个分块');

  // 重连：新的会话 id、同一个内容寻址记录
  const second = await setup({ files, store });
  assert.equal(second.entry.shareId, first.entry.shareId, '同一批文件 → 同一个 shareId');
  second.downloads.request(second.owner.selfId, second.entry);
  await waitForEvent(second.events.downloader, 'complete');

  assert.deepEqual(
    [...(await collectStored(store, second.entry.shareId, 0))],
    [...bytes],
    '续传后内容完整',
  );
  assert.equal(second.network.stats.binaryFrames, 5, '只需要补传剩余 5 个分块');
  assert.ok(
    second.events.owner.some(
      (event) => event.type === 'resumed' && event.resumedBytes === CHUNK * 3,
    ),
  );
});

test('篡改数据被检出，分享者自动重传后校验通过', async () => {
  const bytes = randomBytes(CHUNK * 2, 6);
  const ctx = await setup({
    files: [{ path: 'tampered.bin', bytes }],
    ownerOptions: { tamperFirstFrames: 1 },
  });

  ctx.downloads.request(ctx.owner.selfId, ctx.entry);
  await waitForEvent(ctx.events.downloader, 'complete');

  const statuses = ctx.events.downloader
    .filter((event) => event.type === 'file-done')
    .map((event) => event.status);
  assert.deepEqual(statuses, ['hash-mismatch', 'ok'], '先检出篡改，重传后通过');
  assert.ok(ctx.events.owner.some((event) => event.type === 'retry'));
  assert.deepEqual([...(await collectStored(ctx.store, ctx.entry.shareId, 0))], [...bytes]);
});

test('分享者在传输中被修改：立即中止并报错', async () => {
  const bytes = randomBytes(CHUNK * 2, 7);
  const ctx = await setup({ files: [{ path: 'changing.bin', bytes }] });

  // 登记之后、下载之前，文件内容被本地改动
  ctx.source.mutate(0, bytes.length - 1, 0x5a);

  ctx.downloads.request(ctx.owner.selfId, ctx.entry);
  const failed = await waitForEvent(ctx.events.owner, 'serve-failed');
  assert.equal(failed.error.code, 'source-changed');
  assert.ok(!ctx.events.downloader.some((event) => event.type === 'complete'));
});

test('流控：未确认字节被窗口约束', async () => {
  const bytes = randomBytes(CHUNK * 10, 8);
  const ctx = await setup({
    files: [{ path: 'flow.bin', bytes }],
    windowBytes: CHUNK * 2,
  });

  ctx.downloads.request(ctx.owner.selfId, ctx.entry);
  await waitForEvent(ctx.events.downloader, 'complete');

  const progress = ctx.events.owner.filter((event) => event.type === 'progress');
  assert.equal(progress.length, 10);
  for (const event of progress) {
    assert.ok(event.inflight <= CHUNK * 2, `在途字节应被限制，实际 ${event.inflight}`);
  }
});

test('下载不存在的记录：收到明确拒绝，且不产生任何数据', async () => {
  const ctx = await setup({ files: [{ path: 'a.bin', bytes: randomBytes(10, 9) }] });
  const stranger = ctx.network.createClient({ name: '没登记的人' });
  stranger.connect();
  await flush(1);

  const received = [];
  stranger.onEvent((event) => {
    if (event.type === 'relay') {
      received.push(event.payload);
    }
  });
  stranger.relay(ctx.owner.selfId, {
    k: KIND.DOWNLOAD_REQUEST,
    shareId: 'deadbeefdeadbeefdeadbeefdeadbeef',
    streamId: 1,
  });
  await flush(4);

  assert.equal(received.length, 1);
  assert.equal(received[0].k, KIND.ERROR);
  assert.equal(received[0].code, 'unknown-share');
  assert.equal(ctx.network.stats.binaryFrames, 0);
});
