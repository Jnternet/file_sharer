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
  const received = await evaluate(
    client,
    tabB,
    `(async () => {
      const open = indexedDB.open('file-sharer', 1);
      const db = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const transfers = await new Promise((resolve, reject) => {
        const request = db.transaction('transfers').objectStore('transfers').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const latest = transfers.at(-1);
      const chunks = await new Promise((resolve, reject) => {
        const request = db.transaction('chunks').objectStore('chunks').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const ordered = chunks
        .filter((chunk) => chunk.transferId === latest.transferId && chunk.fileIndex === 0)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      const out = new Uint8Array(ordered.reduce((sum, chunk) => sum + chunk.size, 0));
      let offset = 0;
      for (const chunk of ordered) {
        out.set(new Uint8Array(chunk.bytes), offset);
        offset += chunk.size;
      }
      return { path: latest.manifest.files[0].path, bytes: [...out], chunks: ordered.length };
    })()`,
  );

  const expected = [...SAMPLE];
  if (received.path !== SAMPLE_NAME) {
    throw new Error(`文件名不符：${received.path} != ${SAMPLE_NAME}`);
  }
  if (received.bytes.length !== expected.length) {
    throw new Error(`长度不符：${received.bytes.length} != ${expected.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (received.bytes[i] !== expected[i]) {
      throw new Error(`第 ${i} 字节不符：${received.bytes[i]} != ${expected[i]}`);
    }
  }

  log(
    `端到端通过：${SAMPLE_NAME}（${SAMPLE.length} 字节，${received.chunks} 块）经 WebRTC 直传，` +
      `接收端哈希校验通过且逐字节一致，服务器未参与数据搬运`,
  );

  client.close();
  cleanup();
}

main().catch((error) => {
  console.error(`端到端验证失败：${error.message}`);
  cleanup();
  process.exitCode = 1;
});
