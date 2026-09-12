import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkKey, chunkRangeFor, createIndexedDbStore } from '../../web/lib/idb-store.js';

test('chunkKey 使用复合主键 [shareId, fileIndex, chunkIndex]', () => {
  assert.deepEqual(chunkKey('abcd1234', 2, 7), ['abcd1234', 2, 7]);
});

test('chunkRangeFor 覆盖同一传输内某个文件的全部块', () => {
  const calls = [];
  const fakeRange = {
    bound(lower, upper) {
      calls.push([lower, upper]);
      return { lower, upper };
    },
  };
  const range = chunkRangeFor('abcd1234', 3, fakeRange);
  assert.deepEqual(range.lower, ['abcd1234', 3, 0]);
  assert.deepEqual(range.upper, ['abcd1234', 3, Number.MAX_SAFE_INTEGER]);
  assert.equal(calls.length, 1);
});

test('没有 IndexedDB 时给出可读错误（上层可降级到内存存储）', async () => {
  await assert.rejects(
    createIndexedDbStore({ indexedDB: undefined }),
    /不支持 IndexedDB/,
  );
});
