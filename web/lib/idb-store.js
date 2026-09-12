// IndexedDB 版块存储：实现与 store-memory.js 完全相同的接口。
//
// 数据全在浏览器本地（服务器零存储）。断点续传依赖它：页面刷新后
// 重新选择同一批文件，接收端仍能从这里读出已收的块并续传。

const DB_NAME = 'file-sharer';
const DB_VERSION = 1;
const CHUNKS = 'chunks';
const TRANSFERS = 'transfers';

export function chunkKey(transferId, fileIndex, chunkIndex) {
  return [transferId, fileIndex, chunkIndex];
}

export function chunkRangeFor(transferId, fileIndex, rangeFactory = globalThis.IDBKeyRange) {
  return rangeFactory.bound(
    [transferId, fileIndex, 0],
    [transferId, fileIndex, Number.MAX_SAFE_INTEGER],
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
      const existing = await request(store.get(manifest.transferId));
      await request(
        store.put({
          transferId: manifest.transferId,
          manifest,
          files: existing?.files ?? {},
        }),
      );
      await done(tx);
    },

    async loadTransfer(transferId) {
      const record = await request(db.transaction(TRANSFERS).objectStore(TRANSFERS).get(transferId));
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

    async putChunk({ transferId, fileIndex, chunkIndex, bytes }) {
      const tx = db.transaction([CHUNKS, TRANSFERS], 'readwrite');
      const chunks = tx.objectStore(CHUNKS);
      const transfers = tx.objectStore(TRANSFERS);
      const record = await request(transfers.get(transferId));
      const key = chunkKey(transferId, fileIndex, chunkIndex);
      const existing = await request(chunks.get(key));
      if (existing) {
        await done(tx);
        return snapshotFile(record, fileIndex);
      }
      // 存一份拷贝，避免调用方复用 buffer
      const copy = bytes.slice();
      await request(
        chunks.put({
          transferId,
          fileIndex,
          chunkIndex,
          size: copy.length,
          bytes: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
        }),
      );
      const files = { ...(record?.files ?? {}) };
      const meta = files[fileIndex] ?? { received: 0, chunks: 0 };
      files[fileIndex] = { received: meta.received + copy.length, chunks: meta.chunks + 1 };
      await request(transfers.put({ ...record, transferId, files }));
      await done(tx);
      return files[fileIndex];
    },

    async *readChunks(transferId, fileIndex) {
      // 逐块读取（每块一个事务）：块数来自元数据，顺序由 chunkIndex 决定。
      // 不用游标是因为长事务在 await 边界上会被浏览器自动提交，进而报
      // TransactionInactiveError / AbortError。
      const meta = await request(
        db.transaction(TRANSFERS).objectStore(TRANSFERS).get(transferId),
      );
      const chunks = meta?.files?.[fileIndex]?.chunks ?? 0;
      for (let index = 0; index < chunks; index++) {
        const record = await request(
          db.transaction(CHUNKS).objectStore(CHUNKS).get(chunkKey(transferId, fileIndex, index)),
        );
        if (!record) {
          throw new Error(`断点数据缺失：块 ${index}（${transferId}/${fileIndex}）`);
        }
        yield new Uint8Array(record.bytes);
      }
    },

    async deleteFile(transferId, fileIndex) {
      const tx = db.transaction([CHUNKS, TRANSFERS], 'readwrite');
      const chunks = tx.objectStore(CHUNKS);
      const cursorRequest = chunks.openCursor(chunkRangeFor(transferId, fileIndex));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      const transfers = tx.objectStore(TRANSFERS);
      const record = await request(transfers.get(transferId));
      if (record) {
        const files = { ...(record.files ?? {}) };
        delete files[fileIndex];
        await request(transfers.put({ ...record, files }));
      }
      await done(tx);
    },

    async deleteTransfer(transferId) {
      const tx = db.transaction([CHUNKS, TRANSFERS], 'readwrite');
      const chunks = tx.objectStore(CHUNKS);
      const range = IDBKeyRange.bound([transferId], [transferId, Number.MAX_SAFE_INTEGER]);
      const cursorRequest = chunks.openCursor(range);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      await request(tx.objectStore(TRANSFERS).delete(transferId));
      await done(tx);
    },

    async listTransfers() {
      const records = await request(db.transaction(TRANSFERS).objectStore(TRANSFERS).getAll());
      return records
        .filter((record) => record?.manifest)
        .map((record) => ({
          transferId: record.transferId,
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
          keyPath: ['transferId', 'fileIndex', 'chunkIndex'],
        });
        chunks.createIndex('byTransfer', ['transferId', 'fileIndex'], { unique: false });
      }
      if (!db.objectStoreNames.contains(TRANSFERS)) {
        db.createObjectStore(TRANSFERS, { keyPath: 'transferId' });
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
