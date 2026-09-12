// 真实浏览器端到端验证（可选，需要本机有 firefox）：
//
//   1. 启动本项目的 release 单产物；
//   2. 用 WebDriver BiDi 打开两个标签页（等价于局域网里的两台设备）；
//   3. 在 A 页模拟"拖入文件"，触发真实 WebRTC 直传；
//   4. 在 B 页等待校验完成，并从 IndexedDB 读回落盘数据，逐字节比对。
//
// 运行：node scripts/e2e-browser.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { sha256Hex } from '../web/lib/sha256.js';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'target/release/file_sharer');
const PORT = Number(process.env.E2E_PORT ?? 18099);
const BIDI_PORT = Number(process.env.E2E_BIDI_PORT ?? 9222);
const BASE = `http://127.0.0.1:${PORT}/`;

const children = [];
const log = (...args) => console.log(...args);

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // 忽略
    }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

async function waitFor(description, fn, { timeoutMs = 30_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  throw new Error(`等待「${description}」超时${lastError ? `：${lastError.message}` : ''}`);
}

// ---------------------------------------------------------------- 启动被测服务

function requireBinary() {
  if (!existsSync(BIN)) {
    throw new Error(`缺少构建产物 ${BIN}，请先运行 cargo build --release`);
  }
}

function startServer() {
  const child = spawn(BIN, ['--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

function startFirefox() {
  const profile = mkdtempSync(join(tmpdir(), 'file-sharer-ff-'));
  // 自动化环境下的 WebRTC：允许回环候选、关掉 mDNS 混淆，保证两个标签页能直连
  writeFileSync(
    join(profile, 'user.js'),
    [
      'user_pref("media.peerconnection.ice.loopback", true);',
      'user_pref("media.peerconnection.ice.obfuscate_host_addresses", false);',
      'user_pref("media.peerconnection.ice.link_local", false);',
      'user_pref("dom.webrtc.enabled", true);',
      '',
    ].join('\n'),
  );
  const child = spawn(
    'firefox',
    [
      '--headless',
      '--no-remote',
      '--profile',
      profile,
      `--remote-debugging-port`,
      String(BIDI_PORT),
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOZ_HEADLESS: '1' } },
  );
  children.push(child);
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (text.includes('BiDi listening')) {
      log(`[firefox] ${text.trim()}`);
    }
  });
  return child;
}

// ---------------------------------------------------------------- BiDi 客户端

function createBidiClient(url, { onEvent = () => {} } = {}) {
  let socket = null;
  let opened = null;
  const pending = new Map();
  let nextId = 1;

  const connect = () =>
    new Promise((resolveConnect, rejectConnect) => {
      socket = new WebSocket(url);
      socket.onopen = () => resolveConnect();
      socket.onerror = () => {
        opened = null;
        rejectConnect(new Error(`无法连接 BiDi：${url}`));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
          const { resolve: resolveCall, reject } = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) {
            reject(new Error(`${message.error}: ${message.message ?? ''}`));
          } else {
            resolveCall(message.result);
          }
          return;
        }
        if (message.method) {
          onEvent(message);
        }
      };
    });

  // Firefox 的 Remote Agent 需要一点时间才监听端口，这里带重试地建立连接
  async function ensureConnected({ timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!opened) {
        opened = connect();
      }
      try {
        await opened;
        return;
      } catch (error) {
        opened = null;
        if (Date.now() > deadline) {
          throw error;
        }
        await new Promise((done) => setTimeout(done, 250));
      }
    }
  }

  return {
    async call(method, params = {}) {
      await ensureConnected();
      const id = nextId++;
      return new Promise((resolveCall, reject) => {
        pending.set(id, { resolve: resolveCall, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket?.close();
    },
  };
}

async function evaluate(client, context, expression) {
  // BiDi 的 RemoteValue 序列化对对象是 [key, value] 列表，直接读会很别扭；
  // 统一在页面里 JSON.stringify，再把字符串解析回普通结构。
  const wrapped = `(async () => JSON.stringify(await (${expression})))()`;
  const result = await client.call('script.evaluate', {
    expression: wrapped,
    target: { context },
    awaitPromise: true,
    resultOwnership: 'none',
  });
  if (result.type === 'exception') {
    throw new Error(`页面脚本异常：${JSON.stringify(result.exceptionDetails?.exception ?? result)}`);
  }
  const raw = result.result?.value;
  return raw === undefined ? undefined : JSON.parse(raw);
}

/** 从接收页的 IndexedDB 里读回某个文件的落盘数据。 */
async function readStoredFile(client, context, transferId, fileIndex) {
  const result = await evaluate(
    client,
    context,
    `(async () => {
      const open = indexedDB.open('file-sharer', 1);
      const db = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const chunks = await new Promise((resolve, reject) => {
        const request = db.transaction('chunks').objectStore('chunks').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const ordered = chunks
        .filter((chunk) => chunk.transferId === ${JSON.stringify(transferId)} && chunk.fileIndex === ${fileIndex})
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      const out = new Uint8Array(ordered.reduce((sum, chunk) => sum + chunk.size, 0));
      let offset = 0;
      for (const chunk of ordered) {
        out.set(new Uint8Array(chunk.bytes), offset);
        offset += chunk.size;
      }
      return { bytes: [...out], chunks: ordered.length };
    })()`,
  );
  return result;
}

/** 在接收页里找出已完成的传输。 */
async function findCompletedTransfer(client, context, kind) {
  return evaluate(
    client,
    context,
    `(() => {
      const transfers = [...window.fileSharer.state.transfers.values()];
      const hit = transfers.find((item) => item.manifest?.kind === ${JSON.stringify(kind)} && item.status === 'complete');
      if (!hit) {
        return null;
      }
      return {
        transferId: hit.manifest.transferId,
        files: [...hit.files.values()].map((file) => ({ path: file.path, status: file.status, size: file.size })),
      };
    })()`,
  );
}

function assertBytesEqual(actual, expected, label) {
  if (actual.length !== expected.length) {
    throw new Error(`${label} 长度不符：${actual.length} != ${expected.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${label} 第 ${i} 字节不符：${actual[i]} != ${expected[i]}`);
    }
  }
}

async function openTab(client, label) {
  const { context } = await client.call('browsingContext.create', { type: 'tab' });
  await client.call('browsingContext.navigate', { context, url: BASE, wait: 'complete' });
  log(`已打开标签页 ${label}（context=${context}）`);
  return context;
}

// ---------------------------------------------------------------- 测试数据

function sampleBytes(length, seed = 11) {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

const SAMPLE = sampleBytes(3000);
const SAMPLE_NAME = '端到端测试.bin';

const FOLDER_FILES = [
  { path: 'e2e目录/说明.txt', bytes: [...new TextEncoder().encode('文件夹传输端到端验证')] },
  { path: 'e2e目录/子目录/数据.bin', bytes: [...sampleBytes(2048, 23)] },
];

// ---------------------------------------------------------------- 主流程

async function main() {
  requireBinary();
  startServer();
  await waitFor('服务就绪', async () => (await fetch(`${BASE}api/health`)).ok, { timeoutMs: 15_000 });
  log(`被测服务已启动：${BASE}`);

  startFirefox();
  // Firefox 的 Remote Agent 在 /session 路径上提供 WebDriver BiDi
  const client = createBidiClient(`ws://127.0.0.1:${BIDI_PORT}/session`, {
    onEvent: (message) => {
      if (message.method === 'log.entryAdded') {
        const entry = message.params;
        if (entry.level === 'error') {
          log(`[浏览器错误] ${entry.text}`);
        }
      }
    },
  });
  await waitFor('BiDi 会话', async () => {
    try {
      await client.call('session.new', { capabilities: {} });
      return true;
    } catch (error) {
      if (String(error.message).includes('session already exists')) {
        return true;
      }
      throw error;
    }
  }, { timeoutMs: 20_000 });

  const tabA = await openTab(client, 'A（发送方）');
  const tabB = await openTab(client, 'B（接收方）');

  // 页面控制台错误直接打到脚本输出，便于定位真实浏览器问题
  await client.call('session.subscribe', { events: ['log.entryAdded'] });

  // 两侧都连上信令、并完成 WebRTC 直连
  for (const [label, context] of [['A', tabA], ['B', tabB]]) {
    await waitFor(`${label} 页完成直连`, async () => {
      const state = await evaluate(
        client,
        context,
        `(() => ({
          status: document.getElementById('conn-status')?.textContent ?? '',
          peers: [...document.querySelectorAll('#peer-list .peer')].map((el) => el.textContent),
          transfers: document.getElementById('transfers')?.textContent ?? '',
        }))()`,
      );
      if (label === 'A' && Date.now() % 5000 < 200) {
        log(`[诊断 ${label}] ${JSON.stringify(state)}`);
      }
      return state.peers.length === 1 && state.peers[0].includes('已直连');
    }, { timeoutMs: 20_000 });
    log(`${label} 页已与对端建立直连`);
  }

  // 在 A 页模拟"把文件拖进发送区"
  const bytesLiteral = JSON.stringify([...SAMPLE]);
  await evaluate(
    client,
    tabA,
    `(() => {
      const bytes = new Uint8Array(${bytesLiteral});
      const file = new File([bytes], ${JSON.stringify(SAMPLE_NAME)}, { type: 'application/octet-stream' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document.getElementById('dropzone').dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
      return true;
    })()`,
  );
  log('已在 A 页派发拖放事件（真实 File → WebRTC 直传）');

  // A 页显示发送完成
  await waitFor('发送侧完成', () =>
    evaluate(client, tabA, `document.getElementById('transfers').textContent.includes('完成')`),
  );

  // B 页显示接收完成 + 每个文件都通过校验
  await waitFor('接收侧完成校验', () =>
    evaluate(
      client,
      tabB,
      `(() => {
        const text = document.getElementById('transfers').textContent;
        return text.includes('完成') && text.includes('已校验');
      })()`,
    ),
  );
  log('B 页显示接收完成且哈希校验通过');

  // 从 B 页 IndexedDB 读回真实落盘数据，逐字节比对
  const single = await waitFor('接收页登记单文件传输', () =>
    findCompletedTransfer(client, tabB, 'single'),
  );
  if (single.files[0].path !== SAMPLE_NAME) {
    throw new Error(`文件名不符：${single.files[0].path} != ${SAMPLE_NAME}`);
  }
  const received = await readStoredFile(client, tabB, single.transferId, 0);
  assertBytesEqual(received.bytes, [...SAMPLE], '单文件内容');
  log(
    `单文件端到端通过：${SAMPLE_NAME}（${SAMPLE.length} 字节，${received.chunks} 块）经 WebRTC 直传，` +
      `接收端哈希校验通过且逐字节一致，服务器未参与数据搬运`,
  );

  // ---------------------------------------------------------------- 文件夹 + ZIP
  await evaluate(
    client,
    tabA,
    `(async () => {
      const specs = ${JSON.stringify(FOLDER_FILES)};
      const entries = specs.map((spec) => {
        const name = spec.path.split('/').pop();
        const file = new File([new Uint8Array(spec.bytes)], name, { type: 'application/octet-stream' });
        // 拖放文件夹时浏览器会带 webkitRelativePath，这里直接构造等价对象
        Object.defineProperty(file, 'webkitRelativePath', { value: spec.path });
        return { file, path: spec.path };
      });
      await window.fileSharer.sendEntries(entries);
      return entries.map((entry) => entry.path);
    })()`,
  );
  log('已在 A 页以"文件夹"形式发送 2 个文件（含子目录）');

  const folder = await waitFor('接收页完成文件夹传输', () =>
    findCompletedTransfer(client, tabB, 'folder'),
  );
  const folderPaths = folder.files.map((file) => file.path).sort();
  const expectedPaths = FOLDER_FILES.map((file) => file.path).sort();
  if (JSON.stringify(folderPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`目录结构不符：${JSON.stringify(folderPaths)}`);
  }
  for (const [index, spec] of FOLDER_FILES.entries()) {
    const fileIndex = folder.files.findIndex((file) => file.path === spec.path);
    const stored = await readStoredFile(client, tabB, folder.transferId, fileIndex);
    assertBytesEqual(stored.bytes, spec.bytes, `文件夹内容 ${spec.path}`);
    void index;
  }

  // 浏览器里真实跑一遍 ZIP 打包（数据来自 IndexedDB）
  const zip = await evaluate(
    client,
    tabB,
    `(async () => {
      const bytes = await window.fileSharer.buildZipFor(${JSON.stringify(folder.transferId)});
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const eocd = bytes.length - 22;
      const count = view.getUint16(eocd + 10, true);
      const centralOffset = view.getUint32(eocd + 16, true);
      const decoder = new TextDecoder();
      const names = [];
      let offset = centralOffset;
      for (let i = 0; i < count; i++) {
        const nameLength = view.getUint16(offset + 28, true);
        names.push(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
        offset += 46 + nameLength;
      }
      return { names, size: bytes.length, bytes: [...bytes] };
    })()`,
  );
  for (const expected of [...expectedPaths, 'e2e目录/', 'e2e目录/子目录/']) {
    if (!zip.names.includes(expected)) {
      throw new Error(`ZIP 缺少条目 ${expected}：${JSON.stringify(zip.names)}`);
    }
  }

  // 把浏览器里打出来的 ZIP 交给 python3 独立校验（结构与 CRC）
  const zipPath = join(mkdtempSync(join(tmpdir(), 'file-sharer-zip-')), 'browser.zip');
  writeFileSync(zipPath, new Uint8Array(zip.bytes));
  const verified = await verifyZipWithPython(zipPath);
  for (const spec of FOLDER_FILES) {
    if (verified[spec.path] !== sha256Hex(new Uint8Array(spec.bytes))) {
      throw new Error(`ZIP 中 ${spec.path} 的内容哈希不符`);
    }
  }
  log(
    `文件夹端到端通过：${expectedPaths.length} 个文件按目录结构接收并校验一致，` +
      `浏览器内打包 ZIP 成功（${zip.size} 字节，条目 ${zip.names.length} 个，python3 解压校验通过）`,
  );

  // ---------------------------------------------------------------- 清空接收区
  await evaluate(client, tabB, `(document.getElementById('clear-received').click(), true)`);
  await waitFor('接收区清空（IndexedDB 断点数据一并删除）', () =>
    evaluate(
      client,
      tabB,
      `(async () => {
        const open = indexedDB.open('file-sharer', 1);
        const db = await new Promise((resolve, reject) => {
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        const get = (store, mode) =>
          new Promise((resolve, reject) => {
            const request =
              mode === 'count'
                ? db.transaction(store).objectStore(store).count()
                : db.transaction(store).objectStore(store).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const [transfers, chunks, rows] = await Promise.all([
          get('transfers'),
          get('chunks', 'count'),
          Promise.resolve(document.querySelectorAll('#transfers .transfer').length),
        ]);
        return transfers.length === 0 && chunks === 0 && rows === 0;
      })()`,
    ),
  );
  log('清空接收区通过：界面清空，IndexedDB 中的传输元数据与数据块均已删除');

  client.close();
  cleanup();
}

async function verifyZipWithPython(zipPath) {
  const script = `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as zf:
    bad = zf.testzip()
    assert bad is None, f"CRC 校验失败: {bad}"
    print(json.dumps({i.filename: hashlib.sha256(zf.read(i.filename)).hexdigest()
                      for i in zf.infolist() if not i.is_dir()}))
`;
  const child = spawn('python3', ['-c', script, zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) {
    throw new Error(`python3 校验 ZIP 失败：${err.trim()}`);
  }
  return JSON.parse(out);
}

main().catch((error) => {
  console.error(`端到端验证失败：${error.message}`);
  cleanup();
  process.exitCode = 1;
});
