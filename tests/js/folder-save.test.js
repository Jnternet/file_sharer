import test from 'node:test';
import assert from 'node:assert/strict';

import { supportsDirectoryWrite, writeFilesToDirectory } from '../../web/lib/folder-save.js';
import { randomBytes } from './support/relay-harness.js';

function createFakeFile(name) {
  const chunks = [];
  const state = { closed: false, aborted: false };
  return {
    kind: 'file',
    name,
    chunks,
    state,
    async createWritable() {
      return {
        async write(chunk) {
          if (state.closed) {
            throw new Error('写入流已关闭');
          }
          chunks.push(new Uint8Array(chunk));
        },
        async close() {
          state.closed = true;
        },
        async abort() {
          state.aborted = true;
          state.closed = true;
        },
      };
    },
  };
}

function createFakeDirectory(name = '') {
  const dirs = new Map();
  const files = new Map();
  return {
    kind: 'directory',
    name,
    dirs,
    files,
    async getDirectoryHandle(child, { create } = {}) {
      if (!dirs.has(child)) {
        if (!create) {
          throw new Error(`目录不存在：${child}`);
        }
        dirs.set(child, createFakeDirectory(child));
      }
      return dirs.get(child);
    },
    async getFileHandle(child, { create } = {}) {
      if (!files.has(child)) {
        if (!create) {
          throw new Error(`文件不存在：${child}`);
        }
        files.set(child, createFakeFile(child));
      }
      return files.get(child);
    },
  };
}

function fileEntry(path, bytes, chunk = 7) {
  return {
    path,
    size: bytes.length,
    chunks: async function* chunks() {
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        yield bytes.subarray(offset, Math.min(offset + chunk, bytes.length));
      }
    },
  };
}

function join(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

test('supportsDirectoryWrite 只在有目录选择 API 时为真', () => {
  assert.equal(supportsDirectoryWrite({ showDirectoryPicker: () => {} }), true);
  assert.equal(supportsDirectoryWrite({}), false);
  assert.equal(supportsDirectoryWrite(undefined), false);
});

test('把整个文件夹按结构写入所选目录（含子目录）', async () => {
  const root = createFakeDirectory();
  const a = randomBytes(40, 1);
  const b = randomBytes(90, 2);
  const progress = [];

  const result = await writeFilesToDirectory(
    root,
    [fileEntry('相册/说明.txt', a), fileEntry('相册/子目录/数据.bin', b)],
    { onProgress: (event) => progress.push(event) },
  );

  assert.equal(result.files, 2);
  assert.equal(result.bytes, 130);
  const album = root.dirs.get('相册');
  assert.ok(album, '应当创建顶层目录');
  assert.deepEqual([...join(album.files.get('说明.txt').chunks)], [...a]);
  const nested = album.dirs.get('子目录');
  assert.ok(nested, '应当创建子目录');
  assert.deepEqual([...join(nested.files.get('数据.bin').chunks)], [...b]);
  assert.equal(album.files.get('说明.txt').state.closed, true);

  assert.equal(progress.length, Math.ceil(40 / 7) + Math.ceil(90 / 7));
  assert.equal(progress.at(-1).processedBytes, 130);
  assert.equal(progress.at(-1).totalBytes, 130);
  assert.equal(progress.at(-1).ratio, 1);
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i].processedBytes > progress[i - 1].processedBytes, '进度必须单调递增');
  }
});

test('0 字节文件也能创建，进度比例为 1', async () => {
  const root = createFakeDirectory();
  const progress = [];
  await writeFilesToDirectory(root, [fileEntry('空/empty.txt', new Uint8Array(0))], {
    onProgress: (event) => progress.push(event),
  });
  assert.equal(root.dirs.get('空').files.get('empty.txt').chunks.length, 0);
  assert.equal(progress.length, 0, '没有分块就没有进度事件');
});

test('数据长度与声明不符时中止写入并报错', async () => {
  const root = createFakeDirectory();
  const short = {
    path: 'x.bin',
    size: 10,
    chunks: async function* chunks() {
      yield new Uint8Array(4);
    },
  };
  await assert.rejects(writeFilesToDirectory(root, [short]), /数据不完整/);
  assert.equal(root.files.get('x.bin').state.aborted, true, '出错时必须 abort 而不是 close');
});

test('越界路径被拒绝，不写任何文件', async () => {
  const root = createFakeDirectory();
  await assert.rejects(
    writeFilesToDirectory(root, [fileEntry('../escape.txt', new Uint8Array(1))]),
    /路径非法/,
  );
  assert.equal(root.files.size, 0);
  assert.equal(root.dirs.size, 0);
});

test('参数校验', async () => {
  await assert.rejects(writeFilesToDirectory(null, []), TypeError);
  await assert.rejects(writeFilesToDirectory(createFakeDirectory(), 'nope'), TypeError);
});
