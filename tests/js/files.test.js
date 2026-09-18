import test from 'node:test';
import assert from 'node:assert/strict';

import {
  entriesFromDirectoryHandle,
  entriesFromFileList,
  sourceFromEntries,
  supportsDirectoryPicker,
} from '../../web/lib/files.js';

/** 最小 File 替身：只实现 slice().arrayBuffer()。 */
function fakeFile(name, bytes, { webkitRelativePath = '', type = '' } = {}) {
  return {
    name,
    size: bytes.length,
    type,
    webkitRelativePath,
    slice(start, end) {
      const part = bytes.slice(start, end);
      return {
        async arrayBuffer() {
          return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
        },
      };
    },
  };
}

test('entriesFromFileList 保留文件夹相对路径', () => {
  const plain = fakeFile('a.txt', new Uint8Array([1]));
  const inFolder = fakeFile('b.txt', new Uint8Array([2]), { webkitRelativePath: '相册/b.txt' });

  const entries = entriesFromFileList([plain, inFolder]);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['a.txt', '相册/b.txt'],
  );
});

test('sourceFromEntries：元信息与按区间读取', async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const source = sourceFromEntries([
    { file: fakeFile('a.bin', bytes, { type: 'application/octet-stream' }), path: 'dir/a.bin' },
    { file: fakeFile('b.bin', bytes.subarray(0, 3)), path: 'dir/b.bin' },
  ]);

  assert.equal(source.fileCount, 2);
  assert.equal(source.totalBytes, 13);
  assert.deepEqual(source.file(0), {
    path: 'dir/a.bin',
    size: 10,
    mime: 'application/octet-stream',
  });
  assert.equal(source.file(1).size, 3);

  assert.deepEqual([...(await source.read(0, 2, 3))], [2, 3, 4]);
  assert.deepEqual([...(await source.read(0, 8, 5))], [8, 9], '超出末尾时按可用长度返回');
  assert.deepEqual([...(await source.read(1, 0, 3))], [0, 1, 2]);
  assert.equal(source.fileAt(1).name, 'b.bin');
});

test('非法输入被拒绝', () => {
  assert.throws(() => sourceFromEntries([]), TypeError);
  assert.throws(() => sourceFromEntries(null), TypeError);
  assert.throws(() => sourceFromEntries([{ path: 'x', file: { name: 'x' } }]), TypeError);
});

test('读取越界序号报错', async () => {
  const source = sourceFromEntries([{ file: fakeFile('a.txt', new Uint8Array([1])), path: 'a.txt' }]);
  assert.throws(() => source.file(5), RangeError);
  await assert.rejects(source.read(5, 0, 1), RangeError);
});

test('supportsDirectoryPicker 只在有 API 时为真', () => {
  assert.equal(supportsDirectoryPicker({ showDirectoryPicker: () => {} }), true);
  assert.equal(supportsDirectoryPicker({}), false);
  assert.equal(supportsDirectoryPicker(undefined), false);
});

function fakeDirHandle(name, children) {
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const child of children) {
        yield child;
      }
    },
  };
}

function fakeFileHandle(name, file) {
  return {
    kind: 'file',
    name,
    async getFile() {
      return file;
    },
  };
}

test('entriesFromDirectoryHandle 递归展开目录结构（与 input 结果同构）', async () => {
  const root = fakeDirHandle('相册', [
    fakeFileHandle('a.txt', fakeFile('a.txt', new Uint8Array([1, 2]))),
    fakeDirHandle('子目录', [fakeFileHandle('b.bin', fakeFile('b.bin', new Uint8Array([3])))]),
    fakeDirHandle('空目录', []),
  ]);

  const entries = await entriesFromDirectoryHandle(root);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['相册/a.txt', '相册/子目录/b.bin'],
  );
  assert.equal(entries[0].file.name, 'a.txt');
  assert.equal(entries[1].file.size, 1);
});

test('entriesFromDirectoryHandle 参数校验', async () => {
  await assert.rejects(entriesFromDirectoryHandle(null), TypeError);
  await assert.rejects(entriesFromDirectoryHandle({ kind: 'directory' }), TypeError);
});
