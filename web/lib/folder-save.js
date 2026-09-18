// 把接收到的文件夹"原样写进你选择的目录"（File System Access，需要 https 或 localhost）。
//
// 这是"保存整个文件夹"的首选实现：按相对路径逐层创建目录与文件，边写边报进度。
// 浏览器不支持时由上层降级为打包 ZIP。

import { normalizeEntryPath } from './zip.js';

export function supportsDirectoryWrite(scope = globalThis) {
  return typeof scope?.showDirectoryPicker === 'function';
}

/**
 * @param {FileSystemDirectoryHandle} directoryHandle 用户选择的目标目录
 * @param {Array<{path:string,size:number,chunks:()=>AsyncIterable<Uint8Array>}>} files
 * @param {{onProgress?: (progress: {path:string,processedBytes:number,totalBytes:number,ratio:number}) => void}} [options]
 */
export async function writeFilesToDirectory(directoryHandle, files, { onProgress } = {}) {
  if (!directoryHandle || typeof directoryHandle.getDirectoryHandle !== 'function') {
    throw new TypeError('writeFilesToDirectory 需要 FileSystemDirectoryHandle');
  }
  if (!Array.isArray(files)) {
    throw new TypeError('files 必须是数组');
  }

  const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  const directories = new Map(); // "相册/子目录/" -> handle
  directories.set('', directoryHandle);
  let written = 0;

  for (const file of files) {
    const path = normalizeEntryPath(file.path);
    const segments = path.split('/');
    const name = segments.pop();
    const directory = await resolveDirectory(directoryHandle, segments, directories);
    const fileHandle = await directory.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    let fileWritten = 0;
    try {
      for await (const chunk of file.chunks()) {
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError(`${path} 的分块必须是 Uint8Array`);
        }
        await writable.write(chunk);
        fileWritten += chunk.length;
        written += chunk.length;
        onProgress?.({
          path,
          processedBytes: written,
          totalBytes,
          ratio: totalBytes === 0 ? 1 : written / totalBytes,
        });
      }
      if (file.size !== undefined && fileWritten !== file.size) {
        throw new Error(`${path} 数据不完整：${fileWritten} / ${file.size}`);
      }
      await writable.close();
    } catch (error) {
      await writable.abort?.();
      throw error;
    }
  }

  return { files: files.length, bytes: written };
}

async function resolveDirectory(root, segments, cache) {
  let current = root;
  let key = '';
  for (const segment of segments) {
    key += `${segment}/`;
    let handle = cache.get(key);
    if (!handle) {
      handle = await current.getDirectoryHandle(segment, { create: true });
      cache.set(key, handle);
    }
    current = handle;
  }
  return current;
}
