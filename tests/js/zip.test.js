import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ZIP32_LIMIT,
  ZipError,
  buildStoreZip,
  crc32,
  normalizeEntryPath,
  safeFileName,
  zipNameFor,
} from '../../web/lib/zip.js';
import { randomBytes } from './support/relay-harness.js';

const entry = (path, bytes) => ({
  path,
  size: bytes.length,
  chunks: async function* chunks() {
    // 故意切成不等长的分块，验证流式写入
    for (let offset = 0; offset < bytes.length; offset += 7) {
      yield bytes.subarray(offset, Math.min(offset + 7, bytes.length));
    }
  },
});

function parseZip(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocdOffset = zip.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50, 'EOCD 签名');
  const count = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  const decoder = new TextDecoder();
  const entries = [];
  let offset = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, '中央目录签名');
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, crc, size, localOffset });
    offset += 46 + nameLength;
  }
  return entries;
}

test('crc32 与已知向量一致', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new TextEncoder().encode('a')), 0xe8b7be43);

  // 分块增量计算必须与一次性计算一致
  const data = randomBytes(1000, 3);
  let incremental = 0;
  for (let offset = 0; offset < data.length; offset += 37) {
    incremental = crc32(data.subarray(offset, offset + 37), incremental);
  }
  assert.equal(incremental, crc32(data));
});

test('打包结果结构正确：目录条目、UTF-8 名称、store 方式、CRC', async () => {
  const files = [
    entry('相册/a.txt', new TextEncoder().encode('hello zip')),
    entry('相册/sub/b.bin', randomBytes(100, 4)),
    entry('相册/空.txt', new Uint8Array(0)),
  ];
  const progress = [];
  const zip = await buildStoreZip(files, {
    mtime: new Date(2026, 0, 2, 3, 4, 5),
    onProgress: (event) => progress.push(event),
  });

  const entries = parseZip(zip);
  const names = entries.map((item) => item.name);
  assert.deepEqual(names, [
    '相册/',
    '相册/sub/',
    '相册/a.txt',
    '相册/sub/b.bin',
    '相册/空.txt',
  ]);
  for (const item of entries) {
    assert.equal(item.method, 0, 'store 模式（不压缩）');
  }

  const fileEntry = entries.find((item) => item.name === '相册/a.txt');
  assert.equal(fileEntry.size, 9);
  assert.equal(fileEntry.crc, crc32(new TextEncoder().encode('hello zip')));

  // 数据确实按偏移写进去了
  const at = fileEntry.localOffset + 30 + new TextEncoder().encode('相册/a.txt').length;
  assert.equal(new TextDecoder().decode(zip.subarray(at, at + 9)), 'hello zip');

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  assert.ok(progress.length >= files.length, '应当按分块报告写入进度');
  assert.equal(progress.at(-1).processedBytes, totalBytes, '最终进度等于总字节数');
  assert.equal(progress.at(-1).totalBytes, totalBytes, '进度里要带总量，界面才能算百分比');
  assert.equal(progress.at(-1).ratio, 1);
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i].processedBytes > progress[i - 1].processedBytes, '进度必须单调递增');
  }
});

test('与 Python zipfile 交叉验证（独立实现解压校验）', async (t) => {
  let python;
  try {
    python = execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    t.skip('环境里没有 python3');
    return;
  }
  void python;

  const big = randomBytes(4096, 5);
  const zip = await buildStoreZip([
    entry('目录/文件.bin', big),
    entry('目录/子目录/说明.txt', new TextEncoder().encode('zip test')),
  ]);

  const dir = mkdtempSync(join(tmpdir(), 'file-sharer-zip-'));
  const zipPath = join(dir, 'out.zip');
  writeFileSync(zipPath, zip);

  const script = `
import json, sys, zipfile, hashlib
path = sys.argv[1]
with zipfile.ZipFile(path) as zf:
    bad = zf.testzip()
    assert bad is None, f"CRC 校验失败: {bad}"
    report = {info.filename: hashlib.sha256(zf.read(info.filename)).hexdigest() for info in zf.infolist() if not info.is_dir()}
    print(json.dumps({"names": zf.namelist(), "hashes": report}))
`;
  const output = execFileSync('python3', ['-c', script, zipPath], { encoding: 'utf8' });
  const report = JSON.parse(output);

  assert.deepEqual(report.names, ['目录/', '目录/子目录/', '目录/文件.bin', '目录/子目录/说明.txt']);
  const { sha256Hex } = await import('../../web/lib/sha256.js');
  assert.equal(report.hashes['目录/文件.bin'], sha256Hex(big));
  assert.equal(report.hashes['目录/子目录/说明.txt'], sha256Hex('zip test'));
});

test('超过 4 GiB 时拒绝打包（上层降级为逐文件下载）', async () => {
  const huge = {
    path: 'huge.bin',
    size: ZIP32_LIMIT + 1,
    chunks: async function* chunks() {
      // 不会真的读数据：长度检查应当先失败
      yield new Uint8Array(0);
    },
  };
  await assert.rejects(buildStoreZip([huge]), (error) => error.code === 'too-large');
});

test('数据长度与声明不符时拒绝（防止静默产出坏包）', async () => {
  const short = {
    path: 'short.bin',
    size: 10,
    chunks: async function* chunks() {
      yield new Uint8Array(4);
    },
  };
  await assert.rejects(buildStoreZip([short]), (error) => error.code === 'size-mismatch');

  const long = {
    path: 'long.bin',
    size: 2,
    chunks: async function* chunks() {
      yield new Uint8Array(4);
    },
  };
  await assert.rejects(buildStoreZip([long]), (error) => error.code === 'size-mismatch');

  await assert.rejects(
    buildStoreZip([{ path: 'x.bin', size: 1 }]),
    (error) => error.code === 'bad-chunks',
  );
  await assert.rejects(buildStoreZip('nope'), (error) => error.code === 'bad-entries');
});

test('路径归一化与安全文件名', () => {
  assert.equal(normalizeEntryPath('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(normalizeEntryPath('/abs/path.txt'), 'abs/path.txt');
  assert.equal(normalizeEntryPath('a//./b'), 'a/b');
  for (const bad of ['', '   ', '..', 'a/../../b', '/']) {
    assert.throws(() => normalizeEntryPath(bad), ZipError, `${bad} 应被拒绝`);
  }

  assert.equal(safeFileName('dir/file.txt'), 'file.txt');
  assert.equal(safeFileName('dir/a:b*c?.txt'), 'a_b_c_.txt');
  assert.equal(safeFileName(''), 'download.bin');
  assert.equal(safeFileName('..'), 'download.bin');
  assert.equal(safeFileName('x'.repeat(400)).length, 150);

  assert.equal(zipNameFor(['相册/a.txt', '相册/b.txt']), '相册.zip');
  assert.equal(zipNameFor(['a.txt', 'b.txt']), 'files.zip');
});
