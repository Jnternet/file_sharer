// 界面接线：记录区（只登记文件位置）→ 点击下载 → 传输 → 显式保存。
//
// 这里只做接线与渲染；协议、服务、传输核心都在 lib/ 下（有 Node 测试覆盖）。

import { createRelayClient } from './lib/relay-client.js';
import { createIndexedDbStore } from './lib/idb-store.js';
import { createMemoryStore } from './lib/store-memory.js';
import { createShareService } from './lib/share-service.js';
import { createDownloadService } from './lib/download-service.js';
import { Sender } from './lib/sender.js';
import { buildShareEntry, describeEntry } from './lib/share-index.js';
import {
  entriesFromDataTransfer,
  entriesFromDirectoryHandle,
  entriesFromFileList,
  selectionHasDirectoryStructure,
  sourceFromEntries,
  supportsDirectoryPicker,
} from './lib/files.js';
import { DEFAULT_CHUNK_SIZE } from './lib/plan.js';
import { KIND, indexRequestMessage } from './lib/protocol.js';
import { buildStoreZip, safeFileName, zipNameFor } from './lib/zip.js';
import { detectPlatform } from './lib/platform.js';

const $ = (id) => document.getElementById(id);
const NAME_KEY = 'file-sharer:name';
const REFRESH_MS = 3000;
const ACK_FLUSH_MS = 150;

const state = {
  self: null,
  sessions: [],
  entriesBySource: new Map(), // peerId -> entry[]
  transfers: new Map(), // shareId -> { entry, peerId, status, received, total, error, saved }
  shared: new Map(), // shareId -> entry
  busyHashing: false,
  savedCount: 0,
  log: [], // 最近的事件（排查与自动化用）
};

const platform = detectPlatform();

function recordEvent(source, event) {
  if (state.log.length > 400) {
    state.log.shift();
  }
  state.log.push({ at: Date.now(), source, type: event.type, detail: summarizeEvent(event) });
}

function summarizeEvent(event) {
  if (event.error) {
    return `${event.error.code ?? ''} ${event.error.message ?? event.error}`.trim();
  }
  if (event.shareId) {
    return `${event.shareId.slice(0, 8)}${event.status ? ` ${event.status}` : ''}`;
  }
  if (event.from) {
    return `${event.from} ${event.payload?.k ?? ''}`;
  }
  if (event.message?.k) {
    return event.message.k;
  }
  return '';
}

let relay;
let store;
let shares;
let downloads;

// ---------------------------------------------------------------- 启动

async function boot() {
  $('name-input').value = localStorage.getItem(NAME_KEY) ?? '';
  store = await openStore();
  relay = createRelayClient({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    name: displayName(),
    onEvent: handleRelayEvent,
  });
  shares = createShareService({
    relay,
    senderName: displayName(),
    onEvent: handleShareEvent,
    senderFactory: ({ source, channel }) =>
      new Sender({ source, channel, chunkSize: DEFAULT_CHUNK_SIZE, onEvent: handleShareEvent }),
  });
  downloads = createDownloadService({
    relay,
    store,
    ackIntervalBytes: 2 * 1024 * 1024,
    onEvent: handleDownloadEvent,
  });

  wireUi();
  relay.connect();
  setInterval(() => void refreshRegistry(), REFRESH_MS);
  setInterval(() => void downloads.flushAcks(), ACK_FLUSH_MS);
  void loadServerInfo();
  renderAll();
}

async function openStore() {
  try {
    return await createIndexedDbStore();
  } catch (error) {
    toast(`IndexedDB 不可用（${error.message}），本次会话内仍可续传，刷新后会丢失`);
    return createMemoryStore();
  }
}

async function loadServerInfo() {
  try {
    const info = await (await fetch('/api/info')).json();
    $('server-info').textContent =
      `服务器 v${info.version} · 在线会话 ${info.sessions}/${info.max_sessions} · ` +
      `持久化：${info.persistence === 'none' ? '无' : info.persistence} · ` +
      `文件记录：${info.records === 'none' ? '无（只转发）' : info.records}`;
  } catch {
    $('server-info').textContent = '无法读取服务器信息';
  }
}

function displayName() {
  const typed = $('name-input').value.trim();
  return (typed || `访客-${Math.random().toString(36).slice(2, 6)}`).slice(0, 32);
}

// ---------------------------------------------------------------- 事件接线

function handleRelayEvent(event) {
  recordEvent('relay', event);
  switch (event.type) {
    case 'open':
      setStatus('warn', '已连接，正在拉取…');
      break;
    case 'welcome':
      state.self = event.self;
      setStatus('ok', `在线（${event.self?.name ?? ''}）`);
      void refreshRegistry();
      break;
    case 'relay':
      void shares.handlePayload(event.from, event.payload);
      void downloads.handlePayload(event.from, event.payload);
      handleIndexPayload(event.from, event.payload);
      break;
    case 'binary':
      downloads.handleBinary(event.bytes);
      break;
    case 'closed':
      state.self = null;
      state.sessions = [];
      state.entriesBySource.clear();
      for (const transfer of state.transfers.values()) {
        if (transfer.status === 'receiving') {
          transfer.status = 'paused';
          transfer.error = '连接断开，可稍后重试';
        }
      }
      setStatus('err', '与服务器断开，正在重连…');
      renderAll();
      break;
    case 'error':
      toast(`服务器：${event.code} ${event.message}`);
      break;
    default:
      break;
  }
}

function handleIndexPayload(from, payload) {
  if (!payload || payload.k !== KIND.INDEX) {
    return;
  }
  state.entriesBySource.set(from, payload.entries ?? []);
  renderRegistry();
}

function handleShareEvent(event) {
  recordEvent('share', event);
  if (event.type === 'download-started') {
    toast(`有人开始下载「${entryName(event.shareId)}」，正在传输`);
  } else if (event.type === 'serve-failed') {
    toast(`向对方发送「${entryName(event.shareId)}」失败：${event.error?.message ?? '未知错误'}`);
  }
}

function handleDownloadEvent(event) {
  recordEvent('download', event);
  const shareId = event.shareId;
  const transfer = shareId ? state.transfers.get(shareId) : null;
  switch (event.type) {
    case 'requested': {
      const known = state.transfers.get(shareId);
      if (known) {
        known.status = 'receiving';
        known.received = 0;
      }
      break;
    }
    case 'manifest':
      if (transfer) {
        transfer.status = 'receiving';
        transfer.resumedBytes = event.resumedBytes;
        transfer.total = event.manifest.totalBytes;
        transfer.fileCount = event.manifest.files.length;
      }
      break;
    case 'progress':
      if (transfer) {
        transfer.received = event.transferReceived;
        transfer.total = event.transferTotal;
        transfer.status = 'receiving';
      }
      break;
    case 'complete':
      if (transfer) {
        transfer.status = 'verified';
        transfer.received = transfer.total;
        transfer.finishedAt = Date.now();
      }
      toast(`「${entryName(shareId)}」接收完成并通过 SHA-256 校验，点「保存」才会落到磁盘`);
      break;
    case 'file-done':
      if (transfer && event.status === 'hash-mismatch') {
        transfer.error = '校验失败，正在要求重传';
      }
      break;
    case 'cancelled':
      if (transfer) {
        transfer.status = 'paused';
        transfer.error = `对端取消：${event.reason}`;
      }
      break;
    case 'remote-error':
      if (transfer) {
        transfer.status = 'failed';
        transfer.error = `${event.code}：${event.message}`;
      }
      break;
    case 'peer-closed':
      for (const item of state.transfers.values()) {
        if (item.peerId === event.peerId && item.status === 'receiving') {
          item.status = 'paused';
          item.error = '对端离线';
        }
      }
      break;
    default:
      return;
  }
  renderRegistry();
}

// ---------------------------------------------------------------- 记录区

async function refreshRegistry() {
  if (!relay?.connected) {
    return;
  }
  try {
    const sessions = await relay.listSessions();
    state.sessions = sessions;
    const ids = new Set(sessions.map((session) => session.id));
    for (const id of [...state.entriesBySource.keys()]) {
      if (!ids.has(id)) {
        state.entriesBySource.delete(id);
      }
    }
    for (const session of sessions) {
      relay.relay(session.id, indexRequestMessage());
    }
    renderPeers();
    renderRegistry();
  } catch (error) {
    toast(`拉取记录区失败：${error.message}`);
  }
}

function registryRows() {
  const rows = [];
  for (const [peerId, entries] of state.entriesBySource) {
    for (const entry of entries) {
      rows.push({ peerId, entry, transfer: state.transfers.get(entry.shareId) });
    }
  }
  return rows.sort((a, b) => (b.entry.createdAt ?? 0) - (a.entry.createdAt ?? 0));
}

/** 用户点击「下载」：只有这一条路径会触发传输。 */
function requestDownload(peerId, entry) {
  const existing = state.transfers.get(entry.shareId);
  if (existing && (existing.status === 'receiving' || existing.status === 'requested')) {
    return;
  }
  try {
    state.transfers.set(entry.shareId, {
      entry,
      peerId,
      status: 'requested',
      received: 0,
      total: entry.totalBytes,
      error: null,
      saved: false,
    });
    downloads.request(peerId, entry);
    renderRegistry();
  } catch (error) {
    toast(`无法开始下载：${error.message}`);
  }
}

/** 用户点击「保存」：这才是真正落盘的一步（绝不自动触发）。 */
async function saveTransfer(shareId) {
  const transfer = state.transfers.get(shareId);
  if (!transfer) {
    return;
  }
  try {
    const bytes = await collect(downloads.readChunks(shareId, 0));
    triggerDownload(
      new Blob([bytes], { type: transfer.entry.files[0]?.mime ?? 'application/octet-stream' }),
      safeFileName(transfer.entry.files[0]?.path ?? transfer.entry.name),
    );
    transfer.saved = true;
    state.savedCount += 1;
    renderRegistry();
  } catch (error) {
    toast(`保存失败：${error.message}`);
  }
}

async function saveZip(shareId) {
  const transfer = state.transfers.get(shareId);
  if (!transfer) {
    return;
  }
  if (transfer.zip?.status === 'packing') {
    return;
  }
  transfer.zip = { status: 'packing', processedBytes: 0, totalBytes: transfer.entry.totalBytes };
  renderRegistry(true);
  try {
    const zip = await buildZipFor(shareId, {
      onProgress: ({ processedBytes, totalBytes }) => {
        transfer.zip = { status: 'packing', processedBytes, totalBytes };
        state.lastZipProgress = { processedBytes, totalBytes };
        renderRegistry(true);
      },
    });
    triggerDownload(new Blob([zip], { type: 'application/zip' }), zipNameFor(transfer.entry.files.map((file) => file.path)));
    transfer.zip = {
      status: 'done',
      processedBytes: transfer.entry.totalBytes,
      totalBytes: transfer.entry.totalBytes,
    };
    transfer.saved = true;
    state.savedCount += 1;
    renderRegistry();
  } catch (error) {
    transfer.zip = { status: 'failed', error: error.message };
    renderRegistry();
    if (error.code === 'too-large') {
      toast('文件夹超过 4 GiB，ZIP 不可用：请用下面的文件列表逐个保存');
      return;
    }
    toast(`打包失败：${error.message}`);
  }
}

function folderFileEntries(shareId, transfer) {
  return transfer.entry.files
    .slice()
    .sort((a, b) => a.i - b.i)
    .map((file) => ({
      path: file.path,
      size: file.size,
      chunks: () => downloads.readChunks(shareId, file.i),
    }));
}

async function buildZipFor(shareId, { onProgress } = {}) {
  const transfer = state.transfers.get(shareId);
  if (!transfer) {
    throw new Error(`找不到记录 ${shareId}`);
  }
  return buildStoreZip(folderFileEntries(shareId, transfer), { onProgress });
}

/**
 * 选择文件夹：
 *  1) 能用 File System Access（https/localhost）就直接选目录，结构最可靠；
 *  2) 否则用 <input webkitdirectory>（Chromium/Firefox 都支持）；
 *  3) 都不支持时明确提示可以拖放文件夹。
 */
async function pickFolder() {
  if (supportsDirectoryPicker()) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      const entries = await entriesFromDirectoryHandle(handle);
      if (entries.length === 0) {
        toast('这个文件夹里没有文件');
        return;
      }
      await shareEntries(entries);
      return;
    } catch (error) {
      if (error?.name === 'AbortError') {
        return;
      }
      toast(`目录选择不可用（${error?.message ?? error}），改用系统文件夹选择器`);
    }
  }

  const input = $('folder-input');
  // 用属性值判断真实支持，避免某些浏览器给出"能选文件但选不了文件夹"的假象
  if (input.webkitdirectory !== true) {
    toast('这个浏览器不支持"选择文件夹"：把文件夹直接拖到上方区域即可（同样保留目录结构）');
    return;
  }
  // 有些引擎在点击时才决定对话框模式，这里把属性再显式设置一遍
  input.setAttribute('webkitdirectory', '');
  input.webkitdirectory = true;
  input.multiple = true;
  input.click();
}

// ---------------------------------------------------------------- 登记（只记录位置）

async function shareEntries(entries, { note } = {}) {
  if (state.busyHashing) {
    toast('上一次登记还在进行中');
    return;
  }
  state.busyHashing = true;
  $('hash-progress').hidden = false;
  try {
    const { entry, source } = await buildShareEntry({
      entries,
      sourceFactory: sourceFromEntries,
      chunkSize: DEFAULT_CHUNK_SIZE,
      onProgress: ({ processedBytes, totalBytes }) => {
        $('hash-bar').value = totalBytes === 0 ? 100 : Math.round((processedBytes / totalBytes) * 100);
      },
    });
    shares.add(entry, source);
    state.shared.set(entry.shareId, entry);
    toast(
      note
        ? `已登记「${entry.name}」：${note}`
        : `已登记「${entry.name}」：只记录了文件位置，等对方点击下载时才传输`,
    );
    renderShared();
  } catch (error) {
    toast(`登记失败：${error.message}`);
  } finally {
    state.busyHashing = false;
    $('hash-progress').hidden = true;
    $('hash-bar').value = 0;
  }
}

function removeShare(shareId) {
  const entry = state.shared.get(shareId);
  shares.remove(shareId);
  state.shared.delete(shareId);
  toast(`已取消登记「${entry?.name ?? shareId}」`);
  renderShared();
}

// ---------------------------------------------------------------- 下载落盘

async function collect(iterable) {
  const source = await iterable; // 兼容 Promise<AsyncIterable>
  const parts = [];
  let total = 0;
  for await (const chunk of source) {
    parts.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------- 渲染

function setStatus(kind, text) {
  const element = $('conn-status');
  element.className = `pill pill-${kind}`;
  element.textContent = text;
}

function entryName(shareId) {
  return (
    state.transfers.get(shareId)?.entry?.name ??
    state.shared.get(shareId)?.name ??
    shareId.slice(0, 8)
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function button(label, onClick, extraClass = 'btn btn-small') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = extraClass;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function renderAll() {
  renderPeers();
  renderShared();
  renderRegistry();
}

function renderPeers() {
  const list = $('peer-list');
  list.innerHTML = '';
  $('peer-count').textContent = String(state.sessions.length);
  for (const session of state.sessions) {
    const item = document.createElement('li');
    item.className = 'row';
    const head = document.createElement('div');
    head.className = 'row-head';
    const title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = session.name;
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    const count = state.entriesBySource.get(session.id)?.length;
    meta.textContent = `${session.id}${count === undefined ? '' : ` · 登记 ${count} 项`}`;
    head.append(title, meta);
    item.append(head);
    list.append(item);
  }
  if (state.sessions.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = '暂无其他在线设备：同一局域网的另一台设备打开本页即可互相看到。';
    list.append(empty);
  }
}

function renderShared() {
  const list = $('shared-list');
  list.innerHTML = '';
  const entries = [...state.shared.values()].sort((a, b) => b.createdAt - a.createdAt);
  $('shared-empty').hidden = entries.length > 0;
  for (const entry of entries) {
    const item = document.createElement('li');
    item.className = 'row';
    item.innerHTML = `<div class="row-head">
        <span class="row-title"></span>
        <span class="row-meta"></span>
      </div>
      <div class="row-actions"></div>`;
    item.querySelector('.row-title').textContent = entry.name;
    item.querySelector('.row-meta').textContent =
      `${describeEntry(entry)} · ${formatBytes(entry.totalBytes)} · ` +
      `shareId ${entry.shareId.slice(0, 8)} · 等待下载`;
    item.querySelector('.row-actions').append(
      button('取消登记', () => removeShare(entry.shareId), 'btn btn-ghost btn-small'),
    );
    list.append(item);
  }
}

let lastRegistryRenderAt = 0;

/** light=true 时做节流：打包/写入进度每块都会回调，不必每块都重排整个列表。 */
function renderRegistry(light = false) {
  const now = Date.now();
  if (light && now - lastRegistryRenderAt < 120) {
    return;
  }
  lastRegistryRenderAt = now;
  const list = $('registry-list');
  list.innerHTML = '';
  const rows = registryRows();
  $('registry-empty').hidden = rows.length > 0;

  for (const { peerId, entry, transfer } of rows) {
    const item = document.createElement('li');
    item.className = 'row';
    item.innerHTML = `<div class="row-head">
        <span class="row-title"></span>
        <span class="row-meta"></span>
        <span class="hash"></span>
      </div>
      <progress max="100" value="0" hidden></progress>
      <div class="row-actions"></div>`;
    item.querySelector('.row-title').textContent = entry.name;
    const owner = state.sessions.find((session) => session.id === peerId)?.name ?? peerId;
    item.querySelector('.row-meta').textContent = `${describeEntry(entry)} · ${formatBytes(entry.totalBytes)} · 来自 ${owner}`;
    item.querySelector('.hash').textContent = `sha256 ${entry.files[0]?.sha256?.slice(0, 12) ?? ''}…`;

    const progress = item.querySelector('progress');
    const actions = item.querySelector('.row-actions');
    const status = transfer?.status ?? 'idle';

    if (status === 'receiving' || status === 'requested') {
      const percent = transfer.total > 0 ? Math.min(100, Math.round((transfer.received / transfer.total) * 100)) : 0;
      progress.hidden = false;
      progress.value = percent;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent =
        transfer.status === 'requested' ? '已请求，等待对方开始…' : `下载中 ${percent}%`;
      actions.append(tag);
    } else if (status === 'verified') {
      const packing = transfer.zip?.status === 'packing' ? transfer.zip : null;
      progress.hidden = false;
      if (packing) {
        const percent =
          packing.totalBytes > 0
            ? Math.min(100, Math.round((packing.processedBytes / packing.totalBytes) * 100))
            : 100;
        progress.value = percent;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = `打包中 ${percent}%`;
        actions.append(tag);
      } else {
        progress.value = 100;
        const tag = document.createElement('span');
        tag.className = 'tag tag-ok';
        tag.textContent = transfer.saved ? '已下载' : '已校验（未保存）';
        actions.append(tag);
        if (entry.kind === 'folder') {
          // 文件夹只保留打包下载：ZIP 里就是完整目录结构
          actions.append(
            button('打包下载 .zip', () => void saveZip(entry.shareId)),
          );
        } else {
          actions.append(button('保存', () => void saveTransfer(entry.shareId)));
        }
      }
    } else {
      const tag = document.createElement('span');
      tag.className = status === 'failed' ? 'tag tag-err' : 'tag';
      tag.textContent =
        status === 'failed'
          ? `失败：${transfer.error ?? ''}`
          : status === 'paused'
            ? `已暂停：${transfer.error ?? '可重试'}`
            : '未下载';
      actions.append(tag);
      actions.append(button(status === 'idle' ? '下载' : '继续下载', () => requestDownload(peerId, entry)));
    }

    if (status === 'verified' && entry.kind === 'folder') {
      for (const file of entry.files) {
        const row = document.createElement('div');
        row.className = 'row-meta';
        row.textContent = `${file.path} · ${formatBytes(file.size)}`;
        item.append(row);
      }
    }

    list.append(item);
  }
}

function toast(message) {
  state.lastError = message; // 便于排查与自动化断言
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 6000);
}

// ---------------------------------------------------------------- 交互

function wireUi() {
  const dropzone = $('dropzone');

  // 手机（或浏览器不支持目录选择）时不展示「登记文件夹」入口
  if (platform.shouldHideFolderButton) {
    $('pick-folder').hidden = true;
    $('mobile-hint').hidden = false;
    $('folder-input').disabled = true;
  }

  dropzone.addEventListener('click', (event) => {
    if (event.target.closest('button')) {
      return;
    }
    $('file-input').click();
  });
  $('pick-file').addEventListener('click', () => $('file-input').click());
  $('pick-folder').addEventListener('click', () => void pickFolder());

  for (const inputId of [
    ['file-input', false],
    ['folder-input', true],
  ]) {
    $(inputId[0]).addEventListener('change', (event) => {
      const entries = entriesFromFileList(event.target.files);
      const isFolderInput = inputId[1];
      const hasStructure = selectionHasDirectoryStructure(event.target.files);
      event.target.value = '';
      if (entries.length > 0) {
        if (isFolderInput && !hasStructure) {
          // 系统弹的其实是"选择文件"对话框（Linux 上常见）：登记照做，但要讲清楚限制与替代方案
          highlightDropzoneForFallback();
          void shareEntries(entries, {
            note:
              `系统弹出的是"选择文件"对话框（Linux 上常见），已按 ${entries.length} 个文件登记、` +
              '不保留子目录；要保留完整目录结构，请把文件夹直接拖进来',
          });
          return;
        }
        void shareEntries(entries);
        return;
      }
      if (isFolderInput) {
        // Firefox 已知问题（Bug 1354580）：文件夹名含中文/非 ASCII 时返回空列表。
        // 这种情况不能静默失败，必须告诉用户可用的替代办法。
        explainEmptyFolderSelection();
      }
    });
  }

  if ((platform.isFirefox || platform.isLinux) && !platform.isMobile) {
    $('folder-compat-hint').hidden = false;
  }

  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragging');
    });
  }
  dropzone.addEventListener('drop', (event) => {
    void (async () => {
      const entries = await entriesFromDataTransfer(event.dataTransfer);
      if (entries.length === 0) {
        toast('没有识别到文件');
        return;
      }
      await shareEntries(entries);
    })();
  });

  $('name-input').addEventListener('change', (event) => {
    localStorage.setItem(NAME_KEY, event.target.value.trim().slice(0, 32));
    toast('名字已保存，刷新页面后生效');
  });
  $('refresh').addEventListener('click', () => void refreshRegistry());

  window.addEventListener('beforeunload', () => relay?.close());
}

/** 文件夹选择拿到空列表时的解释与引导（Firefox 中文文件夹名的已知问题）。 */
function explainEmptyFolderSelection() {
  const dropzone = $('dropzone');
  dropzone.classList.add('needs-drop');
  $('folder-compat-hint').hidden = false;
  setTimeout(() => dropzone.classList.remove('needs-drop'), 6000);
  dropzone.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast(
    platform.isFirefox
      ? '没有读到文件夹内容：Firefox 对含中文/非 ASCII 名称的文件夹有已知问题（返回空列表）。' +
          '请把文件夹直接拖到上方区域（推荐，拖放不受影响），或改用 Chrome/Edge，' +
          '也可以用「登记文件」多选该文件夹里的文件。'
      : '没有读到文件夹内容：可能是空文件夹，或浏览器没有授权目录访问。' +
          '可以试试把文件夹直接拖到上方区域，或用「登记文件」多选文件。',
  );
}

/** 高亮登记区、常驻提示：引导用户改用拖放保留目录结构。 */
function highlightDropzoneForFallback() {
  const dropzone = $('dropzone');
  dropzone.classList.add('needs-drop');
  $('folder-compat-hint').hidden = false;
  setTimeout(() => dropzone.classList.remove('needs-drop'), 6000);
}

boot().catch((error) => {
  toast(`初始化失败：${error.message}`);
  setStatus('err', '初始化失败');
});

// 自动化/调试入口：浏览器文件选择器无法被脚本驱动，
// 端到端测试用它登记等价对象、并检查"没有点击就不保存"。
window.fileSharer = {
  state,
  platform,
  shareEntries,
  buildZipFor,
  requestDownload,
  saveTransfer,
  saveZip,
  get savedCount() {
    return state.savedCount;
  },
  get shares() {
    return shares;
  },
  get downloads() {
    return downloads;
  },
  get relay() {
    return relay;
  },
  get store() {
    return store;
  },
};
