// 传输计划：把"用户选了什么"变成可执行的传输描述（需求 R7 + 分块/续传算术）。
//
// 关键点：单文件还是文件夹完全由选择结果推导，用户不需要切模式。

import { sha256Hex } from './sha256.js';

export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB
export const MAX_FILES = 5000;

export class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

/** File 对象在文件夹上传时带 webkitRelativePath，普通选择则只有 name。 */
export function relativePathOf(file) {
  const raw = typeof file?.webkitRelativePath === 'string' ? file.webkitRelativePath : '';
  return normalizePath(raw !== '' ? raw : (file?.name ?? ''));
}

/** 统一成 POSIX 相对路径，并挡住越界路径。 */
export function normalizePath(raw) {
  if (typeof raw !== 'string') {
    throw new PlanError('bad-path', '路径必须是字符串');
  }
  let path = raw.replaceAll('\\', '/').trim();
  if (path.startsWith('/')) {
    throw new PlanError('bad-path', `路径必须是相对的：${raw}`);
  }
  while (path.startsWith('./')) {
    path = path.slice(2);
  }
  const segments = path.split('/').filter((seg) => seg !== '');
  if (segments.length === 0) {
    throw new PlanError('bad-path', '路径不能为空');
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new PlanError('bad-path', `路径不能包含 . 或 .. 段：${raw}`);
    }
    if (seg.includes('\0')) {
      throw new PlanError('bad-path', '路径不能包含空字符');
    }
  }
  return segments.join('/');
}

/**
 * 根据选择结果生成计划。
 * @param {Array<{name:string,size:number,lastModified?:number,webkitRelativePath?:string}>} files
 */
export function buildSelectionPlan(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new PlanError('empty-selection', '没有选择任何文件');
  }
  if (files.length > MAX_FILES) {
    throw new PlanError('too-many-files', `一次最多传输 ${MAX_FILES} 个文件`);
  }

  const seen = new Set();
  const entries = [];
  let totalBytes = 0;
  for (const file of files) {
    const path = relativePathOf(file);
    if (seen.has(path)) {
      throw new PlanError('duplicate-path', `重复的路径：${path}`);
    }
    seen.add(path);
    const size = Number(file?.size);
    if (!Number.isInteger(size) || size < 0) {
      throw new PlanError('bad-size', `非法文件大小：${file?.size}`);
    }
    totalBytes += size;
    entries.push({
      path,
      size,
      lastModified: Number.isFinite(file?.lastModified) ? Number(file.lastModified) : 0,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const structured = entries.length > 1 || entries.some((entry) => entry.path.includes('/'));
  return {
    kind: structured ? 'folder' : 'single',
    files: entries,
    fileCount: entries.length,
    totalBytes,
  };
}

/**
 * 内容寻址的传输 ID：只与"传的是什么"有关，与谁在传、什么时候传无关。
 * 因此发送方刷新页面后重新选择同一批文件，接收端仍能命中断点数据（DESIGN.md §4.4）。
 */
export function transferIdFromHashes(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new PlanError('empty-selection', '没有文件无法生成传输 ID');
  }
  const lines = files
    .map((file) => {
      if (typeof file?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new PlanError('bad-hash', `${file?.path} 缺少合法的 SHA-256`);
      }
      return `${file.path}\n${file.size}\n${file.sha256}`;
    })
    .sort()
    .join('\n');
  return sha256Hex(lines).slice(0, 32);
}

// ---------------------------------------------------------------------------
// 分块与续传算术（与 framing.js 的 chunkIndex 语义一一对应）
// ---------------------------------------------------------------------------

export function assertChunkSize(chunkSize) {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new PlanError('bad-chunk-size', `chunkSize 必须是正整数，实际 ${chunkSize}`);
  }
}

export function chunkCount(size, chunkSize = DEFAULT_CHUNK_SIZE) {
  assertSize(size);
  assertChunkSize(chunkSize);
  return Math.ceil(size / chunkSize);
}

export function chunkRange(size, index, chunkSize = DEFAULT_CHUNK_SIZE) {
  assertSize(size);
  assertChunkSize(chunkSize);
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount(size, chunkSize)) {
    throw new PlanError('bad-chunk-index', `chunkIndex ${index} 越界（文件大小 ${size}）`);
  }
  const offset = index * chunkSize;
  return { offset, length: Math.min(chunkSize, size - offset) };
}

export function chunkOffset(index, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!Number.isInteger(index) || index < 0) {
    throw new PlanError('bad-chunk-index', `chunkIndex 必须是非负整数，实际 ${index}`);
  }
  assertChunkSize(chunkSize);
  return index * chunkSize;
}

/**
 * 续传偏移：只认"完整收到"的块，因此向下对齐到块边界。
 * 断开时正在传的那一块会被重传（DataChannel 消息是原子的，不存在半块落盘）。
 */
export function resumeOffsetFromBytes(received, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!Number.isInteger(received) || received < 0) {
    throw new PlanError('bad-offset', `已收字节数必须是非负整数，实际 ${received}`);
  }
  assertChunkSize(chunkSize);
  return Math.floor(received / chunkSize) * chunkSize;
}

export function nextChunkIndex(received, chunkSize = DEFAULT_CHUNK_SIZE) {
  return resumeOffsetFromBytes(received, chunkSize) / chunkSize;
}

export function remainingBytes(size, received) {
  assertSize(size);
  if (!Number.isInteger(received) || received < 0) {
    throw new PlanError('bad-offset', `已收字节数必须是非负整数，实际 ${received}`);
  }
  const done = Math.min(size, resumeOffsetFromBytes(received));
  return size - done;
}

function assertSize(size) {
  if (!Number.isInteger(size) || size < 0) {
    throw new PlanError('bad-size', `文件大小必须是非负整数，实际 ${size}`);
  }
}
