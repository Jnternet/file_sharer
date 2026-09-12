// 记录区条目：选择文件后**只登记"文件位置"**（名称/大小/相对路径/内容哈希），
// 不发送任何文件字节。真正的内容只在别人点击下载之后才读出来。

import { DEFAULT_CHUNK_SIZE, buildSelectionPlan, shareIdFromHashes } from './plan.js';
import { hashSource } from './sender.js';

/**
 * @param {object} options
 * @param {Array<{file: File, path: string}>} options.entries 选择结果（拖放/选择框）
 * @param {(ordered: Array<{file: File, path: string}>) => object} options.sourceFactory 数据源工厂
 * @param {number} [options.chunkSize]
 * @param {(progress: object) => void} [options.onProgress]
 * @returns {Promise<{entry: object, source: object, plan: object}>}
 */
export async function buildShareEntry({
  entries,
  sourceFactory,
  chunkSize = DEFAULT_CHUNK_SIZE,
  onProgress,
  now = () => Date.now(),
}) {
  if (typeof sourceFactory !== 'function') {
    throw new TypeError('buildShareEntry 需要 sourceFactory');
  }
  const plan = buildSelectionPlan(
    entries.map(({ file, path }) => ({
      name: file.name,
      size: file.size,
      webkitRelativePath: path,
    })),
  );
  // 计划里的顺序（按路径排序）就是后续所有索引的顺序
  const ordered = plan.files.map((item) => {
    const match = entries.find((entry) => entry.path === item.path);
    if (!match) {
      throw new Error(`内部错误：找不到路径 ${item.path} 对应的文件`);
    }
    return match;
  });

  const files = await hashSource(sourceFactory(ordered), { chunkSize, onProgress });
  const entry = {
    shareId: shareIdFromHashes(files),
    kind: plan.kind,
    name: shareName(plan, ordered),
    totalBytes: plan.totalBytes,
    fileCount: files.length,
    chunkSize,
    createdAt: now(),
    files,
  };
  return { entry, source: sourceFactory(ordered), plan };
}

/** 单文件用文件名；文件夹用顶层目录名（取不到就用第一个文件名）。 */
export function shareName(plan, entries) {
  if (plan.kind === 'single') {
    return baseName(plan.files[0]?.path ?? entries[0]?.path ?? '文件');
  }
  const withDir = plan.files.map((file) => file.path).find((path) => path.includes('/'));
  if (withDir) {
    return withDir.split('/')[0];
  }
  return `${baseName(plan.files[0]?.path ?? '文件夹')} 等 ${plan.fileCount} 个文件`;
}

/** 记录区里显示用的简短描述。 */
export function describeEntry(entry) {
  const kind = entry.kind === 'folder' ? '文件夹' : '文件';
  return `${kind} · ${entry.fileCount} 个文件`;
}

function baseName(path) {
  const segments = String(path ?? '').split('/').filter(Boolean);
  return segments.at(-1) ?? '文件';
}
