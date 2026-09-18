// 真实浏览器端到端验证（记录区模型）：
//
//   1. 构建并启动单产物服务器；
//   2. 打开两个标签页（等价于局域网里的两台设备）；
//   3. A 登记文件/文件夹 → B 刷新记录区就能看到，且**没有任何字节流动**；
//   4. B 点击「下载」→ 数据经服务器定向转发 → B 校验 SHA-256；
//   5. 校验通过后 B 仍然什么都没保存（savedCount 不变、下载目录为空）；
//   6. B 点「保存」/「打包下载」→ 文件真正落到磁盘，逐字节/逐条目核对；
//   7. 另外验证断点续传：预先在 B 的 IndexedDB 里放好首个分块，再点下载会从断点继续。
//
// 运行：node scripts/e2e-browser.mjs（需要本机有 firefox 与 python3）

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { sha256Hex } from '../web/lib/sha256.js';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'target/release/file_sharer');
const PORT = Number(process.env.E2E_PORT ?? 18099);
const BIDI_PORT = Number(process.env.E2E_BIDI_PORT ?? 9222);
const BASE = `http://127.0.0.1:${PORT}/`;
const DOWNLOAD_DIR = mkdtempSync(join(tmpdir(), 'file-sharer-downloads-'));

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
  for (;;) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待「${description}」超时${lastError ? `：${lastError.message}` : ''}`);
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// ---------------------------------------------------------------- 被测服务与浏览器

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} 退出码 ${code}`))));
  });
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
  writeFileSync(
    join(profile, 'user.js'),
    [
      'user_pref("browser.download.folderList", 2);',
      `user_pref("browser.download.dir", ${JSON.stringify(DOWNLOAD_DIR)});`,
      'user_pref("browser.download.useDownloadDir", true);',
      'user_pref("browser.download.alwaysOpenPanel", false);',
      'user_pref("browser.helperApps.neverAsk.saveToDisk", "application/zip,application/octet-stream,text/plain");',
      'user_pref("browser.download.manager.showWhenStarting", false);',
      '',
    ].join('\n'),
  );
  const child = spawn(
    'firefox',
    ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(BIDI_PORT), 'about:blank'],
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
        await sleep(250);
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

const CHUNK = 1024 * 1024;
const SINGLE = { path: '端到端测试.bin', bytes: sampleBytes(3000, 21) };
const RESUMABLE = { path: '续传测试.bin', bytes: sampleBytes(CHUNK * 2 + 4096, 22) };
const FOLDER = [
  { path: 'e2e目录/说明.txt', bytes: [...new TextEncoder().encode('记录区端到端验证')] },
  { path: 'e2e目录/子目录/数据.bin', bytes: [...sampleBytes(2048, 23)] },
];

// ---------------------------------------------------------------- 页面侧工具

async function registerEntries(client, context, specs, names) {
  // 注意：Uint8Array 直接 JSON 化会丢掉 length，必须显式转成普通数组
  const normalized = specs.map((spec) => ({ path: spec.path, bytes: Array.from(spec.bytes) }));
  return evaluate(
    client,
    context,
    `(async () => {
      const specs = ${JSON.stringify(normalized)};
      const entries = specs.map((spec) => {
        const name = spec.path.split('/').pop();
        const file = new File([new Uint8Array(spec.bytes)], name, { type: 'application/octet-stream' });
        Object.defineProperty(file, 'webkitRelativePath', { value: spec.path });
        return { file, path: spec.path };
      });
      await window.fileSharer.shareEntries(entries);
      return ${JSON.stringify(names)};
    })()`,
  );
}

async function registryState(client, context) {
  return evaluate(
    client,
    context,
    `(() => {
      const rows = [...window.fileSharer.state.entriesBySource.entries()].flatMap(([peerId, entries]) =>
        entries.map((entry) => ({
          peerId,
          shareId: entry.shareId,
          name: entry.name,
          kind: entry.kind,
          totalBytes: entry.totalBytes,
          files: entry.files.map((file) => ({ i: file.i, path: file.path, size: file.size })),
        })),
      );
      const transfers = [...window.fileSharer.state.transfers.values()].map((item) => ({
        shareId: item.entry.shareId,
        status: item.status,
        received: item.received,
        total: item.total,
        resumedBytes: item.resumedBytes ?? 0,
        saved: item.saved,
        peerId: item.peerId,
      }));
      const shared = [...window.fileSharer.state.shared.values()].map((entry) => ({ shareId: entry.shareId, name: entry.name }));
      return {
        rows,
        transfers,
        shared,
        savedCount: window.fileSharer.savedCount,
        activeStreams: window.fileSharer.shares.activeShareIds,
      };
    })()`,
  );
}

/** 走 <input webkitdirectory> 的真实 change 事件登记文件夹（等价于系统选择器选完后触发）。 */
async function registerFolderViaInput(client, context, specs) {
  const normalized = specs.map((spec) => ({ path: spec.path, bytes: Array.from(spec.bytes) }));
  return evaluate(
    client,
    context,
    `(async () => {
      const specs = ${JSON.stringify(normalized)};
      const input = document.getElementById('folder-input');
      const attributes = {
        webkitdirectory: input.hasAttribute('webkitdirectory'),
        webkitdirectorySupported: input.webkitdirectory === true,
        directory: input.hasAttribute('directory'),
        multiple: input.multiple,
        type: input.type,
      };
      const transfer = new DataTransfer();
      for (const spec of specs) {
        const name = spec.path.split('/').pop();
        const file = new File([new Uint8Array(spec.bytes)], name, { type: 'application/octet-stream' });
        Object.defineProperty(file, 'webkitRelativePath', { value: spec.path });
        transfer.items.add(file);
      }
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      return attributes;
    })()`,
  );
}

async function storedBytes(client, context, shareId, fileIndex) {
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
        .filter((chunk) => chunk.shareId === ${JSON.stringify(shareId)} && chunk.fileIndex === ${fileIndex})
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

async function clickDownload(client, context, name) {
  return evaluate(
    client,
    context,
    `(() => {
      const rows = [...document.querySelectorAll('#registry-list .row')];
      const row = rows.find((item) => item.querySelector('.row-title')?.textContent === ${JSON.stringify(name)});
      if (!row) {
        return false;
      }
      const button = [...row.querySelectorAll('button')].find((item) => item.textContent.includes('下载'));
      if (!button) {
        return false;
      }
      button.click();
      return true;
    })()`,
  );
}

async function clickAction(client, context, name, label) {
  return evaluate(
    client,
    context,
    `(() => {
      const rows = [...document.querySelectorAll('#registry-list .row')];
      const row = rows.find((item) => item.querySelector('.row-title')?.textContent === ${JSON.stringify(name)});
      if (!row) {
        return false;
      }
      const button = [...row.querySelectorAll('button')].find((item) => item.textContent.includes(${JSON.stringify(label)}));
      if (!button) {
        return false;
      }
      button.click();
      return true;
    })()`,
  );
}

async function waitDownloadedFile(name, { timeoutMs = 15_000 } = {}) {
  const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  return waitFor(
    `下载目录出现 ${name}`,
    async () => {
      const files = readdirSync(DOWNLOAD_DIR).filter(
        (file) => !file.endsWith('.part') && (file === name || file.startsWith(base)),
      );
      for (const file of files) {
        const bytes = readFileSync(join(DOWNLOAD_DIR, file));
        if (bytes.length > 0) {
          await sleep(200); // 等写入稳定
          return { name: file, bytes: readFileSync(join(DOWNLOAD_DIR, file)) };
        }
      }
      return null;
    },
    { timeoutMs },
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

async function verifyZipWithPython(zipPath) {
  const script = `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as zf:
    bad = zf.testzip()
    assert bad is None, f"CRC 校验失败: {bad}"
    print(json.dumps({i.filename: hashlib.sha256(zf.read(i.filename)).hexdigest()
                      for i in zf.infolist() if not i.is_dir()}))
`;
  const output = await new Promise((resolvePromise, reject) => {
    const child = spawn('python3', ['-c', script, zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code) => (code === 0 ? resolvePromise(out) : reject(new Error(err))));
  });
  return JSON.parse(output);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!process.env.E2E_SKIP_BUILD) {
    log('构建单产物…');
    await run('cargo', ['build', '--release'], { cwd: ROOT });
  }
  if (!existsSync(BIN)) {
    throw new Error(`缺少构建产物 ${BIN}`);
  }

  startServer();
  await waitFor('服务就绪', async () => (await fetch(`${BASE}api/health`)).ok, { timeoutMs: 15_000 });
  log(`被测服务已启动：${BASE}`);

  startFirefox();
  const client = createBidiClient(`ws://127.0.0.1:${BIDI_PORT}/session`, {
    onEvent: (message) => {
      if (message.method === 'log.entryAdded' && message.params.level === 'error') {
        log(`[浏览器错误] ${message.params.text}`);
      }
    },
  });
  await waitFor(
    'BiDi 会话',
    async () => {
      try {
        await client.call('session.new', { capabilities: {} });
        return true;
      } catch (error) {
        if (String(error.message).includes('session already exists')) {
          return true;
        }
        throw error;
      }
    },
    { timeoutMs: 20_000 },
  );
  await client.call('session.subscribe', { events: ['log.entryAdded'] });

  const tabA = await openTab(client, 'A（分享者）');
  const tabB = await openTab(client, 'B（下载者）');
  await waitFor('两侧都拿到会话 id', async () => {
    const [a, b] = await Promise.all([
      evaluate(client, tabA, `Boolean(window.fileSharer?.relay?.selfId)`),
      evaluate(client, tabB, `Boolean(window.fileSharer?.relay?.selfId)`),
    ]);
    return a && b;
  });

  // ------------------------------------------------ 1) 登记：只记录位置
  await registerEntries(client, tabA, [SINGLE], [SINGLE.path]);
  await sleep(300);

  const afterShare = await registryState(client, tabA);
  assertSingleShared(afterShare, SINGLE.path);

  await clickRefresh(client, tabB);
  await waitFor('B 的记录区出现条目', async () => {
    const state = await registryState(client, tabB);
    return state.rows.find((row) => row.name === SINGLE.path);
  });
  log('B 已通过拉取看到 A 登记的条目');

  // 关键不变量：没有点击下载之前，B 没有任何传输状态、没有任何落盘数据、A 没有开流
  const idleB = await registryState(client, tabB);
  const idleA = await registryState(client, tabA);
  if (idleB.transfers.length !== 0 || idleB.savedCount !== 0) {
    throw new Error('未点击下载前不应有任何传输状态');
  }
  if (idleA.activeStreams.length !== 0) {
    throw new Error('未点击下载前分享者不应开流');
  }
  const idleBytes = await storedBytes(client, tabB, idleB.rows[0].shareId, 0);
  if (idleBytes.chunks !== 0) {
    throw new Error('未点击下载前不应有任何数据落盘');
  }
  const downloadsBefore = readdirSync(DOWNLOAD_DIR).length;
  if (downloadsBefore !== 0) {
    throw new Error('未点击下载前下载目录应为空');
  }
  log('未点击下载：记录区只有登记项，零传输、零落盘、下载目录为空');

  // ------------------------------------------------ 2) 点击下载 → 定向转发 → 校验
  const entryB = (await registryState(client, tabB)).rows[0];
  if (!(await clickDownload(client, tabB, SINGLE.path))) {
    throw new Error('找不到「下载」按钮');
  }
  try {
    await waitFor('B 完成接收并校验通过', async () => {
      const state = await registryState(client, tabB);
      const transfer = state.transfers.find((item) => item.shareId === entryB.shareId);
      return transfer && transfer.status === 'verified' ? transfer : null;
    });
  } catch (error) {
    await dumpDiagnostics(client, { tabA, tabB });
    throw error;
  }
  const received = await storedBytes(client, tabB, entryB.shareId, 0);
  assertBytesEqual(received.bytes, [...SINGLE.bytes], '单文件内容');
  log(`单文件传输完成：${SINGLE.bytes.length} 字节经服务器定向转发，接收端 SHA-256 校验通过`);

  // ------------------------------------------------ 3) 校验通过 ≠ 自动下载
  const verifiedState = await registryState(client, tabB);
  if (verifiedState.savedCount !== 0) {
    throw new Error('校验通过后不应自动保存');
  }
  if (readdirSync(DOWNLOAD_DIR).length !== 0) {
    throw new Error('没有点击保存之前，下载目录必须为空');
  }
  const removeButton = await evaluate(
    client,
    tabB,
    `(() => {
      const rows = [...document.querySelectorAll('#registry-list .row')];
      const row = rows.find((item) => item.querySelector('.row-title')?.textContent === ${JSON.stringify(SINGLE.path)});
      if (!row) {
        return 'missing-row';
      }
      return [...row.querySelectorAll('button')].map((item) => item.textContent).join(',');
    })()`,
  );
  if (String(removeButton).includes('删除')) {
    throw new Error(`完成后的操作里不应再有删除按钮：${removeButton}`);
  }
  if (!(await clickAction(client, tabB, SINGLE.path, '保存'))) {
    throw new Error('找不到「保存」按钮');
  }
  let downloaded;
  try {
    await waitFor('界面记录 savedCount=1', async () => {
      const state = await registryState(client, tabB);
      return state.savedCount === 1;
    });
    downloaded = await waitDownloadedFile(SINGLE.path);
  } catch (error) {
    const diagnostic = await evaluate(
      client,
      tabB,
      `(() => ({
        toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
        lastError: window.fileSharer.state.lastError ?? '',
        savedCount: window.fileSharer.savedCount,
      }))()`,
    );
    log(`[诊断] 下载目录内容：${JSON.stringify(readdirSync(DOWNLOAD_DIR))}`);
    log(`[诊断] 页面状态：${JSON.stringify(diagnostic)}`);
    throw error;
  }
  assertBytesEqual([...downloaded.bytes], [...SINGLE.bytes], '保存到磁盘的文件');
  log(`点「保存」后才落盘：${downloaded.name} 与源文件逐字节一致，且此前 savedCount=0`);

  // ------------------------------------------------ 4) 文件夹 + ZIP
  const folderAttributes = await registerFolderViaInput(client, tabA, FOLDER);
  if (
    !folderAttributes.webkitdirectory ||
    !folderAttributes.webkitdirectorySupported ||
    !folderAttributes.directory ||
    !folderAttributes.multiple
  ) {
    throw new Error(`文件夹输入框缺少目录属性：${JSON.stringify(folderAttributes)}`);
  }
  await clickRefresh(client, tabB);
  const folderRow = await waitFor('B 看到文件夹条目', async () => {
    const state = await registryState(client, tabB);
    return state.rows.find((row) => row.kind === 'folder');
  });
  if (!(await clickDownload(client, tabB, folderRow.name))) {
    throw new Error('找不到文件夹记录的「下载」按钮');
  }
  await waitFor('文件夹传输完成', async () => {
    const state = await registryState(client, tabB);
    const transfer = state.transfers.find((item) => item.shareId === folderRow.shareId);
    return transfer?.status === 'verified';
  });
  for (const [index, spec] of FOLDER.entries()) {
    // 索引顺序按路径排序，必须按路径找 fileIndex
    const fileIndex = folderRow.files.find((file) => file.path === spec.path)?.i;
    if (fileIndex === undefined) {
      throw new Error(`记录里找不到 ${spec.path}`);
    }
    const stored = await storedBytes(client, tabB, folderRow.shareId, fileIndex);
    assertBytesEqual(stored.bytes, spec.bytes, `文件夹内容 ${spec.path}`);
    void index;
  }
  // 文件夹完成后：必须有「保存整个文件夹」，且不能有只能保存第一个文件的「保存」
  const folderButtons = await evaluate(
    client,
    tabB,
    `(() => {
      const rows = [...document.querySelectorAll('#registry-list .row')];
      const row = rows.find((item) => item.querySelector('.row-title')?.textContent === ${JSON.stringify(folderRow.name)});
      return row ? [...row.querySelectorAll('button')].map((item) => item.textContent) : null;
    })()`,
  );
  if (!folderButtons) {
    throw new Error('找不到文件夹记录行');
  }
  if (!folderButtons.includes('保存整个文件夹')) {
    throw new Error(`文件夹行缺少「保存整个文件夹」按钮：${JSON.stringify(folderButtons)}`);
  }
  if (folderButtons.includes('保存')) {
    throw new Error(`文件夹行不应再有只保存第 1 个文件的「保存」按钮：${JSON.stringify(folderButtons)}`);
  }

  if (!(await clickAction(client, tabB, folderRow.name, '保存整个文件夹'))) {
    throw new Error('找不到「保存整个文件夹」按钮');
  }
  const zipFile = await waitDownloadedFile('e2e目录.zip');
  const zipReport = await verifyZipWithPython(join(DOWNLOAD_DIR, zipFile.name));
  for (const spec of FOLDER) {
    if (zipReport[spec.path] !== sha256Hex(new Uint8Array(spec.bytes))) {
      throw new Error(`ZIP 中 ${spec.path} 内容不符`);
    }
  }
  const zipProgress = await evaluate(
    client,
    tabB,
    `window.fileSharer.state.lastZipProgress ?? null`,
  );
  if (!zipProgress || zipProgress.processedBytes !== folderRow.totalBytes) {
    throw new Error(`打包进度未按整包字节上报：${JSON.stringify(zipProgress)} != ${folderRow.totalBytes}`);
  }
  log(
    `文件夹保存通过：点「保存整个文件夹」得到完整文件夹（${FOLDER.length} 个文件保留目录结构，` +
      `ZIP 由 python3 解压校验一致，打包进度上报到 ${zipProgress.processedBytes}/${zipProgress.totalBytes} 字节）`,
  );

  // ------------------------------------------------ 5) 断点续传（真实 IndexedDB）
  await registerEntries(client, tabA, [RESUMABLE], [RESUMABLE.path]);
  await clickRefresh(client, tabB);
  const resumableRow = await waitFor('B 看到续传测试条目', async () => {
    const state = await registryState(client, tabB);
    return state.rows.find((row) => row.name === RESUMABLE.path);
  });

  // 预先在 B 的 IndexedDB 里放好第 0 分块（内容正确），模拟"上次断点"
  const resumeManifest = {
    shareId: resumableRow.shareId,
    files: [
      {
        i: 0,
        path: RESUMABLE.path,
        size: RESUMABLE.bytes.length,
        sha256: sha256Hex(RESUMABLE.bytes),
        mime: 'application/octet-stream',
      },
    ],
  };
  await evaluate(
    client,
    tabB,
    `(async () => {
      const shareId = ${JSON.stringify(resumableRow.shareId)};
      // 与 Node 侧同一套确定性随机数，重建第 0 分块
      const bytes = new Uint8Array(${CHUNK});
      let state = 22 >>> 0;
      for (let i = 0; i < bytes.length; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        bytes[i] = state & 0xff;
      }
      const store = window.fileSharer.store;
      await store.saveManifest(${JSON.stringify(resumeManifest)});
      await store.putChunk({ shareId, fileIndex: 0, chunkIndex: 0, bytes });
      return true;
    })()`,
  );

  if (!(await clickDownload(client, tabB, RESUMABLE.path))) {
    throw new Error('找不到续传记录的「下载」按钮');
  }
  const resumed = await waitFor('续传完成', async () => {
    const state = await registryState(client, tabB);
    const transfer = state.transfers.find((item) => item.shareId === resumableRow.shareId);
    return transfer?.status === 'verified' ? transfer : null;
  });
  const resumedBytes = await storedBytes(client, tabB, resumableRow.shareId, 0);
  assertBytesEqual(resumedBytes.bytes, [...RESUMABLE.bytes], '续传后的文件内容');
  if (!(resumed.resumedBytes >= CHUNK)) {
    throw new Error(`续传应当跳过已收分块，实际 resumedBytes=${resumed.resumedBytes}`);
  }
  log(
    `断点续传通过：预先存在 IndexedDB 的 ${resumed.resumedBytes} 字节被跳过，只补传剩余部分，最终校验一致`,
  );

  log('端到端全部通过：记录区只登记位置 → 点击才传输 → 校验通过仍需显式保存 → 服务器只转发');
  client.close();
  cleanup();
}

async function clickRefresh(client, context) {
  await evaluate(client, context, `(document.getElementById('refresh').click(), true)`);
  await sleep(150);
}

async function dumpDiagnostics(client, tabs) {
  for (const [label, context] of Object.entries(tabs)) {
    const dump = await evaluate(
      client,
      context,
      `(() => ({
        self: window.fileSharer.relay?.selfId,
        boundTo: window.fileSharer.relay?.boundTo,
        shared: [...window.fileSharer.state.shared.keys()].map((id) => id.slice(0, 8)),
        activeStreams: window.fileSharer.shares?.activeShareIds ?? [],
        transfers: [...window.fileSharer.state.transfers.values()].map((item) => [
          item.entry.shareId.slice(0, 8), item.status, item.received, item.total, item.error ?? '',
        ]),
        log: window.fileSharer.state.log.slice(-14),
      }))()`,
    );
    log(`[诊断 ${label}] ${JSON.stringify(dump)}`);
  }
}

function assertSingleShared(state, name) {
  if (state.shared.length !== 1) {
    throw new Error(`分享者应有 1 条登记，实际 ${state.shared.length}`);
  }
  if (state.shared[0].name !== name) {
    throw new Error(`登记名不符：${state.shared[0].name} != ${name}`);
  }
  if (state.activeStreams.length !== 0) {
    throw new Error('登记本身不应开流');
  }
}

main().catch((error) => {
  console.error(`端到端验证失败：${error.message}`);
  cleanup();
  process.exitCode = 1;
});
