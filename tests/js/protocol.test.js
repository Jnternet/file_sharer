import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FILE_STATUS,
  KINDS,
  MESSAGE,
  ProtocolError,
  TRANSFER_STATUS,
  ackMessage,
  cancelMessage,
  errorMessage,
  fileDoneMessage,
  manifestMessage,
  parseControl,
  resumeStateMessage,
  serializeControl,
  transferDoneMessage,
} from '../../web/lib/protocol.js';

const ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const SHA = 'ab'.repeat(32);

const sampleManifest = () =>
  manifestMessage({
    transferId: ID,
    kind: KINDS.FOLDER,
    senderName: 'Alice',
    chunkSize: 1024,
    files: [
      { path: 'dir/a.txt', size: 10, sha256: SHA, mime: 'text/plain' },
      { path: 'dir/b.bin', size: 2048, sha256: SHA },
    ],
  });

test('manifest：自动编号、累计大小、缺省 MIME', () => {
  const manifest = sampleManifest();
  assert.equal(manifest.t, MESSAGE.MANIFEST);
  assert.equal(manifest.totalBytes, 2058);
  assert.equal(manifest.files[0].i, 0);
  assert.equal(manifest.files[1].i, 1);
  assert.equal(manifest.files[0].mime, 'text/plain');
  assert.equal(manifest.files[1].mime, 'application/octet-stream');
});

test('所有构造器产出都能被解析器接受（往返一致）', () => {
  const messages = [
    sampleManifest(),
    resumeStateMessage({ transferId: ID, files: [{ i: 0, received: 512 }] }),
    ackMessage({ transferId: ID, i: 0, received: 1024, totalReceived: 4096 }),
    fileDoneMessage({ transferId: ID, i: 0, status: FILE_STATUS.OK, sha256: SHA }),
    fileDoneMessage({
      transferId: ID,
      i: 1,
      status: FILE_STATUS.HASH_MISMATCH,
      message: '校验失败',
    }),
    transferDoneMessage({ transferId: ID, status: TRANSFER_STATUS.PARTIAL, failed: [1] }),
    cancelMessage({ transferId: ID, reason: '用户取消' }),
    errorMessage({ transferId: ID, code: 'io-error', message: '读文件失败' }),
  ];

  for (const message of messages) {
    const parsed = parseControl(serializeControl(message));
    assert.deepEqual(parsed, message, `${message.t} 往返应一致`);
  }
});

test('解析器接受对象输入', () => {
  const parsed = parseControl({ t: MESSAGE.ACK, transferId: ID, i: 0, received: 10 });
  assert.equal(parsed.received, 10);
});

test('manifest 校验：序号必须连续、路径/hash/大小合法', () => {
  assert.throws(
    () =>
      manifestMessage({
        transferId: ID,
        kind: KINDS.SINGLE,
        senderName: 'A',
        chunkSize: 1,
        files: [{ i: 1, path: 'a', size: 1, sha256: SHA }],
      }),
    (e) => e.code === 'bad-index',
  );
  assert.throws(
    () =>
      manifestMessage({
        transferId: ID,
        kind: KINDS.SINGLE,
        senderName: 'A',
        chunkSize: 1,
        files: [{ path: '', size: 1, sha256: SHA }],
      }),
    (e) => e.code === 'bad-string',
  );
  assert.throws(
    () =>
      manifestMessage({
        transferId: ID,
        kind: KINDS.SINGLE,
        senderName: 'A',
        chunkSize: 1,
        files: [{ path: 'a', size: -1, sha256: SHA }],
      }),
    (e) => e.code === 'bad-number',
  );
  assert.throws(
    () =>
      manifestMessage({
        transferId: ID,
        kind: KINDS.SINGLE,
        senderName: 'A',
        chunkSize: 1,
        files: [{ path: 'a', size: 1, sha256: 'AB'.repeat(32) }],
      }),
    (e) => e.code === 'bad-hash',
  );
  assert.throws(
    () =>
      manifestMessage({
        transferId: ID,
        kind: 'weird',
        senderName: 'A',
        chunkSize: 1,
        files: [{ path: 'a', size: 1, sha256: SHA }],
      }),
    (e) => e.code === 'bad-kind',
  );
  assert.throws(
    () =>
      manifestMessage({
        transferId: ID,
        kind: KINDS.SINGLE,
        senderName: 'A',
        chunkSize: 0,
        files: [{ path: 'a', size: 1, sha256: SHA }],
      }),
    (e) => e.code === 'bad-number',
  );
  assert.throws(
    () =>
      manifestMessage({
        transferId: ID,
        kind: KINDS.SINGLE,
        senderName: 'A',
        chunkSize: 1,
        files: [],
      }),
    (e) => e.code === 'bad-files',
  );
});

test('非法 transferId / 状态值被拒绝', () => {
  assert.throws(() => cancelMessage({ transferId: 'short', reason: 'x' }), ProtocolError);
  assert.throws(
    () => fileDoneMessage({ transferId: ID, i: 0, status: 'whatever' }),
    (e) => e.code === 'bad-status',
  );
  assert.throws(
    () => transferDoneMessage({ transferId: ID, status: 'whatever' }),
    (e) => e.code === 'bad-status',
  );
});

test('解析器拒绝畸形输入', () => {
  assert.throws(
    () => parseControl('{不是 JSON'),
    (e) => e.code === 'bad-json',
  );
  assert.throws(
    () => parseControl(JSON.stringify([1, 2, 3])),
    (e) => e.code === 'bad-message',
  );
  assert.throws(
    () => parseControl('null'),
    (e) => e.code === 'bad-message',
  );
  assert.throws(
    () => parseControl({ t: 'nope' }),
    (e) => e.code === 'unknown-type',
  );
  assert.throws(
    () => parseControl({ t: MESSAGE.ACK, transferId: ID, i: -1, received: 5 }),
    (e) => e.code === 'bad-number',
  );
  assert.throws(
    () => parseControl({ t: MESSAGE.FILE_DONE, transferId: ID, i: 0, status: 'ok', sha256: 'x' }),
    (e) => e.code === 'bad-hash',
  );
});

test('长文本字段被截断，避免把错误信息变成攻击面', () => {
  const message = errorMessage({ transferId: ID, code: 'x'.repeat(200), message: 'y'.repeat(2000) });
  assert.equal(message.code.length, 64);
  assert.equal(message.message.length, 500);

  const cancel = cancelMessage({ transferId: ID, reason: 'z'.repeat(2000) });
  assert.equal(cancel.reason.length, 500);
});

test('额外字段被忽略，不会污染解析结果', () => {
  const parsed = parseControl({
    t: MESSAGE.CANCEL,
    transferId: ID,
    reason: '取消',
    extra: { nested: true },
  });
  assert.deepEqual(parsed, { t: MESSAGE.CANCEL, transferId: ID, reason: '取消' });
});
