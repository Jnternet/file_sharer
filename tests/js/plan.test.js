import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CHUNK_SIZE,
  MAX_FILES,
  PlanError,
  buildSelectionPlan,
  chunkCount,
  chunkOffset,
  chunkRange,
  nextChunkIndex,
  normalizePath,
  relativePathOf,
  remainingBytes,
  resumeOffsetFromBytes,
  shareIdFromHashes,
} from '../../web/lib/plan.js';

const file = (name, size, extra = {}) => ({ name, size, lastModified: 1700000000000, ...extra });
const hash = (seed) => seed.repeat(64).slice(0, 64);

test('路径归一化', () => {
  assert.equal(normalizePath('a/b.txt'), 'a/b.txt');
  assert.equal(normalizePath('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(normalizePath('././a.txt'), 'a.txt');
  assert.equal(normalizePath('a//b.txt'), 'a/b.txt');
  assert.equal(normalizePath('  目录/文件.txt  '), '目录/文件.txt');
});

test('危险路径被拒绝', () => {
  for (const bad of ['', '   ', '../a.txt', 'a/../../b', '/etc/passwd', '.', '..', 'a/\0b']) {
    assert.throws(() => normalizePath(bad), PlanError, `${bad} 应当被拒绝`);
  }
  assert.throws(() => normalizePath(42), PlanError);
});

test('相对路径优先取 webkitRelativePath', () => {
  assert.equal(relativePathOf(file('a.txt')), 'a.txt');
  assert.equal(
    relativePathOf(file('a.txt', 3, { webkitRelativePath: '照片/2024/a.txt' })),
    '照片/2024/a.txt',
  );
});

test('单个文件 → single，多文件/带目录 → folder（自动区分）', () => {
  const single = buildSelectionPlan([file('报告.pdf', 1024)]);
  assert.equal(single.kind, 'single');
  assert.equal(single.fileCount, 1);
  assert.equal(single.totalBytes, 1024);

  const many = buildSelectionPlan([file('a.txt', 1), file('b.txt', 2)]);
  assert.equal(many.kind, 'folder');
  assert.equal(many.totalBytes, 3);

  const singleInFolder = buildSelectionPlan([
    file('a.txt', 5, { webkitRelativePath: '相册/a.txt' }),
  ]);
  assert.equal(singleInFolder.kind, 'folder', '带目录结构必须按文件夹传输');
  assert.equal(singleInFolder.files[0].path, '相册/a.txt');
});

test('计划按路径排序且保留目录结构', () => {
  const plan = buildSelectionPlan([
    file('b.txt', 1, { webkitRelativePath: 'dir/b.txt' }),
    file('a.txt', 1, { webkitRelativePath: 'dir/a.txt' }),
    file('c.txt', 1, { webkitRelativePath: 'dir/sub/c.txt' }),
  ]);
  assert.deepEqual(
    plan.files.map((f) => f.path),
    ['dir/a.txt', 'dir/b.txt', 'dir/sub/c.txt'],
  );
  assert.equal(plan.files[0].size, 1);
  assert.equal(plan.files[0].lastModified, 1700000000000);
});

test('空选择与非法输入被拒绝', () => {
  assert.throws(() => buildSelectionPlan([]), (e) => e.code === 'empty-selection');
  assert.throws(() => buildSelectionPlan(null), (e) => e.code === 'empty-selection');
  assert.throws(
    () => buildSelectionPlan([file('a.txt', -1)]),
    (e) => e.code === 'bad-size',
  );
  assert.throws(
    () => buildSelectionPlan([file('a.txt', 1.5)]),
    (e) => e.code === 'bad-size',
  );
});

test('重复路径被拒绝', () => {
  assert.throws(
    () => buildSelectionPlan([file('a.txt', 1), file('a.txt', 2)]),
    (e) => e.code === 'duplicate-path',
  );
});

test('文件数量上限', () => {
  const tooMany = Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f${i}.txt`, 1));
  assert.throws(() => buildSelectionPlan(tooMany), (e) => e.code === 'too-many-files');
});

test('空文件（0 字节）也能进入计划', () => {
  const plan = buildSelectionPlan([file('empty.txt', 0)]);
  assert.equal(plan.kind, 'single');
  assert.equal(plan.totalBytes, 0);
  assert.equal(chunkCount(0), 0);
});

test('传输 ID 内容寻址：稳定、与顺序无关、内容变化即变化', () => {
  const a = { path: 'a.txt', size: 3, sha256: hash('a') };
  const b = { path: 'b.txt', size: 5, sha256: hash('b') };

  const id1 = shareIdFromHashes([a, b]);
  const id2 = shareIdFromHashes([b, a]);
  assert.match(id1, /^[0-9a-f]{32}$/);
  assert.equal(id1, id2, '顺序不应影响传输 ID');

  assert.notEqual(id1, shareIdFromHashes([{ ...a, sha256: hash('c') }, b]), '内容变化应换 ID');
  assert.notEqual(id1, shareIdFromHashes([{ ...a, path: 'a2.txt' }, b]), '路径变化应换 ID');
  assert.notEqual(id1, shareIdFromHashes([{ ...a, size: 4 }, b]), '大小变化应换 ID');
  assert.equal(id1, shareIdFromHashes([a, b]), '同样输入必须稳定');
});

test('传输 ID 拒绝非法哈希', () => {
  assert.throws(
    () => shareIdFromHashes([{ path: 'a', size: 1, sha256: 'xyz' }]),
    (e) => e.code === 'bad-hash',
  );
  assert.throws(() => shareIdFromHashes([]), (e) => e.code === 'empty-selection');
});

test('分块数量与区间', () => {
  assert.equal(chunkCount(0), 0);
  assert.equal(chunkCount(1), 1);
  assert.equal(chunkCount(DEFAULT_CHUNK_SIZE), 1);
  assert.equal(chunkCount(DEFAULT_CHUNK_SIZE + 1), 2);
  assert.equal(chunkCount(2.5 * DEFAULT_CHUNK_SIZE), 3);

  assert.deepEqual(chunkRange(10, 0, 4), { offset: 0, length: 4 });
  assert.deepEqual(chunkRange(10, 1, 4), { offset: 4, length: 4 });
  assert.deepEqual(chunkRange(10, 2, 4), { offset: 8, length: 2 });
  assert.deepEqual(chunkRange(DEFAULT_CHUNK_SIZE + 5, 1), { offset: DEFAULT_CHUNK_SIZE, length: 5 });
});

test('分块参数校验', () => {
  assert.throws(() => chunkCount(-1), (e) => e.code === 'bad-size');
  assert.throws(() => chunkCount(1, 0), (e) => e.code === 'bad-chunk-size');
  assert.throws(() => chunkRange(10, 3, 4), (e) => e.code === 'bad-chunk-index');
  assert.throws(() => chunkRange(10, -1, 4), (e) => e.code === 'bad-chunk-index');
  assert.throws(() => chunkOffset(-1), (e) => e.code === 'bad-chunk-index');
  assert.equal(chunkOffset(3, 10), 30);
});

test('续传偏移向下对齐到完整块', () => {
  assert.equal(resumeOffsetFromBytes(0), 0);
  assert.equal(resumeOffsetFromBytes(1024), 0);
  assert.equal(resumeOffsetFromBytes(DEFAULT_CHUNK_SIZE), DEFAULT_CHUNK_SIZE);
  assert.equal(resumeOffsetFromBytes(DEFAULT_CHUNK_SIZE + 123), DEFAULT_CHUNK_SIZE);
  assert.equal(resumeOffsetFromBytes(3 * DEFAULT_CHUNK_SIZE + 999), 3 * DEFAULT_CHUNK_SIZE);

  assert.equal(nextChunkIndex(0), 0);
  assert.equal(nextChunkIndex(DEFAULT_CHUNK_SIZE * 2 + 5), 2);
  assert.throws(() => resumeOffsetFromBytes(-1), (e) => e.code === 'bad-offset');
});

test('剩余字节数', () => {
  assert.equal(remainingBytes(1000, 0), 1000);
  assert.equal(remainingBytes(1000, 400), 1000);
  assert.equal(remainingBytes(DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_SIZE), 0);
  assert.equal(
    remainingBytes(DEFAULT_CHUNK_SIZE * 3 + 10, DEFAULT_CHUNK_SIZE * 2),
    DEFAULT_CHUNK_SIZE + 10,
    '已收两块，剩余两块（最后一块不满）',
  );
  assert.equal(remainingBytes(10, 999), 10, '小于一块的进度不产生完整块');
});
