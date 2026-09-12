// IndexedDB 版块存储：实现与 store-memory.js 完全相同的接口。
//
// 数据全在浏览器本地（服务器零存储）。断点续传依赖它：页面刷新后
// 重新选择同一批文件，接收端仍能从这里读出已收的块并续传。

const DB_NAME = 'file-sharer';
const DB_VERSION = 1;
const CHUNKS = 'chunks';
const TRANSFERS = 'transfers';

export function chunkKey(shareId, fileIndex, chunkIndex) {
  return [shareId, fileIndex, chunkIndex];
}

export function chunkRangeFor(shareId, fileIndex, rangeFactory = globalThis.IDBKeyRange) {
  return rangeFactory.bound(
    [shareId, fileIndex, 0],
    [shareId, fileIndex, Number.MAX_SAFE_INTEGER],
  );
}

export async function createIndexedDbStore({ indexedDB: factory = globalThis.indexedDB } = {}) {
  if (!factory) {
    throw new Error('当前浏览器不支持 IndexedDB');
  }
  const db = await openDatabase(factory);

  return {
    async saveManifest(manifest) {
      const tx = db.transaction(TRANSFERS, 'readwrite');
      const store = tx.objectStore(TRANSFERS);
      const existing = await request(store.get(manifest.shareId));
      await request(
        store.put({
          shareId: manifest.shareId,
          manifest,
          files: existing?.files ?? {},
        }),
      );
      await done(tx);
    },

    async loadTransfer(shareId) {
      const record = await request(db.transaction(TRANSFERS).objectStore(TRANSFERS).get(shareId));
      if (!record) {
        return null;
      }
      return {
        manifest: record.manifest,
        files: Object.entries(record.files ?? {}).map(([i, meta]) => ({
          i: Number(i),
          received: meta.received ?? 0,
          chunks: meta.chunks ?? 0,
        })),
      };
    },

    async putChunk({ shareId, fileIndex, chunkIndex, bytes }) {
      const tx = db.transaction([CHUNKS, TRANSFERS], 'readwrite');
      const chunks = tx.objectStore(CHUNKS);
      const transfers = tx.objectStore(TRANSFERS);
      const record = await request(transfers.get(shareId));
      const key = chunkKey(shareId, fileIndex, chunkIndex);
      const existing = await request(chunks.get(key));
      if (existing) {
        await done(tx);
        return snapshotFile(record, fileIndex);
      }
      // 存一份拷贝，避免调用方复用 buffer
      const copy = bytes.slice();
      await request(
        chunks.put({
          shareId,
          fileIndex,
          chunkIndex,
          size: copy.length,
          bytes: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
        }),
      );
      const files = { ...(record?.files ?? {}) };
      const meta = files[fileIndex] ?? { received: 0, chunks: 0 };
      files[fileIndex] = { received: meta.received + copy.length, chunks: meta.chunks + 1 };
      await request(transfers.put({ ...record, shareId, files }));
      await done(tx);
      return files[fileIndex];
    },

    async *readChunks(shareId, fileIndex) {
      // 逐块读取（每块一个事务）：块数来自元数据，顺序由 chunkIndex 决定。
      // 不用游标是因为长事务在 await 边界上会被浏览器自动提交，进而报
      // TransactionInactiveError / AbortError。
      const meta = await request(
        db.transaction(TRANSFERS).objectStore(TRANSFERS).get(shareId),
      );
      const chunks = meta?.files?.[fileIndex]?.chunks ?? 0;
      for (let index = 0; index < chunks; index++) {
        const record = await request(
          db.transaction(CHUNKS).objectStore(CHUNKS).get(chunkKey(shareId, fileIndex, index)),
        );
        if (!record) {
          throw new Error(`断点数据缺失：块 ${index}（${shareId}/${fileIndex}）`);
        }
        yield new Uint8Array(record.bytes);
      }
    },

    async deleteFile(shareId, fileIndex) {
      const tx = db.transaction([CHUNKS, TRANSFERS], 'readwrite');
      const chunks = tx.objectStore(CHUNKS);
      const cursorRequest = chunks.openCursor(chunkRangeFor(shareId, fileIndex));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      const transfers = tx.objectStore(TRANSFERS);
      const record = await request(transfers.get(shareId));
      if (record) {
        const files = { ...(record.files ?? {}) };
        delete files[fileIndex];
        await request(transfers.put({ ...record, files }));
      }
      await done(tx);
    },

    async deleteTransfer(shareId) {
      const tx = db.transaction([CHUNKS, TRANSFERS], 'readwrite');
      const chunks = tx.objectStore(CHUNKS);
      const range = IDBKeyRange.bound([shareId], [shareId, Number.MAX_SAFE_INTEGER]);
      const cursorRequest = chunks.openCursor(range);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      await request(tx.objectStore(TRANSFERS).delete(shareId));
      await done(tx);
    },

    async listTransfers() {
      const records = await request(db.transaction(TRANSFERS).objectStore(TRANSFERS).getAll());
      return records
        .filter((record) => record?.manifest)
        .map((record) => ({
          shareId: record.shareId,
          manifest: record.manifest,
          files: Object.entries(record.files ?? {}).map(([i, meta]) => ({
            i: Number(i),
            received: meta.received ?? 0,
            chunks: meta.chunks ?? 0,
            complete: (meta.received ?? 0) >= (record.manifest.files[Number(i)]?.size ?? 0),
          })),
        }));
    },

    close() {
      db.close();
    },
  };
}

function snapshotFile(record, fileIndex) {
  const meta = record?.files?.[fileIndex] ?? { received: 0, chunks: 0 };
  return { received: meta.received ?? 0, chunks: meta.chunks ?? 0 };
}

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    const requestObject = factory.open(DB_NAME, DB_VERSION);
    requestObject.onupgradeneeded = () => {
      const db = requestObject.result;
      if (!db.objectStoreNames.contains(CHUNKS)) {
        const chunks = db.createObjectStore(CHUNKS, {
          keyPath: ['shareId', 'fileIndex', 'chunkIndex'],
        });
        chunks.createIndex('byTransfer', ['shareId', 'fileIndex'], { unique: false });
      }
      if (!db.objectStoreNames.contains(TRANSFERS)) {
        db.createObjectStore(TRANSFERS, { keyPath: 'shareId' });
      }
    };
    requestObject.onsuccess = () => resolve(requestObject.result);
    requestObject.onerror = () => reject(requestObject.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'));
  });
}
