import test from 'node:test';
import assert from 'node:assert/strict';

import { buildShareEntry, describeEntry, shareName } from '../../web/lib/share-index.js';
import { validateEntry } from '../../web/lib/protocol.js';
import { sha256Hex } from '../../web/lib/sha256.js';
import { createBufferSource, randomBytes } from './support/relay-harness.js';

function fakeFile(name, bytes) {
  return { name, size: bytes.length, type: 'application/octet-stream' };
}

function selection(files) {
  return files.map((file) => ({ file: fakeFile(file.name, file.bytes), path: file.path }));
}

function sourceFactoryFor(files) {
  const byPath = new Map(files.map((file) => [file.path, file.bytes]));
  return (ordered) =>
    createBufferSource(ordered.map((entry) => ({ path: entry.path, bytes: byPath.get(entry.path) })));
}

test('单文件：登记为 single，只记录位置信息', async () => {
  const bytes = randomBytes(1000, 1);
  const files = [{ name: 'report.bin', path: 'report.bin', bytes }];

  const { entry, source, plan } = await buildShareEntry({
    entries: selection(files),
    sourceFactory: sourceFactoryFor(files),
  });

  assert.equal(entry.kind, 'single');
  assert.equal(entry.name, 'report.bin');
  assert.equal(entry.fileCount, 1);
  assert.equal(entry.totalBytes, bytes.length);
  assert.match(entry.shareId, /^[0-9a-f]{32}$/);
  assert.equal(entry.files[0].sha256, sha256Hex(bytes));
  assert.equal(plan.kind, 'single');
  assert.equal(source.fileCount, 1);
  // 登记项必须能通过协议校验（对端会校验）
  assert.doesNotThrow(() => validateEntry(entry));
});

test('多个文件/带目录 → folder，并保留相对路径', async () => {
  const files = [
    { name: 'b.bin', path: '相册/sub/b.bin', bytes: randomBytes(300, 2) },
    { name: 'a.txt', path: '相册/a.txt', bytes: randomBytes(10, 3) },
    { name: '空.txt', path: '相册/空.txt', bytes: new Uint8Array(0) },
  ];

  const { entry } = await buildShareEntry({
    entries: selection(files),
    sourceFactory: sourceFactoryFor(files),
  });

  assert.equal(entry.kind, 'folder');
  assert.equal(entry.name, '相册');
  assert.equal(entry.fileCount, 3);
  assert.deepEqual(
    entry.files.map((file) => file.path),
    ['相册/a.txt', '相册/sub/b.bin', '相册/空.txt'],
    '按路径排序，索引顺序稳定',
  );
  assert.equal(entry.files[2].size, 0);
  assert.equal(entry.files[2].sha256, sha256Hex(''));
});

test('shareId 内容寻址：与选择顺序无关、内容变了就变', async () => {
  const a = { name: 'a.txt', path: 'dir/a.txt', bytes: randomBytes(64, 4) };
  const b = { name: 'b.txt', path: 'dir/b.txt', bytes: randomBytes(32, 5) };

  const first = await buildShareEntry({
    entries: selection([a, b]),
    sourceFactory: sourceFactoryFor([a, b]),
  });
  const reversed = await buildShareEntry({
    entries: selection([b, a]),
    sourceFactory: sourceFactoryFor([a, b]),
  });
  assert.equal(first.entry.shareId, reversed.entry.shareId);

  const changed = await buildShareEntry({
    entries: selection([{ ...a, bytes: randomBytes(64, 9) }, b]),
    sourceFactory: sourceFactoryFor([{ ...a, bytes: randomBytes(64, 9) }, b]),
  });
  assert.notEqual(changed.entry.shareId, first.entry.shareId);
});

test('登记过程会上报预哈希进度（上传前校验）', async () => {
  const files = [{ name: 'big.bin', path: 'big.bin', bytes: randomBytes(3000, 6) }];
  const progress = [];
  await buildShareEntry({
    entries: selection(files),
    sourceFactory: sourceFactoryFor(files),
    chunkSize: 1000,
    onProgress: (event) => progress.push(event),
  });
  assert.equal(progress.length, 3, '3000 字节 / 1000 分块 = 3 次进度');
  assert.equal(progress.at(-1).processedBytes, 3000);
  assert.equal(progress.at(-1).totalBytes, 3000);
});

test('缺少 sourceFactory 会立刻报错（避免误以为登记成功）', async () => {
  await assert.rejects(
    buildShareEntry({ entries: selection([{ name: 'a', path: 'a', bytes: new Uint8Array(1) }]) }),
    TypeError,
  );
});

test('描述与命名工具函数', async () => {
  const files = [
    { name: 'a.txt', path: '相册/a.txt', bytes: new Uint8Array(1) },
    { name: 'b.txt', path: '相册/b.txt', bytes: new Uint8Array(1) },
  ];
  const { entry, plan } = await buildShareEntry({
    entries: selection(files),
    sourceFactory: sourceFactoryFor(files),
  });
  assert.equal(describeEntry(entry), '文件夹 · 2 个文件');
  assert.equal(shareName(plan, []), '相册');

  const loose = await buildShareEntry({
    entries: selection([
      { name: 'a.txt', path: 'a.txt', bytes: new Uint8Array(1) },
      { name: 'b.txt', path: 'b.txt', bytes: new Uint8Array(1) },
    ]),
    sourceFactory: sourceFactoryFor([
      { name: 'a.txt', path: 'a.txt', bytes: new Uint8Array(1) },
      { name: 'b.txt', path: 'b.txt', bytes: new Uint8Array(1) },
    ]),
  });
  assert.equal(loose.entry.kind, 'folder');
  assert.equal(loose.entry.name, 'a.txt 等 2 个文件');
});
