// 浏览器粘合层：把信令、WebRTC 网格、传输核心和界面接起来。
// 这里只做"接线"与渲染，协议逻辑都在 lib/ 里（有 Node 测试覆盖）。

import { createSignalClient } from './lib/signal-client.js';
import { createPeerMesh } from './lib/mesh.js';
import { createIndexedDbStore } from './lib/idb-store.js';
import { createMemoryStore } from './lib/store-memory.js';
import { Receiver } from './lib/receiver.js';
import { Sender, hashSource } from './lib/sender.js';
import { DEFAULT_CHUNK_SIZE, buildSelectionPlan } from './lib/plan.js';
import { entriesFromDataTransfer, entriesFromFileList, sourceFromEntries } from './lib/files.js';
import { buildStoreZip, safeFileName, zipNameFor } from './lib/zip.js';

const $ = (id) => document.getElementById(id);
const NAME_KEY = 'file-sharer:name';

const state = {
  self: null,
  peers: [],
  channels: new Map(),
  transfers: new Map(),
  mesh: null,
  store: null,
  signal: null,
  busy: false,
};

// ---------------------------------------------------------------- 启动

async function boot() {
  $('name-input').value = localStorage.getItem(NAME_KEY) ?? '';
  state.store = await openStore();
  wireUi();
  void loadServerInfo();

  state.signal = createSignalClient({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    name: displayName(),
    onEvent: handleSignalEvent,
  });
  state.signal.connect();
}

async function openStore() {
  try {
    return await createIndexedDbStore();
  } catch (error) {
    toast(`IndexedDB 不可用（${error.message}），本次会话内仍可续传，但刷新后会丢失`);
    return createMemoryStore();
  }
}

async function loadServerInfo() {
  try {
    const info = await (await fetch('/api/info')).json();
    $('server-info').textContent = `服务器 v${info.version} · 在线 ${info.peers}/${info.max_peers} · 持久化：${info.persistence === 'none' ? '无（空桶）' : info.persistence}`;
  } catch {
    $('server-info').textContent = '无法读取服务器信息';
  }
}

function displayName() {
  const typed = $('name-input').value.trim();
  return (typed || `访客-${Math.random().toString(36).slice(2, 6)}`).slice(0, 32);
}

// ---------------------------------------------------------------- 信令

function handleSignalEvent(event) {
  switch (event.type) {
    case 'open':
      setStatus('warn', '已连接服务器，等待名单…');
      break;
    case 'welcome':
      state.self = event.self;
      state.peers = event.peers;
      setStatus('ok', `在线（${state.self?.name ?? ''}）`);
      startMesh(event.iceServers);
      renderPeers();
      void loadServerInfo();
      break;
    case 'peers':
      state.peers = event.peers;
      state.mesh?.setPeers(event.peers);
      renderPeers();
      void loadServerInfo();
      break;
    case 'signal':
      state.mesh?.handleSignal(event.from, event.data);
      break;
    case 'closed':
      state.self = null;
      state.peers = [];
      state.channels.clear();
      state.mesh?.close();
      state.mesh = null;
      setStatus('err', '与服务器断开，正在重连…');
      renderPeers();
      break;
    case 'error':
      toast(`服务器：${event.code} ${event.message}`);
      break;
    default:
      break;
  }
}

function startMesh(iceServers) {
  state.mesh?.close();
  state.mesh = createPeerMesh({
    selfId: state.self.id,
    iceServers: iceServers ?? [],
    signaling: { signal: (to, data) => state.signal.signal(to, data) },
    createConnection: (peerId) => {
      void peerId;
      return new RTCPeerConnection({ iceServers: state.signal.iceServers.map((urls) => ({ urls })) });
    },
    onChannel: ({ peerId, channel }) => attachChannel(peerId, channel),
    onEvent: (meshEvent) => {
      if (meshEvent.type === 'open' || meshEvent.type === 'closed' || meshEvent.type === 'retry') {
        renderPeers();
      }
      if (meshEvent.type === 'gave-up') {
        toast(`与 ${peerName(meshEvent.peerId)} 的重连次数用尽，请刷新页面重试`);
      }
    },
  });
  state.mesh.setPeers(state.peers);
}

// ---------------------------------------------------------------- 接收

function attachChannel(peerId, channel) {
  state.channels.set(peerId, channel);
  const receiver = new Receiver({
    store: state.store,
    channel,
    onEvent: (event) => handleReceiverEvent(peerId, event),
  });
  receiver.attach();
  renderPeers();
}

function handleReceiverEvent(peerId, event) {
  switch (event.type) {
    case 'manifest':
      upsertTransfer(event.manifest.transferId, {
        direction: 'receive',
        peerId,
        manifest: event.manifest,
        status: 'receiving',
        received: event.resumedBytes,
        total: event.manifest.totalBytes,
        files: new Map(event.manifest.files.map((file) => [file.i, { ...file, status: 'pending' }])),
        resumedBytes: event.resumedBytes,
        startedAt: Date.now(),
      });
      break;
    case 'progress':
      updateTransfer(event.transferId, (transfer) => {
        transfer.received = event.transferReceived;
        const file = transfer.files.get(event.fileIndex);
        if (file) {
          file.received = event.received;
        }
      });
      break;
    case 'file-done':
      updateTransfer(event.transferId, (transfer) => {
        const file = transfer.files.get(event.fileIndex);
        if (file) {
          file.status = event.status;
          file.actualHash = event.sha256;
        }
        if (event.status === 'hash-mismatch') {
          transfer.received = 0;
          for (const item of transfer.files.values()) {
            item.received = 0;
          }
        }
      });
      break;
    case 'complete':
      updateTransfer(event.transferId, (transfer) => {
        transfer.status = 'complete';
        transfer.received = transfer.total;
        transfer.finishedAt = Date.now();
      });
      toast(`已接收「${manifestTitle(event.manifest)}」并完成哈希校验`);
      break;
    case 'cancelled':
      updateTransfer(event.transferId, (transfer) => {
        transfer.status = 'cancelled';
        transfer.error = event.reason;
      });
      break;
    case 'remote-error':
    case 'protocol-error':
      toast(`接收出错：${event.error?.message ?? event.message ?? event.code}`);
      break;
    case 'discarded':
      toast('断点数据与本次内容不一致，已丢弃旧数据重新接收');
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- 发送

async function sendEntries(entries) {
  if (state.busy) {
    toast('上一次发送还在进行中');
    return;
  }
  const targets = targetPeerIds();
  if (targets.length === 0) {
    toast('没有可发送的在线设备');
    return;
  }

  let plan;
  try {
    plan = buildSelectionPlan(
      entries.map(({ file, path }) => ({
        name: file.name,
        size: file.size,
        webkitRelativePath: path,
      })),
    );
  } catch (error) {
    toast(`选择无效：${error.message}`);
    return;
  }

  const ordered = plan.files.map((item) => entries.find((entry) => entry.path === item.path));
  const source = sourceFromEntries(ordered);

  state.busy = true;
  $('hash-progress').hidden = false;
  try {
    const files = await hashSource(source, {
      chunkSize: DEFAULT_CHUNK_SIZE,
      onProgress: ({ processedBytes, totalBytes }) => {
        const percent = totalBytes === 0 ? 100 : Math.round((processedBytes / totalBytes) * 100);
        $('hash-bar').value = percent;
      },
    });

    for (const peerId of targets) {
      await sendToPeer(peerId, plan.kind, files, source);
    }
  } catch (error) {
    toast(`发送失败：${error.message}`);
  } finally {
    state.busy = false;
    $('hash-progress').hidden = true;
    $('hash-bar').value = 0;
  }
}

async function sendToPeer(peerId, kind, files, source) {
  const channel = state.channels.get(peerId);
  if (!channel) {
    toast(`与 ${peerName(peerId)} 的连接尚未建立，稍后再试`);
    return;
  }
  const sender = new Sender({
    source,
    channel,
    chunkSize: DEFAULT_CHUNK_SIZE,
    onEvent: (event) => handleSenderEvent(peerId, kind, files, event),
  });
  sender.attach();
  try {
    await sender.send({ kind, files, senderName: state.self?.name ?? '未知设备' });
  } catch (error) {
    toast(`发送到 ${peerName(peerId)} 失败：${error.message}`);
  }
}

function handleSenderEvent(peerId, kind, files, event) {
  switch (event.type) {
    case 'manifest':
      upsertTransfer(event.manifest.transferId, {
        direction: 'send',
        peerId,
        manifest: event.manifest,
        status: 'sending',
        received: 0,
        total: event.manifest.totalBytes,
        files: new Map(event.manifest.files.map((file) => [file.i, { ...file, status: 'pending' }])),
        startedAt: Date.now(),
      });
      break;
    case 'resumed':
      updateTransfer(event.transferId, (transfer) => {
        transfer.resumedBytes = event.resumedBytes;
      });
      break;
    case 'progress':
      updateTransfer(event.transferId, (transfer) => {
        const sentBefore = [...transfer.files.values()].reduce(
          (sum, file) => sum + (file.sent ?? 0),
          0,
        );
        const file = transfer.files.get(event.fileIndex);
        if (file) {
          file.sent = event.sent;
        }
        const sentNow = [...transfer.files.values()].reduce(
          (sum, item) => sum + (item.sent ?? 0),
          0,
        );
        transfer.received += Math.max(0, sentNow - sentBefore);
        transfer.inflight = event.inflight;
      });
      break;
    case 'file-sent':
      updateTransfer(event.transferId, (transfer) => {
        const file = transfer.files.get(event.fileIndex);
        if (file) {
          file.status = 'sent';
        }
      });
      break;
    case 'retry':
      updateTransfer(event.transferId, (transfer) => {
        transfer.status = 'sending';
        for (const index of event.files) {
          const file = transfer.files.get(index);
          if (file) {
            file.status = 'pending';
            file.sent = 0;
          }
        }
        transfer.received = 0;
      });
      toast('对端校验未通过，已自动重传');
      break;
    case 'file-done':
      updateTransfer(event.transferId, (transfer) => {
        const file = transfer.files.get(event.fileIndex);
        if (file) {
          file.status = event.status === 'ok' ? 'verified' : event.status;
        }
      });
      break;
    case 'complete':
      updateTransfer(event.transferId, (transfer) => {
        transfer.status = 'complete';
        transfer.received = transfer.total;
        transfer.finishedAt = Date.now();
      });
      toast(`「${manifestTitle(event.manifest)}」已送达 ${peerName(peerId)}（${kind === 'folder' ? '文件夹' : '单文件'}）`);
      break;
    case 'error':
      toast(`发送出错：${event.error?.message ?? '未知错误'}`);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- 下载

async function downloadFile(transferId, fileIndex, path) {
  try {
    const transfer = state.transfers.get(transferId);
    const file = transfer?.files.get(fileIndex);
    const bytes = await collect(state.store.readChunks(transferId, fileIndex));
    triggerDownload(new Blob([bytes], { type: file?.mime ?? 'application/octet-stream' }), safeFileName(path));
  } catch (error) {
    toast(`下载失败：${error.message}`);
  }
}

async function downloadZip(transferId) {
  const transfer = state.transfers.get(transferId);
  if (!transfer) {
    return;
  }
  try {
    const entries = [...transfer.files.values()]
      .sort((a, b) => a.i - b.i)
      .map((file) => ({
        path: file.path,
        size: file.size,
        chunks: () => state.store.readChunks(transferId, file.i),
      }));
    const zip = await buildStoreZip(entries);
    triggerDownload(new Blob([zip], { type: 'application/zip' }), zipNameFor(entries.map((e) => e.path)));
  } catch (error) {
    if (error.code === 'too-large') {
      toast('文件夹超过 4 GiB，ZIP 不可用：请用下面的文件列表逐个下载');
      return;
    }
    toast(`打包失败：${error.message}`);
  }
}

async function collect(iterable) {
  const parts = [];
  let total = 0;
  for await (const chunk of iterable) {
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

function peerName(peerId) {
  return state.peers.find((peer) => peer.id === peerId)?.name ?? peerId;
}

function targetPeerIds() {
  const value = $('target-select').value;
  const connected = state.peers.filter((peer) => state.channels.has(peer.id));
  if (value === 'all') {
    return connected.map((peer) => peer.id);
  }
  return connected.filter((peer) => peer.id === value).map((peer) => peer.id);
}

function renderPeers() {
  const list = $('peer-list');
  list.innerHTML = '';
  $('peer-count').textContent = String(state.peers.length);

  const selector = $('target-select');
  const previous = selector.value;
  selector.innerHTML = '<option value="all">全部在线设备</option>';
  for (const peer of state.peers) {
    const connected = state.channels.has(peer.id) || state.mesh?.isConnected(peer.id);
    const item = document.createElement('li');
    item.className = 'peer';
    item.innerHTML = `
      <div class="who">
        <div class="name"></div>
        <div class="meta"></div>
      </div>
      <span class="tag ${connected ? 'tag-ok' : ''}">${connected ? '已直连' : '连接中'}</span>
    `;
    item.querySelector('.name').textContent = peer.name;
    item.querySelector('.meta').textContent = peer.id;
    list.append(item);

    const option = document.createElement('option');
    option.value = peer.id;
    option.textContent = `${peer.name}${connected ? '' : '（连接中）'}`;
    selector.append(option);
  }
  selector.value = [...selector.options].some((option) => option.value === previous) ? previous : 'all';

  if (state.peers.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = '暂无其他在线设备：在同一局域网的另一台设备打开本页即可互相看到。';
    list.append(empty);
  }
}

function upsertTransfer(transferId, transfer) {
  state.transfers.set(transferId, transfer);
  renderTransfers();
}

function updateTransfer(transferId, mutate) {
  const transfer = state.transfers.get(transferId);
  if (!transfer) {
    return;
  }
  mutate(transfer);
  renderTransfers();
}

function manifestTitle(manifest) {
  if (!manifest) {
    return '传输';
  }
  if (manifest.kind === 'single') {
    return safeFileName(manifest.files[0]?.path ?? '文件');
  }
  return `${manifest.files[0]?.path?.split('/')[0] ?? '文件夹'}/（${manifest.files.length} 个文件）`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function renderTransfers() {
  const container = $('transfers');
  container.innerHTML = '';
  const transfers = [...state.transfers.values()].sort(
    (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
  );
  $('transfers-empty').hidden = transfers.length > 0;

  for (const transfer of transfers) {
    const item = document.createElement('li');
    item.className = 'transfer';
    const percent =
      transfer.total === 0 ? 100 : Math.min(100, Math.round((transfer.received / transfer.total) * 100));
    const elapsed = ((transfer.finishedAt ?? Date.now()) - transfer.startedAt) / 1000;
    const speed = elapsed > 0 ? transfer.received / elapsed : 0;
    const direction = transfer.direction === 'send' ? '发送' : '接收';
    const statusTag =
      transfer.status === 'complete'
        ? '<span class="tag tag-ok">完成</span>'
        : transfer.status === 'cancelled'
          ? '<span class="tag tag-err">已取消</span>'
          : `<span class="tag">${percent}%</span>`;

    item.innerHTML = `
      <div class="transfer-head">
        <span class="tag">${direction} → ${transfer.peerId ? peerName(transfer.peerId) : '未知'}</span>
        <span class="transfer-title"></span>
        ${statusTag}
        <span class="transfer-meta"></span>
      </div>
      <progress max="100" value="${percent}"></progress>
      <div class="transfer-actions"></div>
      <ul class="file-list"></ul>
    `;
    item.querySelector('.transfer-title').textContent = manifestTitle(transfer.manifest);
    item.querySelector('.transfer-meta').textContent = [
      `${formatBytes(transfer.received)} / ${formatBytes(transfer.total)}`,
      `${transfer.manifest?.files?.length ?? 0} 个文件`,
      speed > 0 && transfer.status !== 'complete' ? `${formatBytes(speed)}/s` : null,
      transfer.resumedBytes ? `断点续传 ${formatBytes(transfer.resumedBytes)}` : null,
      transfer.inflight ? `在途 ${formatBytes(transfer.inflight)}` : null,
      transfer.manifest?.chunkSize ? `分块 ${formatBytes(transfer.manifest.chunkSize)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const actions = item.querySelector('.transfer-actions');
    if (transfer.direction === 'receive' && transfer.status === 'complete') {
      if (transfer.manifest.kind === 'folder') {
        actions.append(
          button('打包下载 .zip', () => downloadZip(transfer.manifest.transferId)),
        );
      } else {
        const only = [...transfer.files.values()][0];
        actions.append(button('下载文件', () => downloadFile(transfer.manifest.transferId, only.i, only.path)));
      }
      actions.append(
        button('删除', async () => {
          await state.store.deleteTransfer(transfer.manifest.transferId);
          state.transfers.delete(transfer.manifest.transferId);
          renderTransfers();
        }, 'btn-ghost'),
      );
    }

    const fileList = item.querySelector('.file-list');
    for (const file of [...transfer.files.values()].sort((a, b) => a.i - b.i)) {
      const row = document.createElement('li');
      const state_ = {
        ok: '✓ 已校验',
        verified: '✓ 已校验',
        sent: '已发送，等待校验',
        pending: '待传',
        'hash-mismatch': '✗ 校验失败，重传中',
        incomplete: '✗ 数据不完整',
      }[file.status] ?? file.status;
      row.textContent = `${file.path} · ${formatBytes(file.size)} · ${state_}`;
      if (transfer.direction === 'receive' && transfer.status === 'complete') {
        const link = button('下载', () => downloadFile(transfer.manifest.transferId, file.i, file.path), 'btn-ghost btn-small');
        row.append(' ', link);
      }
      fileList.append(row);
    }

    container.append(item);
  }
}

function button(label, onClick, extraClass = 'btn') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = extraClass;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function toast(message) {
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
  dropzone.addEventListener('click', (event) => {
    if (event.target.closest('button')) {
      return;
    }
    $('file-input').click();
  });
  $('pick-file').addEventListener('click', () => $('file-input').click());
  $('pick-folder').addEventListener('click', () => $('folder-input').click());

  $('file-input').addEventListener('change', (event) => {
    const entries = entriesFromFileList(event.target.files);
    event.target.value = '';
    if (entries.length > 0) {
      void sendEntries(entries);
    }
  });
  $('folder-input').addEventListener('change', (event) => {
    const entries = entriesFromFileList(event.target.files);
    event.target.value = '';
    if (entries.length > 0) {
      void sendEntries(entries);
    }
  });

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
      await sendEntries(entries);
    })();
  });

  $('name-input').addEventListener('change', (event) => {
    const value = event.target.value.trim().slice(0, 32);
    localStorage.setItem(NAME_KEY, value);
    toast('名字已保存，刷新页面后生效');
  });

  $('clear-received').addEventListener('click', async () => {
    const received = [...state.transfers.values()].filter((transfer) => transfer.direction === 'receive');
    for (const transfer of received) {
      await state.store.deleteTransfer(transfer.manifest.transferId);
      state.transfers.delete(transfer.manifest.transferId);
    }
    renderTransfers();
    toast(`已清空 ${received.length} 条接收记录`);
  });

  window.addEventListener('beforeunload', () => {
    state.signal?.close();
    state.mesh?.close();
  });
}

boot().catch((error) => {
  toast(`初始化失败：${error.message}`);
  setStatus('err', '初始化失败');
});
