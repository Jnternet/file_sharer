// 浏览器 File 对象 → 发送核心需要的 source 接口。

export function sourceFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('sourceFromEntries 需要非空的 [{file, path}] 列表');
  }
  const prepared = entries.map((entry, index) => {
    const file = entry.file ?? entry;
    if (!file || typeof file.slice !== 'function') {
      throw new TypeError(`第 ${index} 项不是可读取的 File 对象`);
    }
    return { file, path: entry.path ?? file.name, mime: file.type || 'application/octet-stream' };
  });

  return {
    fileCount: prepared.length,
    totalBytes: prepared.reduce((sum, entry) => sum + entry.file.size, 0),
    file(i) {
      const entry = prepared[i];
      if (!entry) {
        throw new RangeError(`文件序号越界：${i}`);
      }
      return { path: entry.path, size: entry.file.size, mime: entry.mime };
    },
    async read(i, offset, length) {
      const entry = prepared[i];
      if (!entry) {
        throw new RangeError(`文件序号越界：${i}`);
      }
      const blob = entry.file.slice(offset, offset + length);
      const buffer = await blob.arrayBuffer();
      return new Uint8Array(buffer);
    },
    fileAt(i) {
      return prepared[i]?.file ?? null;
    },
  };
}

/** 从 <input type="file"> 或拖放结果构建 [{file, path}]（自动识别文件夹）。 */
export function entriesFromFileList(files) {
  return [...files].map((file) => ({
    file,
    // 文件夹上传时 webkitRelativePath 带目录结构；普通选择只有文件名
    path: file.webkitRelativePath && file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name,
  }));
}

/**
 * 拖放：用 webkitGetAsEntry 递归展开目录（浏览器只给扁平文件列表，
 * 目录结构必须靠 entry API 还原）。
 */
export async function entriesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer.items ?? [])];
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length === 0) {
    return entriesFromFileList(dataTransfer.files ?? []);
  }
  const out = [];
  for (const entry of entries) {
    await collectEntry(entry, '', out);
  }
  return out;
}

async function collectEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, path: `${prefix}${entry.name}` });
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const children = await new Promise((resolve, reject) => {
      const all = [];
      const readBatch = () => {
        reader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve(all);
            return;
          }
          all.push(...batch);
          readBatch();
        }, reject);
      };
      readBatch();
    });
    for (const child of children) {
      await collectEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}
