// 二进制数据帧（服务器只按连接绑定转发，不解析这些字节）。
//
//   offset 0  : u8   kind = 1
//   offset 1  : u32  streamId（一次传输的标识，用于并发接收时区分来源）
//   offset 5  : u32  fileIndex
//   offset 9  : u64  chunkIndex
//   offset 17 : payload

export const FRAME_KIND_DATA = 1;
export const DATA_HEADER_BYTES = 17;
export const MAX_U32 = 0xffffffff;

export class FrameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

export function encodeDataFrame(streamId, fileIndex, chunkIndex, payload) {
  assertU32(streamId, 'streamId');
  assertU32(fileIndex, 'fileIndex');
  assertSafeIndex(chunkIndex, 'chunkIndex');
  if (!(payload instanceof Uint8Array)) {
    throw new FrameError('bad-payload', 'payload 必须是 Uint8Array');
  }
  const frame = new Uint8Array(DATA_HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = FRAME_KIND_DATA;
  view.setUint32(1, streamId, false);
  view.setUint32(5, fileIndex, false);
  view.setBigUint64(9, BigInt(chunkIndex), false);
  frame.set(payload, DATA_HEADER_BYTES);
  return frame;
}

/**
 * 解析二进制帧。
 * @returns {{kind:number, streamId:number, fileIndex:number, chunkIndex:number, payload:Uint8Array}}
 */
export function decodeDataFrame(buffer) {
  const bytes = asBytes(buffer);
  if (bytes.length < DATA_HEADER_BYTES) {
    throw new FrameError('too-short', `二进制帧至少 ${DATA_HEADER_BYTES} 字节`);
  }
  if (bytes[0] !== FRAME_KIND_DATA) {
    throw new FrameError('bad-kind', `未知帧类型 ${bytes[0]}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkIndexBig = view.getBigUint64(9, false);
  if (chunkIndexBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FrameError('bad-chunk', 'chunkIndex 超出可安全表示的范围');
  }
  return {
    kind: bytes[0],
    streamId: view.getUint32(1, false),
    fileIndex: view.getUint32(5, false),
    chunkIndex: Number(chunkIndexBig),
    payload: bytes.subarray(DATA_HEADER_BYTES),
  };
}

function assertU32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new FrameError('bad-index', `${name} 必须是 0..${MAX_U32} 的整数，实际 ${value}`);
  }
}

function assertSafeIndex(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new FrameError(
      'bad-index',
      `${name} 必须是 0..${Number.MAX_SAFE_INTEGER} 的整数，实际 ${value}`,
    );
  }
}

function asBytes(buffer) {
  if (buffer instanceof Uint8Array) {
    return buffer;
  }
  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer);
  }
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  throw new FrameError('bad-type', '帧必须是 Uint8Array / ArrayBuffer');
}
