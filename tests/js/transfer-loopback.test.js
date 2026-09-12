import test from 'node:test';
import assert from 'node:assert/strict';

import { Receiver } from '../../web/lib/receiver.js';
import { Sender, hashSource } from '../../web/lib/sender.js';
import { createMemoryStore } from '../../web/lib/store-memory.js';
import { buildSelectionPlan, transferIdFromHashes } from '../../web/lib/plan.js';
import { encodeDataFrame } from '../../web/lib/framing.js';
import {
  MESSAGE,
  errorMessage,
  manifestMessage,
  resumeStateMessage,
} from '../../web/lib/protocol.js';
import {
  collectStored,
  createBufferSource,
  createChannelPair,
  flush,
  hashOf,
  randomBytes,
  withLatency,
} from './support/harness.js';

const CHUNK = 64; // 测试用小分块，1 MiB 的协议行为完全一致

function planFor(files) {
  return buildSelectionPlan(
    files.map((file) => ({
      name: file.path.split('/').pop(),
      size: file.bytes.length,
      webkitRelativePath: file.path,
    })),
  );
}

async function setup({
  files,
  store = createMemoryStore(),
  chunkSize = CHUNK,
  windowBytes = CHUNK * 4,
  pairOptions = {},
  senderOptions = {},
  receiverOptions = {},
} = {}) {
  const source = createBufferSource(files);
  const pair = createChannelPair(pairOptions);
  const plan = planFor(files);
  const hashed = await hashSource(source, { chunkSize });
  const events = { sender: [], receiver: [] };
  const sender = new Sender({
    source,
    channel: pair.a,
    chunkSize,
    windowBytes,
    resumeTimeoutMs: 1000,
    verifyTimeoutMs: 2000,
    onEvent: (event) => events.sender.push(event),
    ...senderOptions,
  }).attach();
  const receiver = new Receiver({
    store,
    channel: pair.b,
    ackIntervalBytes: chunkSize * 2,
    onEvent: (event) => events.receiver.push(event),
    ...receiverOptions,
  }).attach();
  return {
    source,
    pair,
    plan,
    hashed,
    sender,
    receiver,
    store,
    events,
    send: () => sender.send({ kind: plan.kind, files: hashed, senderName: '测试机' }),
    transferId: transferIdFromHashes(hashed),
  };
}

test('单文件端到端：数据一致、双侧事件完整', async () => {
  const bytes = randomBytes(CHUNK * 3 + 17, 1);
  const ctx = await setup({ files: [{ path: 'note.txt', bytes }] });

  const result = await ctx.send();

  assert.equal(result.transferId, ctx.transferId);
  assert.equal(result.manifest.kind, 'single');
  assert.deepEqual([...(await collectStored(ctx.store, result.transferId, 0))], [...bytes]);

  const manifestEvent = ctx.events.receiver.find((event) => event.type === 'manifest');
  assert.equal(manifestEvent.manifest.files[0].sha256, hashOf(bytes));
  assert.equal(manifestEvent.resumedBytes, 0);

  const fileEvents = ctx.events.receiver.filter((event) => event.type === 'file-done');
  assert.equal(fileEvents.length, 1);
  assert.equal(fileEvents[0].status, 'ok');
  assert.equal(fileEvents[0].sha256, hashOf(bytes));
  assert.ok(ctx.events.receiver.some((event) => event.type === 'complete'));

  assert.ok(ctx.events.sender.some((event) => event.type === 'manifest'));
  assert.ok(ctx.events.sender.some((event) => event.type === 'file-sent'));
  assert.ok(ctx.events.sender.some((event) => event.type === 'complete'));
  assert.equal(ctx.sender.aborted, null);
});

test('文件夹端到端：多文件 + 0 字节文件 + 子目录', async () => {
  const files = [
    { path: '相册/a.bin', bytes: randomBytes(CHUNK + 5, 2) },
    { path: '相册/sub/b.bin', bytes: randomBytes(CHUNK * 2, 3) },
    { path: '相册/空文件.txt', bytes: new Uint8Array(0) },
  ];
  const ctx = await setup({ files });
  assert.equal(ctx.plan.kind, 'folder');
  assert.equal(ctx.plan.fileCount, 3);

  await ctx.send();

  for (let i = 0; i < files.length; i++) {
    assert.deepEqual(
      [...(await collectStored(ctx.store, ctx.transferId, i))],
      [...files[i].bytes],
      `${files[i].path} 内容应一致`,
    );
  }
  const statuses = ctx.events.receiver
    .filter((event) => event.type === 'file-done')
    .map((event) => event.status);
  assert.deepEqual(statuses, ['ok', 'ok', 'ok']);
  assert.ok(ctx.events.receiver.some((event) => event.type === 'complete'));
});

test('断线续传：重连后只补传剩余块', async () => {
  const bytes = randomBytes(CHUNK * 8, 4);
  const files = [{ path: 'big.bin', bytes }];
  const store = createMemoryStore();
  const first = await setup({ files, store, pairOptions: { dropAfterBytes: CHUNK * 3 } });

  await assert.rejects(first.send(), /断开|关闭/);
  await first.receiver.drain();
  const partial = await collectStored(store, first.transferId, 0);
  assert.equal(partial.length, CHUNK * 3, '断开前应恰好落盘 3 块');

  // 重连：新通道、新的发送/接收实例，但复用同一个存储
  const second = await setup({ files, store });
  await second.send();

  assert.equal(second.transferId, first.transferId, '内容寻址：重连后传输 ID 不变');
  const finished = await collectStored(store, second.transferId, 0);
  assert.deepEqual([...finished], [...bytes], '续传后内容必须完整一致');
  assert.equal(second.pair.stats.binaryFramesAToB, 5, '只需要补传剩余 5 块');
  assert.ok(
    second.events.sender.some((event) => event.type === 'resumed' && event.resumedBytes === CHUNK * 3),
    '发送方应知道从 3 块处继续',
  );
});

test('篡改数据被检出，发送方自动重传后校验通过', async () => {
  const bytes = randomBytes(CHUNK * 2, 5);
  const ctx = await setup({
    files: [{ path: 'tampered.bin', bytes }],
    pairOptions: { tamperFirstBinary: 1 },
  });

  await ctx.send();

  const statuses = ctx.events.receiver
    .filter((event) => event.type === 'file-done')
    .map((event) => event.status);
  assert.deepEqual(statuses, ['hash-mismatch', 'ok'], '第一次应检出篡改，重传后通过');
  assert.ok(ctx.events.sender.some((event) => event.type === 'retry'));
  assert.deepEqual([...(await collectStored(ctx.store, ctx.transferId, 0))], [...bytes]);
});

test('重复块幂等：不会重复计数，也不会破坏数据', async () => {
  const bytes = randomBytes(CHUNK, 6);
  const store = createMemoryStore();
  const pair = createChannelPair();
  const receiver = new Receiver({
    store,
    channel: pair.b,
    ackIntervalBytes: CHUNK,
    onEvent: () => {},
  }).attach();
  const source = createBufferSource([{ path: 'x.bin', bytes }]);
  const [hashed] = await hashSource(source, { chunkSize: CHUNK });
  const transferId = transferIdFromHashes([hashed]);

  const manifest = manifestMessage({
    transferId,
    kind: 'single',
    senderName: '对端',
    chunkSize: CHUNK,
    files: [hashed],
  });
  await pair.a.sendText(JSON.stringify(manifest));
  const frame = encodeDataFrame(0, 0, bytes);
  await pair.a.sendBinary(frame);
  await pair.a.sendBinary(frame);
  await receiver.drain();

  assert.equal((await collectStored(store, transferId, 0)).length, CHUNK);
  const stored = await store.loadTransfer(transferId);
  assert.equal(stored.files[0].received, CHUNK);
  assert.equal(stored.files[0].chunks, 1);
});

test('源文件在传输中被修改：发送方中止并报错', async () => {
  const bytes = randomBytes(CHUNK * 2, 7);
  const ctx = await setup({ files: [{ path: 'changing.bin', bytes }] });

  const originalRead = ctx.source.read;
  let mutated = false;
  ctx.source.read = async (i, offset, length) => {
    const data = await originalRead(i, offset, length);
    if (!mutated) {
      mutated = true;
      ctx.source.mutate(i, ctx.source.bytes(i).length - 1, 0x5a); // 改动后面某一块
    }
    return data;
  };

  await assert.rejects(ctx.send(), /被修改/);
  assert.equal(ctx.sender.aborted?.code, 'source-changed');
});

test('流控：未确认字节不超过窗口 + 一块', async () => {
  const bytes = randomBytes(CHUNK * 10, 8);
  const store = withLatency(createMemoryStore(), { putChunkMs: 1 });
  const ctx = await setup({
    files: [{ path: 'flow.bin', bytes }],
    store,
    windowBytes: CHUNK * 2,
    pairOptions: { latencyMs: 1 },
    receiverOptions: { ackIntervalBytes: CHUNK },
  });

  await ctx.send();

  assert.deepEqual([...(await collectStored(ctx.store, ctx.transferId, 0))], [...bytes]);
  const total = bytes.length;
  const progress = ctx.events.sender.filter((event) => event.type === 'progress');
  assert.equal(progress.length, total / CHUNK);
  for (const event of progress) {
    assert.ok(
      event.inflight <= CHUNK * 2,
      `发送端在途字节必须被窗口约束，实际 ${event.inflight}`,
    );
  }
  assert.ok(
    ctx.pair.stats.maxInflight < total,
    `窗口应当真正生效（否则会一次性推完 ${total} 字节）`,
  );
});

test('接收方迟迟不给断点信息：发送方超时报错', async () => {
  const pair = createChannelPair();
  const source = createBufferSource([{ path: 'a.bin', bytes: randomBytes(10, 9) }]);
  const sender = new Sender({
    source,
    channel: pair.a,
    chunkSize: CHUNK,
    resumeTimeoutMs: 30,
    verifyTimeoutMs: 500,
  }).attach();
  const [hashed] = await hashSource(source, { chunkSize: CHUNK });

  await assert.rejects(
    sender.send({ kind: 'single', files: [hashed], senderName: 'A' }),
    /超时/,
  );
});

test('对端不回校验结果：发送方超时报错', async () => {
  const pair = createChannelPair();
  const source = createBufferSource([{ path: 'a.bin', bytes: randomBytes(CHUNK + 1, 10) }]);
  const sender = new Sender({
    source,
    channel: pair.a,
    chunkSize: CHUNK,
    verifyTimeoutMs: 40,
    resumeTimeoutMs: 500,
  }).attach();
  const [hashed] = await hashSource(source, { chunkSize: CHUNK });

  // 只回 resume-state，永远不回 file-done
  pair.b.onMessage((message) => {
    if (message.binary) {
      return;
    }
    const parsed = JSON.parse(message.text);
    if (parsed.t === MESSAGE.MANIFEST) {
      void pair.b.sendText(
        JSON.stringify(
          resumeStateMessage({
            transferId: parsed.transferId,
            files: parsed.files.map((file) => ({ i: file.i, received: 0 })),
          }),
        ),
      );
    }
  });

  await assert.rejects(
    sender.send({ kind: 'single', files: [hashed], senderName: 'A' }),
    /超时/,
  );
});

test('对端报错：发送方中止', async () => {
  const pair = createChannelPair();
  const source = createBufferSource([{ path: 'a.bin', bytes: randomBytes(CHUNK + 1, 11) }]);
  const sender = new Sender({
    source,
    channel: pair.a,
    chunkSize: CHUNK,
    verifyTimeoutMs: 300,
    resumeTimeoutMs: 300,
  }).attach();
  const [hashed] = await hashSource(source, { chunkSize: CHUNK });

  let reported = false;
  pair.b.onMessage((message) => {
    if (message.binary) {
      if (!reported) {
        reported = true;
        void pair.b.sendText(
          JSON.stringify(
            errorMessage({
              transferId: transferIdFromHashes([hashed]),
              code: 'disk-full',
              message: '磁盘写满',
            }),
          ),
        );
      }
      return;
    }
    const parsed = JSON.parse(message.text);
    if (parsed.t === MESSAGE.MANIFEST) {
      void pair.b.sendText(
        JSON.stringify(
          resumeStateMessage({
            transferId: parsed.transferId,
            files: parsed.files.map((file) => ({ i: file.i, received: 0 })),
          }),
        ),
      );
    }
  });

  await assert.rejects(
    sender.send({ kind: 'single', files: [hashed], senderName: 'A' }),
    /磁盘写满/,
  );
  await flush(1);
});
