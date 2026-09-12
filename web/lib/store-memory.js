// 内存版块存储：实现与 IndexedDB 存储相同的接口。
//
// 两个用途：
//  1) Node 测试里的接收端存储（无需浏览器环境）；
//  2) 浏览器隐私模式下 IndexedDB 不可用时的降级（本次会话内仍可续传）。

export function createMemoryStore() {
  /** @type {Map<string, {manifest: object, files: Map<number, {data: Map<number, Uint8Array>}>}>} */
  const transfers = new Map();

  const bucket = (shareId) => {
    let transfer = transfers.get(shareId);
    if (!transfer) {
      transfer = { manifest: null, files: new Map() };
      transfers.set(shareId, transfer);
    }
    return transfer;
  };

  const fileBucket = (shareId, fileIndex) => {
    const transfer = bucket(shareId);
    let file = transfer.files.get(fileIndex);
    if (!file) {
      file = { data: new Map() };
      transfer.files.set(fileIndex, file);
    }
    return file;
  };

  const receivedOf = (file) => {
    let bytes = 0;
    for (const [index, chunk] of file.data) {
      // 数据一定是从 0 开始的连续块；这里只做求和，index 仅用于排序
      void index;
      bytes += chunk.length;
    }
    return bytes;
  };

  return {
    async saveManifest(manifest) {
      bucket(manifest.shareId).manifest = structuredClone(manifest);
    },

    async loadTransfer(shareId) {
      const transfer = transfers.get(shareId);
      if (!transfer || !transfer.manifest) {
        return null;
      }
      return {
        manifest: structuredClone(transfer.manifest),
        files: [...transfer.files.entries()]
          .map(([i, file]) => ({ i, received: receivedOf(file), chunks: file.data.size }))
          // 没有块的条目也保留，方便上层判断"该文件已在断点记录里"
          .sort((a, b) => a.i - b.i),
      };
    },

    async putChunk({ shareId, fileIndex, chunkIndex, bytes }) {
      const file = fileBucket(shareId, fileIndex);
      if (file.data.has(chunkIndex)) {
        return { received: receivedOf(file), chunks: file.data.size };
      }
      file.data.set(chunkIndex, bytes.slice());
      // 保持块顺序（Map 迭代顺序 = 插入顺序，但重传可能打乱，这里显式排序）
      const ordered = new Map([...file.data.entries()].sort((a, b) => a[0] - b[0]));
      file.data = ordered;
      return { received: receivedOf(file), chunks: file.data.size };
    },

    async *readChunks(shareId, fileIndex) {
      const file = transfers.get(shareId)?.files.get(fileIndex);
      if (!file) {
        return;
      }
      const ordered = [...file.data.entries()].sort((a, b) => a[0] - b[0]);
      for (const [, chunk] of ordered) {
        yield chunk;
      }
    },

    async deleteFile(shareId, fileIndex) {
      transfers.get(shareId)?.files.delete(fileIndex);
    },

    async deleteTransfer(shareId) {
      transfers.delete(shareId);
    },

    async listTransfers() {
      return [...transfers.entries()]
        .filter(([, transfer]) => transfer.manifest !== null)
        .map(([shareId, transfer]) => ({
          shareId,
          manifest: structuredClone(transfer.manifest),
          files: [...transfer.files.entries()].map(([i, file]) => ({
            i,
            received: receivedOf(file),
            chunks: file.data.size,
            complete: Boolean(transfer.manifest?.files?.[i]) &&
              receivedOf(file) >= (transfer.manifest.files[i].size ?? 0),
          })),
        }));
    },

    /** 测试辅助：当前占用的字节数。 */
    async totalBytes() {
      let total = 0;
      for (const transfer of transfers.values()) {
        for (const file of transfer.files.values()) {
          total += receivedOf(file);
        }
      }
      return total;
    },
  };
}
