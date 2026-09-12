// 数据通道上的控制消息（文本帧 = JSON），协议见 DESIGN.md §4.3。
//
// 构造器负责"只产出合法消息"，解析器负责"拒绝一切不合法输入"：
// 两端都经过同一份校验逻辑，测试见 tests/js/protocol.test.js。

export const PROTOCOL_VERSION = 1;

export const MESSAGE = {
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

export const TRANSFER_STATUS = {
  OK: 'ok',
  PARTIAL: 'partial',
};

export const KINDS = { SINGLE: 'single', FOLDER: 'folder' };

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function manifestMessage({ transferId, kind, senderName, chunkSize, files }) {
  assertId(transferId, 'transferId');
  if (kind !== KINDS.SINGLE && kind !== KINDS.FOLDER) {
    throw new ProtocolError('bad-kind', `kind 必须是 single 或 folder，实际 ${kind}`);
  }
  assertNonEmptyString(senderName, 'senderName');
  assertPositiveInt(chunkSize, 'chunkSize');
  if (!Array.isArray(files) || files.length === 0) {
    throw new ProtocolError('bad-files', 'manifest 至少需要一个文件');
  }
  const out = files.map((file, index) => {
    const i = index;
    if (file?.i !== undefined && file.i !== i) {
      throw new ProtocolError('bad-index', `文件序号必须从 0 连续递增，期望 ${i}，实际 ${file.i}`);
    }
    assertNonEmptyString(file?.path, `files[${i}].path`);
    assertNonNegativeInt(file?.size, `files[${i}].size`);
    assertSha256(file?.sha256, `files[${i}].sha256`);
    return {
      i,
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      mime: typeof file.mime === 'string' && file.mime !== '' ? file.mime : 'application/octet-stream',
    };
  });
  return {
    t: MESSAGE.MANIFEST,
    v: PROTOCOL_VERSION,
    transferId,
    kind,
    senderName,
    chunkSize,
    totalBytes: out.reduce((sum, file) => sum + file.size, 0),
    files: out,
  };
}

export function resumeStateMessage({ transferId, files }) {
  assertId(transferId, 'transferId');
  if (!Array.isArray(files)) {
    throw new ProtocolError('bad-files', 'resume-state 需要 files 数组');
  }
  return {
    t: MESSAGE.RESUME_STATE,
    transferId,
    files: files.map((file) => ({
      i: assertNonNegativeInt(file?.i, 'files[].i'),
      received: assertNonNegativeInt(file?.received, 'files[].received'),
    })),
  };
}

export function ackMessage({ transferId, i, received, totalReceived }) {
  assertId(transferId, 'transferId');
  const message = {
    t: MESSAGE.ACK,
    transferId,
    i: assertNonNegativeInt(i, 'i'),
    received: assertNonNegativeInt(received, 'received'),
  };
  if (totalReceived !== undefined) {
    message.totalReceived = assertNonNegativeInt(totalReceived, 'totalReceived');
  }
  return message;
}

export function fileDoneMessage({ transferId, i, status, sha256, message }) {
  assertId(transferId, 'transferId');
  if (!Object.values(FILE_STATUS).includes(status)) {
    throw new ProtocolError('bad-status', `未知文件状态 ${status}`);
  }
  const out = {
    t: MESSAGE.FILE_DONE,
    transferId,
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

export function transferDoneMessage({ transferId, status, failed = [] }) {
  assertId(transferId, 'transferId');
  if (!Object.values(TRANSFER_STATUS).includes(status)) {
    throw new ProtocolError('bad-status', `未知传输状态 ${status}`);
  }
  return {
    t: MESSAGE.TRANSFER_DONE,
    transferId,
    status,
    failed: failed.map((i) => assertNonNegativeInt(i, 'failed[]')),
  };
}

export function cancelMessage({ transferId, reason }) {
  assertId(transferId, 'transferId');
  return {
    t: MESSAGE.CANCEL,
    transferId,
    reason: String(reason ?? '').slice(0, 500),
  };
}

export function errorMessage({ transferId, code = 'error', message }) {
  const out = {
    t: MESSAGE.ERROR,
    code: String(code).slice(0, 64),
    message: String(message ?? '').slice(0, 500),
  };
  if (transferId !== undefined) {
    assertId(transferId, 'transferId');
    out.transferId = transferId;
  }
  return out;
}

export function serializeControl(message) {
  return JSON.stringify(message);
}

/** 解析并校验对端发来的控制消息；任何不合法输入都抛 ProtocolError。 */
export function parseControl(input) {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new ProtocolError('bad-json', '控制消息不是合法 JSON');
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProtocolError('bad-message', '控制消息必须是 JSON 对象');
  }

  switch (raw.t) {
    case MESSAGE.MANIFEST: {
      const message = manifestMessage({
        transferId: raw.transferId,
        kind: raw.kind,
        senderName: raw.senderName,
        chunkSize: raw.chunkSize,
        files: raw.files,
      });
      return message;
    }
    case MESSAGE.RESUME_STATE:
      return resumeStateMessage({ transferId: raw.transferId, files: raw.files });
    case MESSAGE.ACK: {
      const message = ackMessage({ transferId: raw.transferId, i: raw.i, received: raw.received });
      if (raw.totalReceived !== undefined) {
        message.totalReceived = assertNonNegativeInt(raw.totalReceived, 'totalReceived');
      }
      return message;
    }
    case MESSAGE.FILE_DONE:
      return fileDoneMessage({
        transferId: raw.transferId,
        i: raw.i,
        status: raw.status,
        sha256: raw.sha256,
        message: raw.message,
      });
    case MESSAGE.TRANSFER_DONE:
      return transferDoneMessage({
        transferId: raw.transferId,
        status: raw.status,
        failed: raw.failed ?? [],
      });
    case MESSAGE.CANCEL:
      return cancelMessage({ transferId: raw.transferId, reason: raw.reason });
    case MESSAGE.ERROR:
      return errorMessage({
        transferId: raw.transferId,
        code: raw.code,
        message: raw.message,
      });
    default:
      throw new ProtocolError('unknown-type', `未知控制消息类型 ${JSON.stringify(raw.t)}`);
  }
}

function assertId(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8,64}$/.test(value)) {
    throw new ProtocolError('bad-id', `${name} 必须是 8..64 位十六进制字符串，实际 ${value}`);
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
