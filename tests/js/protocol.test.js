import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FILE_STATUS,
  KIND,
  KINDS,
  ProtocolError,
  TRANSFER_STATUS,
  ackMessage,
  cancelMessage,
  downloadRequestMessage,
  errorMessage,
  fileDoneMessage,
  indexMessage,
  indexRequestMessage,
  manifestMessage,
  parsePayload,
  resumeStateMessage,
  transferDoneMessage,
  validateEntry,
} from '../../web/lib/protocol.js';

const SHARE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const SHA = 'ab'.repeat(32);

const entry = () => ({
  shareId: SHARE,
  kind: KINDS.FOLDER,
  name: '相册',
  chunkSize: 1024,
  createdAt: 1700000000000,
  files: [
    { path: '相册/a.txt', size: 10, sha256: SHA, mime: 'text/plain' },
    { path: '相册/b.bin', size: 2048, sha256: SHA },
  ],
});

test('登记项校验：自动编号、累计大小、缺省 MIME', () => {
  const validated = validateEntry(entry());
  assert.equal(validated.totalBytes, 2058);
  assert.equal(validated.fileCount, 2);
  assert.equal(validated.files[0].i, 0);
  assert.equal(validated.files[1].i, 1);
  assert.equal(validated.files[0].mime, 'text/plain');
  assert.equal(validated.files[1].mime, 'application/octet-stream');
});

test('登记项拒绝非法输入', () => {
  const cases = [
    [{ ...entry(), shareId: 'short' }, 'bad-id'],
    [{ ...entry(), kind: 'weird' }, 'bad-kind'],
    [{ ...entry(), name: '' }, 'bad-string'],
    [{ ...entry(), chunkSize: 0 }, 'bad-number'],
    [{ ...entry(), files: [] }, 'bad-files'],
    [{ ...entry(), totalBytes: 1 }, 'bad-total'],
    [
      {
        ...entry(),
        files: [{ i: 1, path: 'a', size: 1, sha256: SHA }],
      },
      'bad-index',
    ],
    [{ ...entry(), files: [{ path: 'a', size: -1, sha256: SHA }] }, 'bad-number'],
    [{ ...entry(), files: [{ path: 'a', size: 1, sha256: 'AB'.repeat(32) }] }, 'bad-hash'],
  ];
  for (const [bad, code] of cases) {
    assert.throws(
      () => validateEntry(bad),
      (error) => error instanceof ProtocolError && error.code === code,
      `期望错误码 ${code}`,
    );
  }
});

test('所有构造器产出都能被解析器接受（往返一致）', () => {
  const messages = [
    indexRequestMessage(),
    indexMessage({ entries: [entry()] }),
    downloadRequestMessage({ shareId: SHARE, streamId: 3 }),
    manifestMessage({
      shareId: SHARE,
      streamId: 3,
      kind: KINDS.SINGLE,
      senderName: 'Alice',
      chunkSize: 1024,
      files: [{ path: 'a.txt', size: 10, sha256: SHA }],
    }),
    resumeStateMessage({ shareId: SHARE, files: [{ i: 0, received: 512 }] }),
    ackMessage({ shareId: SHARE, i: 0, received: 1024, totalReceived: 4096 }),
    fileDoneMessage({ shareId: SHARE, i: 0, status: FILE_STATUS.OK, sha256: SHA }),
    fileDoneMessage({
      shareId: SHARE,
      i: 1,
      status: FILE_STATUS.HASH_MISMATCH,
      message: '校验失败',
    }),
    transferDoneMessage({ shareId: SHARE, status: TRANSFER_STATUS.PARTIAL, failed: [1] }),
    cancelMessage({ shareId: SHARE, reason: '用户取消' }),
    errorMessage({ shareId: SHARE, code: 'io-error', message: '读文件失败' }),
  ];

  for (const message of messages) {
    const parsed = parsePayload(JSON.parse(JSON.stringify(message)));
    assert.deepEqual(parsed, message, `${message.k} 往返应一致`);
  }
});

test('manifest 带 streamId，且必须与请求一致', () => {
  const manifest = manifestMessage({
    shareId: SHARE,
    streamId: 7,
    kind: KINDS.SINGLE,
    senderName: 'A',
    chunkSize: 1024,
    files: [{ path: 'a', size: 1, sha256: SHA }],
  });
  assert.equal(manifest.k, KIND.MANIFEST);
  assert.equal(manifest.streamId, 7);
  assert.equal(manifest.totalBytes, 1);

  assert.throws(
    () =>
      manifestMessage({
        shareId: SHARE,
        streamId: 0,
        kind: KINDS.SINGLE,
        senderName: 'A',
        chunkSize: 1024,
        files: [{ path: 'a', size: 1, sha256: SHA }],
      }),
    (error) => error.code === 'bad-stream',
  );
});

test('解析器拒绝畸形负载', () => {
  assert.throws(
    () => parsePayload(null),
    (error) => error.code === 'bad-payload',
  );
  assert.throws(
    () => parsePayload([1, 2, 3]),
    (error) => error.code === 'bad-payload',
  );
  assert.throws(
    () => parsePayload({ k: 'nope' }),
    (error) => error.code === 'unknown-kind',
  );
  assert.throws(
    () => parsePayload({ k: KIND.ACK, shareId: SHARE, i: -1, received: 5 }),
    (error) => error.code === 'bad-number',
  );
  assert.throws(
    () =>
      parsePayload({
        k: KIND.FILE_DONE,
        shareId: SHARE,
        i: 0,
        status: 'whatever',
      }),
    (error) => error.code === 'bad-status',
  );
  assert.throws(
    () => parsePayload({ k: KIND.DOWNLOAD_REQUEST, shareId: SHARE, streamId: 'x' }),
    (error) => error.code === 'bad-stream',
  );
});

test('长文本字段被截断，额外字段被忽略', () => {
  const message = errorMessage({
    shareId: SHARE,
    code: 'x'.repeat(200),
    message: 'y'.repeat(2000),
  });
  assert.equal(message.code.length, 64);
  assert.equal(message.message.length, 500);

  const parsed = parsePayload({
    k: KIND.CANCEL,
    shareId: SHARE,
    reason: '取消',
    extra: { nested: true },
  });
  assert.deepEqual(parsed, { k: KIND.CANCEL, shareId: SHARE, reason: '取消' });
});
