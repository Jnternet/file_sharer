// 浏览器之间的负载协议。
//
// 这些对象放在服务器的 relay.payload 里端到端传递：服务器只搬运算不解析。
// 分层：索引（登记文件位置）→ 下载请求（点击才发生）→ 传输（manifest/分块/ack/校验）。

export const PROTOCOL_VERSION = 1;

export const KIND = {
  INDEX_REQUEST: 'index-request',
  INDEX: 'index',
  DOWNLOAD_REQUEST: 'download-request',
  MANIFEST: 'manifest',
  RESUME_STATE: 'resume-state',
  ACK: 'ack',
  FILE_DONE: 'file-done',
  TRANSFER_DONE: 'transfer-done',
  CANCEL: 'cancel',
  ERROR: 'error',
};

export const FILE_STATUS = {
  OK: 'ok',
  HASH_MISMATCH: 'hash-mismatch',
  INCOMPLETE: 'incomplete',
};

export const TRANSFER_STATUS = { OK: 'ok', PARTIAL: 'partial' };
export const KINDS = { SINGLE: 'single', FOLDER: 'folder' };

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 记录区（只登记"文件位置"，没有文件内容）
// ---------------------------------------------------------------------------

export function indexRequestMessage() {
  return { k: KIND.INDEX_REQUEST, v: PROTOCOL_VERSION };
}

export function indexMessage({ entries }) {
  if (!Array.isArray(entries)) {
    throw new ProtocolError('bad-entries', 'index 需要 entries 数组');
  }
  return {
    k: KIND.INDEX,
    v: PROTOCOL_VERSION,
    entries: entries.map((entry) => validateEntry(entry)),
  };
}

export function validateEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ProtocolError('bad-entry', '登记项必须是对象');
  }
  assertId(entry.shareId, 'shareId');
  if (entry.kind !== KINDS.SINGLE && entry.kind !== KINDS.FOLDER) {
    throw new ProtocolError('bad-kind', `kind 必须是 single 或 folder，实际 ${entry.kind}`);
  }
  assertNonEmptyString(entry.name, 'name');
  assertPositiveInt(entry.chunkSize, 'chunkSize');
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    throw new ProtocolError('bad-files', '登记项至少需要一个文件');
  }
  const files = entry.files.map((file, index) => {
    if (file?.i !== undefined && file.i !== index) {
      throw new ProtocolError('bad-index', `文件序号必须从 0 连续递增，期望 ${index}，实际 ${file.i}`);
    }
    assertNonEmptyString(file?.path, `files[${index}].path`);
    assertNonNegativeInt(file?.size, `files[${index}].size`);
    assertSha256(file?.sha256, `files[${index}].sha256`);
    return {
      i: index,
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      mime: typeof file.mime === 'string' && file.mime !== '' ? file.mime : 'application/octet-stream',
    };
  });
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (entry.totalBytes !== undefined && entry.totalBytes !== totalBytes) {
    throw new ProtocolError('bad-total', `totalBytes 与实际之和不符：${entry.totalBytes} vs ${totalBytes}`);
  }
  return {
    shareId: entry.shareId,
    kind: entry.kind,
    name: entry.name,
    totalBytes,
    fileCount: files.length,
    chunkSize: entry.chunkSize,
    createdAt: Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : 0,
    files,
  };
}

// ---------------------------------------------------------------------------
// 传输
// ---------------------------------------------------------------------------

export function downloadRequestMessage({ shareId, streamId }) {
  assertId(shareId, 'shareId');
  assertStreamId(streamId, 'streamId');
  return { k: KIND.DOWNLOAD_REQUEST, shareId, streamId };
}

export function manifestMessage({ shareId, streamId, kind, senderName, chunkSize, files }) {
  assertId(shareId, 'shareId');
  assertStreamId(streamId, 'streamId');
  if (kind !== KINDS.SINGLE && kind !== KINDS.FOLDER) {
    throw new ProtocolError('bad-kind', `kind 必须是 single 或 folder，实际 ${kind}`);
  }
  assertNonEmptyString(senderName, 'senderName');
  assertPositiveInt(chunkSize, 'chunkSize');
  const validated = validateEntry({
    shareId,
    kind,
    name: files?.[0]?.path ?? 'file',
    chunkSize,
    files,
  });
  return {
    k: KIND.MANIFEST,
    v: PROTOCOL_VERSION,
    shareId,
    streamId,
    kind,
    senderName,
    chunkSize,
    totalBytes: validated.totalBytes,
    files: validated.files,
  };
}

export function resumeStateMessage({ shareId, files }) {
  assertId(shareId, 'shareId');
  if (!Array.isArray(files)) {
    throw new ProtocolError('bad-files', 'resume-state 需要 files 数组');
  }
  return {
    k: KIND.RESUME_STATE,
    shareId,
    files: files.map((file) => ({
      i: assertNonNegativeInt(file?.i, 'files[].i'),
      received: assertNonNegativeInt(file?.received, 'files[].received'),
    })),
  };
}

export function ackMessage({ shareId, i, received, totalReceived }) {
  assertId(shareId, 'shareId');
  const message = {
    k: KIND.ACK,
    shareId,
    i: assertNonNegativeInt(i, 'i'),
    received: assertNonNegativeInt(received, 'received'),
  };
  if (totalReceived !== undefined) {
    message.totalReceived = assertNonNegativeInt(totalReceived, 'totalReceived');
  }
  return message;
}

export function fileDoneMessage({ shareId, i, status, sha256, message }) {
  assertId(shareId, 'shareId');
  if (!Object.values(FILE_STATUS).includes(status)) {
    throw new ProtocolError('bad-status', `未知文件状态 ${status}`);
  }
  const out = {
    k: KIND.FILE_DONE,
    shareId,
    i: assertNonNegativeInt(i, 'i'),
    status,
  };
  if (sha256 !== undefined) {
    assertSha256(sha256, 'sha256');
    out.sha256 = sha256;
  }
  if (message !== undefined) {
    out.message = String(message).slice(0, 500);
  }
  return out;
}

export function transferDoneMessage({ shareId, status, failed = [] }) {
  assertId(shareId, 'shareId');
  if (!Object.values(TRANSFER_STATUS).includes(status)) {
    throw new ProtocolError('bad-status', `未知传输状态 ${status}`);
  }
  return {
    k: KIND.TRANSFER_DONE,
    shareId,
    status,
    failed: failed.map((i) => assertNonNegativeInt(i, 'failed[]')),
  };
}

export function cancelMessage({ shareId, reason }) {
  assertId(shareId, 'shareId');
  return { k: KIND.CANCEL, shareId, reason: String(reason ?? '').slice(0, 500) };
}

export function errorMessage({ shareId, code = 'error', message }) {
  const out = {
    k: KIND.ERROR,
    code: String(code).slice(0, 64),
    message: String(message ?? '').slice(0, 500),
  };
  if (shareId !== undefined) {
    assertId(shareId, 'shareId');
    out.shareId = shareId;
  }
  return out;
}

/** 解析并校验对端发来的负载；任何不合法输入都抛 ProtocolError。 */
export function parsePayload(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError('bad-payload', '负载必须是 JSON 对象');
  }
  switch (input.k) {
    case KIND.INDEX_REQUEST:
      return { k: KIND.INDEX_REQUEST, v: PROTOCOL_VERSION };
    case KIND.INDEX:
      return indexMessage({ entries: input.entries });
    case KIND.DOWNLOAD_REQUEST:
      return downloadRequestMessage({ shareId: input.shareId, streamId: input.streamId });
    case KIND.MANIFEST:
      return manifestMessage({
        shareId: input.shareId,
        streamId: input.streamId,
        kind: input.kind,
        senderName: input.senderName,
        chunkSize: input.chunkSize,
        files: input.files,
      });
    case KIND.RESUME_STATE:
      return resumeStateMessage({ shareId: input.shareId, files: input.files });
    case KIND.ACK: {
      const message = ackMessage({
        shareId: input.shareId,
        i: input.i,
        received: input.received,
      });
      if (input.totalReceived !== undefined) {
        message.totalReceived = assertNonNegativeInt(input.totalReceived, 'totalReceived');
      }
      return message;
    }
    case KIND.FILE_DONE:
      return fileDoneMessage({
        shareId: input.shareId,
        i: input.i,
        status: input.status,
        sha256: input.sha256,
        message: input.message,
      });
    case KIND.TRANSFER_DONE:
      return transferDoneMessage({
        shareId: input.shareId,
        status: input.status,
        failed: input.failed ?? [],
      });
    case KIND.CANCEL:
      return cancelMessage({ shareId: input.shareId, reason: input.reason });
    case KIND.ERROR:
      return errorMessage({ shareId: input.shareId, code: input.code, message: input.message });
    default:
      throw new ProtocolError('unknown-kind', `未知负载类型 ${JSON.stringify(input.k)}`);
  }
}

function assertId(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8,64}$/.test(value)) {
    throw new ProtocolError('bad-id', `${name} 必须是 8..64 位十六进制字符串，实际 ${value}`);
  }
  return value;
}

function assertStreamId(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) {
    throw new ProtocolError('bad-stream', `${name} 必须是 1..4294967295 的整数，实际 ${value}`);
  }
  return value;
}

function assertSha256(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ProtocolError('bad-hash', `${name} 必须是 64 位小写十六进制`);
  }
  return value;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProtocolError('bad-string', `${name} 必须是非空字符串`);
  }
  return value;
}

function assertNonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ProtocolError('bad-number', `${name} 必须是非负整数，实际 ${value}`);
  }
  return value;
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProtocolError('bad-number', `${name} 必须是正整数，实际 ${value}`);
  }
  return value;
}
