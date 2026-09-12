import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { Sha256, sha256Hex, toHex } from '../../web/lib/sha256.js';

const ref = (data) => createHash('sha256').update(data).digest('hex');

test('FIPS 180-4 标准向量', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  assert.equal(
    sha256Hex('a'.repeat(1_000_000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

test('与 node:crypto 对照：各种长度', () => {
  for (let len = 0; len <= 300; len++) {
    const data = randomBytes(len);
    assert.equal(sha256Hex(data), ref(data), `长度 ${len} 不匹配`);
  }
  for (const len of [511, 512, 513, 1023, 1024, 1025, 4096, 65535]) {
    const data = randomBytes(len);
    assert.equal(sha256Hex(data), ref(data), `长度 ${len} 不匹配`);
  }
});

test('分块 update 与一次性等价（含逐字节喂入）', () => {
  const data = randomBytes(4096);
  const expected = ref(data);

  for (const chunkSize of [1, 2, 3, 7, 63, 64, 65, 127, 128, 1000, 4096]) {
    const hash = new Sha256();
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      hash.update(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
    }
    assert.equal(hash.hex(), expected, `分块大小 ${chunkSize} 不匹配`);
    assert.equal(hash.bytesHashed, data.length);
  }
});

test('边界：padding 分支长度', () => {
  for (const len of [54, 55, 56, 57, 63, 64, 65, 119, 120]) {
    const data = randomBytes(len);
    assert.equal(sha256Hex(data), ref(data), `长度 ${len} 的 padding 分支`);
  }
});

test('流式读取 1 MiB（模拟文件分块）', () => {
  const data = randomBytes(1024 * 1024);
  const hash = new Sha256();
  const chunk = 64 * 1024;
  for (let offset = 0; offset < data.length; offset += chunk) {
    hash.update(data.subarray(offset, offset + chunk));
  }
  assert.equal(hash.hex(), ref(data));
});

test('digest 幂等，finalize 后 update 抛错，reset 可重用', () => {
  const hash = new Sha256().update('abc');
  const first = hash.hex();
  assert.equal(hash.hex(), first, 'digest 应当幂等');
  assert.deepEqual(hash.digest(), hash.digest());
  assert.throws(() => hash.update('更多'), /reset/);

  hash.reset();
  assert.equal(hash.bytesHashed, 0);
  hash.update('abc');
  assert.equal(hash.hex(), first, 'reset 后应当可重用');
});

test('接受 string / ArrayBuffer / TypedArray / DataView', () => {
  const bytes = new TextEncoder().encode('hello');
  const expected = ref(Buffer.from(bytes));

  assert.equal(new Sha256().update(bytes).hex(), expected);
  assert.equal(new Sha256().update(bytes.buffer).hex(), expected);
  assert.equal(new Sha256().update(new DataView(bytes.buffer)).hex(), expected);

  const padded = new Uint8Array(9);
  padded.set(bytes, 2);
  const view = new Uint8Array(padded.buffer, 2, 5);
  assert.equal(new Sha256().update(view).hex(), expected, '应尊重 byteOffset/byteLength');
});

test('非法输入被拒绝', () => {
  for (const bad of [42, null, undefined, {}, [1, 2, 3]]) {
    assert.throws(() => new Sha256().update(bad), TypeError);
  }
});

test('toHex 输出固定宽度的小写十六进制', () => {
  assert.equal(toHex(new Uint8Array([0, 1, 15, 16, 255])), '00010f10ff');
});
