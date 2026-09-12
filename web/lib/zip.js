// store 模式 ZIP 打包（不压缩）。
//
// 用途：文件夹传输完成后一次性交付，保留目录结构（DESIGN.md §4/§7）。
// 设计要点：
//  - 先按 manifest 里的大小算出总长度，一次性分配输出，因此可以"流式写入 + 回填头部"，
//    内存里只保留在途的分块，不需要把整个文件夹读进内存；
//  - 只支持 ZIP32（< 4 GiB），超过时抛 too-large，由上层降级为逐个文件下载。

export const ZIP32_LIMIT = 0xffffffff;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const EOCD = 22;
const FLAG_UTF8 = 0x0800;

export class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** 增量 CRC-32：首次调用传 0，后续传入上一次返回值。 */
export function crc32(bytes, seed = 0) {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff,
    date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

/**
 * 打包成 store ZIP。
 *
 * @param {Array<{path:string,size:number,chunks:()=>AsyncIterable<Uint8Array>}>} entries
 * @param {{mtime?:Date,onProgress?:Function}} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function buildStoreZip(entries, { mtime = new Date(), onProgress } = {}) {
  if (!Array.isArray(entries)) {
    throw new ZipError('bad-entries', 'entries 必须是数组');
  }
  const encoder = new TextEncoder();
  const now = dosDateTime(mtime);

  const files = entries.map((entry) => {
    const path = normalizeEntryPath(entry.path);
    const name = encoder.encode(path);
    const size = entry.size ?? 0;
    if (!Number.isInteger(size) || size < 0) {
      throw new ZipError('bad-size', `${path} 的大小非法：${entry.size}`);
    }
    if (typeof entry.chunks !== 'function') {
      throw new ZipError('bad-chunks', `${path} 缺少 chunks() 数据源`);
    }
    return { path, name, size, chunks: entry.chunks };
  });

  // 目录条目（去重，且不重复已有目录）
  const directoryNames = new Set();
  for (const file of files) {
    const segments = file.path.split('/');
    segments.pop();
    let prefix = '';
    for (const segment of segments) {
      prefix += `${segment}/`;
      directoryNames.add(prefix);
    }
  }
  for (const file of files) {
    directoryNames.delete(`${file.path}/`);
  }
  const directories = [...directoryNames].sort().map((path) => ({
    path,
    name: encoder.encode(path),
    size: 0,
    isDirectory: true,
  }));

  const localSize =
    files.reduce((sum, file) => sum + LOCAL_HEADER + file.name.length + file.size, 0) +
    directories.reduce((sum, dir) => sum + LOCAL_HEADER + dir.name.length, 0);
  const centralSize =
    (files.length + directories.length) * CENTRAL_HEADER +
    files.reduce((sum, file) => sum + file.name.length, 0) +
    directories.reduce((sum, dir) => sum + dir.name.length, 0);
  const totalSize = localSize + centralSize + EOCD;
  if (totalSize > ZIP32_LIMIT) {
    throw new ZipError('too-large', `打包后超过 4 GiB（${totalSize} 字节），请改用逐个文件下载`);
  }

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  const records = [];
  let offset = 0;
  let written = 0;

  for (const dir of directories) {
    const localOffset = offset;
    offset = writeLocalHeader(view, out, offset, {
      name: dir.name,
      crc: 0,
      size: 0,
      time: now.time,
      date: now.date,
    });
    records.push({ ...dir, localOffset, crc: 0 });
  }

  for (const file of files) {
    const localOffset = offset;
    const headerAt = offset;
    offset = writeLocalHeader(view, out, offset, {
      name: file.name,
      crc: 0,
      size: file.size,
      time: now.time,
      date: now.date,
    });

    let crc = 0;
    let produced = 0;
    for await (const chunk of file.chunks()) {
      if (!(chunk instanceof Uint8Array)) {
        throw new ZipError('bad-chunk', `${file.path} 的分块必须是 Uint8Array`);
      }
      if (produced + chunk.length > file.size) {
        throw new ZipError('size-mismatch', `${file.path} 实际数据超过声明大小`);
      }
      out.set(chunk, offset);
      offset += chunk.length;
      produced += chunk.length;
      crc = crc32(chunk, crc);
      written += chunk.length;
      onProgress?.({ path: file.path, processedBytes: written });
    }
    if (produced !== file.size) {
      throw new ZipError(
        'size-mismatch',
        `${file.path} 数据不完整：${produced} / ${file.size}`,
      );
    }
    // 回填本地头部的 CRC 与大小（写入前还不知道 CRC）
    view.setUint32(headerAt + 14, crc, true);
    view.setUint32(headerAt + 18, file.size, true);
    view.setUint32(headerAt + 22, file.size, true);
    records.push({ ...file, localOffset, crc, isDirectory: false });
  }

  const centralOffset = offset;
  for (const record of records) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, 20, true); // version needed
    view.setUint16(offset + 8, FLAG_UTF8, true);
    view.setUint16(offset + 10, 0, true); // store
    view.setUint16(offset + 12, now.time, true);
    view.setUint16(offset + 14, now.date, true);
    view.setUint32(offset + 16, record.crc, true);
    view.setUint32(offset + 20, record.size, true);
    view.setUint32(offset + 24, record.size, true);
    view.setUint16(offset + 28, record.name.length, true);
    view.setUint16(offset + 30, 0, true); // extra
    view.setUint16(offset + 32, 0, true); // comment
    view.setUint16(offset + 34, 0, true); // disk
    view.setUint16(offset + 36, 0, true); // internal attrs
    view.setUint32(offset + 38, record.isDirectory ? 0x41ed0010 : 0x81a40000, true); // 权限位
    view.setUint32(offset + 42, record.localOffset, true);
    out.set(record.name, offset + CENTRAL_HEADER);
    offset += CENTRAL_HEADER + record.name.length;
  }

  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, records.length, true);
  view.setUint16(offset + 10, records.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true);
  offset += EOCD;

  if (offset !== totalSize) {
    throw new ZipError('internal', `内部长度计算错误：${offset} != ${totalSize}`);
  }
  return out;
}

function writeLocalHeader(view, out, offset, { name, crc, size, time, date }) {
  view.setUint32(offset, 0x04034b50, true);
  view.setUint16(offset + 4, 20, true);
  view.setUint16(offset + 6, FLAG_UTF8, true);
  view.setUint16(offset + 8, 0, true); // store
  view.setUint16(offset + 10, time, true);
  view.setUint16(offset + 12, date, true);
  view.setUint32(offset + 14, crc, true);
  view.setUint32(offset + 18, size, true);
  view.setUint32(offset + 22, size, true);
  view.setUint16(offset + 26, name.length, true);
  view.setUint16(offset + 28, 0, true);
  out.set(name, offset + LOCAL_HEADER);
  return offset + LOCAL_HEADER + name.length;
}

/** ZIP 内部路径：反斜杠转正斜杠、去重斜杠、禁止越界。 */
export function normalizeEntryPath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ZipError('bad-path', 'ZIP 条目路径必须是非空字符串');
  }
  const path = raw.replaceAll('\\', '/').replace(/^\/+/, '');
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new ZipError('bad-path', `ZIP 条目路径非法：${raw}`);
  }
  return segments.join('/');
}

/** 单文件下载名：取路径最后一段并做安全清洗。 */
export function safeFileName(path, fallback = 'download.bin') {
  const base = String(path ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .pop();
  if (!base) {
    return fallback;
  }
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return cleaned === '' ? fallback : cleaned.slice(0, 150);
}

/** 文件夹打包后的下载名：用顶层目录名，退化为 files.zip。 */
export function zipNameFor(paths, fallback = 'files.zip') {
  const first = paths.map((path) => String(path ?? '')).find((path) => path.includes('/'));
  if (!first) {
    return fallback;
  }
  const top = first.split('/')[0];
  const name = safeFileName(top, 'files');
  return `${name}.zip`;
}
