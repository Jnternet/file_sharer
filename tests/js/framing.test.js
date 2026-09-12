import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_HEADER_BYTES,
  FRAME_KIND_DATA,
  FrameError,
  decodeDataFrame,
  encodeDataFrame,
} from '../../web/lib/framing.js';

test('编解码往返（含 streamId）', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = encodeDataFrame(9, 7, 42, payload);

  assert.equal(frame.length, DATA_HEADER_BYTES + payload.length);
  assert.equal(frame[0], FRAME_KIND_DATA);

  const decoded = decodeDataFrame(frame);
  assert.equal(decoded.kind, FRAME_KIND_DATA);
  assert.equal(decoded.streamId, 9);
  assert.equal(decoded.fileIndex, 7);
  assert.equal(decoded.chunkIndex, 42);
  assert.deepEqual([...decoded.payload], [...payload]);
});

test('头部字节序符合协议（大端）', () => {
  const frame = encodeDataFrame(0x01020304, 0x05060708, 0x0001_0203_0405, new Uint8Array());
  assert.deepEqual(
    [...frame],
    [
      1,
      0x01, 0x02, 0x03, 0x04, // streamId
      0x05, 0x06, 0x07, 0x08, // fileIndex
      0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, // chunkIndex
    ],
  );
});

test('边界值：最大 streamId / fileIndex 与 0 长度负载', () => {
  const decoded = decodeDataFrame(encodeDataFrame(0xffffffff, 0xffffffff, 0, new Uint8Array()));
  assert.equal(decoded.streamId, 0xffffffff);
  assert.equal(decoded.fileIndex, 0xffffffff);
  assert.equal(decoded.chunkIndex, 0);
  assert.equal(decoded.payload.length, 0);
});

test('大 chunkIndex 正确往返', () => {
  const big = 2 ** 40 + 12345;
  assert.equal(decodeDataFrame(encodeDataFrame(1, 1, big, new Uint8Array(1))).chunkIndex, big);
});

test('编码参数校验', () => {
  for (const bad of [-1, 1.5, NaN, 0x1_0000_0000, '7', null]) {
    assert.throws(() => encodeDataFrame(bad, 0, 0, new Uint8Array()), FrameError, `streamId=${bad}`);
    assert.throws(() => encodeDataFrame(1, bad, 0, new Uint8Array()), FrameError, `fileIndex=${bad}`);
  }
  for (const bad of [-1, 1.5, NaN, 2 ** 53, '7', null]) {
    assert.throws(() => encodeDataFrame(1, 0, bad, new Uint8Array()), FrameError, `chunkIndex=${bad}`);
  }
  assert.throws(() => encodeDataFrame(1, 0, 0, [1, 2, 3]), FrameError);
  assert.equal(encodeDataFrame(1, 0, 0, new Uint8Array()).length, DATA_HEADER_BYTES);
});

test('解码拒绝畸形帧', () => {
  const tooShort = new Uint8Array(DATA_HEADER_BYTES - 1);
  assert.throws(
    () => decodeDataFrame(tooShort),
    (err) => err instanceof FrameError && err.code === 'too-short',
  );

  const badKind = encodeDataFrame(1, 0, 0, new Uint8Array());
  badKind[0] = 9;
  assert.throws(
    () => decodeDataFrame(badKind),
    (err) => err instanceof FrameError && err.code === 'bad-kind',
  );

  assert.throws(
    () => decodeDataFrame('not-a-frame'),
    (err) => err instanceof FrameError && err.code === 'bad-type',
  );

  const hugeChunk = new Uint8Array(DATA_HEADER_BYTES);
  hugeChunk[0] = FRAME_KIND_DATA;
  new DataView(hugeChunk.buffer).setBigUint64(9, 2n ** 63n, false);
  assert.throws(
    () => decodeDataFrame(hugeChunk),
    (err) => err instanceof FrameError && err.code === 'bad-chunk',
  );
});

test('解码支持带偏移的视图', () => {
  const inner = encodeDataFrame(3, 5, 9, new Uint8Array([7, 7]));
  const wrapped = new Uint8Array(inner.length + 4);
  wrapped.set(inner, 2);
  const view = new Uint8Array(wrapped.buffer, 2, inner.length);

  const decoded = decodeDataFrame(view);
  assert.equal(decoded.streamId, 3);
  assert.equal(decoded.fileIndex, 5);
  assert.equal(decoded.chunkIndex, 9);
  assert.deepEqual([...decoded.payload], [7, 7]);
});

test('1 MiB 负载不被复制（payload 是视图）', () => {
  const payload = new Uint8Array(1024 * 1024).fill(5);
  const decoded = decodeDataFrame(encodeDataFrame(1, 0, 0, payload));
  assert.equal(decoded.payload.length, payload.length);
  assert.equal(decoded.payload[1024 * 1024 - 1], 5);
});
