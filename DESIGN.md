# 局域网文件直传工具 — 设计文档

> 先设计、再实现。本文档是实现的契约：协议、边界、测试策略都先在这里定稿，
> 代码与测试按本文档逐条落地（每个功能一条提交，见文末迭代计划）。

## 1. 目标（需求 → 设计决策）

| # | 需求 | 设计决策 |
|---|---|---|
| R1 | 单产物 | Rust 一次 `cargo build --release` 产出唯一可执行文件；前端 HTML/CSS/JS 用 `include_dir!` 编译期内嵌，运行时不需要任何外部文件、不需要 node |
| R2 | 网页访问 | axum 提供静态站点 + JSON API + WebSocket 信令；启动时打印本机与局域网地址 |
| R3 | 每次启动都是空桶 | 服务端**没有任何持久化路径**：不写文件、不建数据库、不缓存字节；内存里只保留"在线用户名单"，进程退出即归零。用架构测试（源码扫描）守住这条约束 |
| R4 | 人人可选文件并在线实时传（不预先传给服务器） | 浏览器之间 WebRTC DataChannel 点对点直传；服务器只做信令（SDP/ICE 透传），**永远看不到文件字节** |
| R5 | 断点续传 | 分块 + 内容寻址传输 ID + 接收端 IndexedDB 落盘已收块 + 重连后 `resume-state` 协商续传偏移 |
| R6 | 自动 hash 校验（上传前 / 下载完成后） | 纯 JS 流式 SHA-256：发送前对源文件预哈希 → 传输中边发边重算（检测本地文件被改动）→ 接收端写完后再对落盘数据复算校验 |
| R7 | 单文件与文件夹，自动区分 | 拖放用 `webkitGetAsEntry()` 判定目录；多文件/目录一律按"文件夹"语义传输（保留相对路径），单文件按单文件传输；用户不需要手动切换模式 |
| R8 | git 管理 + 小步迭代 | 每个功能一次提交，提交内含实现 + 配套测试；见 §8 |
| R9 | 所有功能代码都有配套测试 | 三层测试：Rust 单元/集成（HTTP、WS、信令、并发上限）、Node 单元/协议回环（SHA-256、分帧、ZIP、发送/接收核心、续传、篡改检出）、架构测试（无持久化、无上传路由） |

## 2. 非目标（明确的边界）

- 不做账号、权限、加密传输（局域网内网、明文 HTTP；文档中明示信任模型）。
- 不做服务端存储/中转/离线消息：服务器**不是**文件中转站，接收方不在线就无法投递。
- 不依赖公网：默认不使用 STUN/TURN（局域网 host candidate 足够）。若网络禁用 mDNS，可用 `--ice-server` 追加 STUN。
- 不追求 IE/老浏览器兼容；目标 Chrome/Edge/Firefox/Safari 近两年版本。
- 不做压缩（文件夹打包为 **store 模式 ZIP**，不压缩，仅用于保留目录结构）。

## 3. 架构

```
        ┌──────────────────────────── 浏览器 A（发送方） ────────────────────────────┐
        │  选择文件/拖放 → 自动识别单文件 or 文件夹                                   │
        │  预哈希(SHA-256, 分片读)  →  构建 manifest(内容寻址 transferId)              │
        │  ┌─────────────┐   文本帧=JSON 控制消息 / 二进制帧=数据块                    │
        │  │ 发送核心     │◄──────────────────────────────────────────┐               │
        │  └──────┬──────┘                                           │               │
        └─────────┼──────────────────────────────────────────────────┼───────────────┘
                  │  WebRTC DataChannel（P2P，字节不经过服务器）        │
        ┌─────────▼──────────────────────────────────────────────────┴───────────────┐
        │  浏览器 B（接收方）                                                          │
        │  接收核心：完整块 → IndexedDB 落盘 → 定期 ACK(流控) → 完成后复算 SHA-256      │
        │  校验通过 → 单文件直接下载 / 文件夹打包 ZIP 下载；校验失败 → 丢弃并要求重传     │
        └─────────────────────────────────────────────────────────────────────────────┘
                  ▲  信令（仅此一处经过服务器，且不含文件字节）
                  │
        ┌─────────┴───────────────────────────────────────────────────────────────────┐
        │  服务器（Rust，单可执行文件）                                                │
        │  GET /            → 内嵌 index.html                                          │
        │  GET /assets/*    → 内嵌静态资源                                             │
        │  GET /api/info    → {version, peers, uptime, persistence:"none"}             │
        │  GET /api/health  → ok                                                       │
        │  GET /ws          → 在线名单广播 + 信令透明转发（消息上限 64 KiB）             │
        │  内存态：peer 名单（进程退出即清空，即"空桶"）                                 │
        └─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 目录结构

```
Cargo.toml            单 crate，产出单二进制
src/main.rs           CLI 解析、绑定端口、局域网地址探测、优雅退出
src/lib.rs            路由器组装（可被测试直接调用）
src/config.rs         启动参数与校验
src/assets.rs         内嵌静态资源 + MIME/缓存头
src/signal.rs         WebSocket 信令：名单、路由、限额
src/net.rs            局域网 IP 探测与 URL 打印
web/index.html        单页 UI
web/styles.css
web/app.js            浏览器粘合层（DOM、WebRTC、IndexedDB、下载）
web/lib/sha256.js     流式 SHA-256（自实现，纯 JS，无依赖）
web/lib/framing.js    二进制分帧编解码
web/lib/protocol.js   控制消息构造/校验
web/lib/plan.js       选择结果 → 传输计划（自动区分文件/文件夹）、分块与续传偏移计算
web/lib/window.js     发送窗口/流控
web/lib/zip.js        store 模式 ZIP 打包（目录结构保留）
web/lib/sender.js     发送核心（可注入传输与文件源 → Node 可测）
web/lib/receiver.js   接收核心（可注入块存储 → Node 可测）
tests/                Rust 集成测试
tests/js/             Node 单元/回环测试
scripts/              便捷脚本（跑全部测试、冒烟）
```

## 4. 协议（契约）

### 4.1 信令（浏览器 ⇄ 服务器，`/ws`，JSON 文本帧）

| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | `{"t":"hello","name":"..."}` | 注册显示名（可选，缺省用 `访客-xxxx`） |
| S→C | `{"t":"welcome","self":{...},"peers":[...]}` | 连接成功后下发自身 ID 与在线名单 |
| S→C | `{"t":"peers","peers":[{id,name}]}` | 名单变化广播 |
| C→S | `{"t":"signal","to":"<peerId>","data":{...}}` | 转发 SDP/ICE，服务器不解析 `data` |
| S→C | `{"t":"signal","from":"<peerId>","data":{...}}` | 转发给目标；目标离线则回 `error` |
| S→C | `{"t":"error","code":"...","message":"..."}` | `bad-request` / `too-large` / `unknown-peer` / `rate-limited` |

约束：文本帧 ≤ 64 KiB（SDP 通常在 4 KiB 内）；每连接信令速率限制（60 msg/s）；在线人数上限 `--max-peers`（默认 64）。

### 4.2 数据通道（浏览器 ⇄ 浏览器，RTCDataChannel `fs`，有序可靠）

- **文本帧** = JSON 控制消息；**二进制帧** = 数据块。
- 二进制帧格式（大端）：

```
offset 0   : u8   kind = 1（数据块）
offset 1   : u32  fileIndex
offset 5   : u64  chunkIndex
offset 13  : payload[chunkSize]
```

固定 **chunkSize = 1 MiB**（可协商，但同一 transferId 必须一致；写入 manifest）。块边界由 `chunkIndex * chunkSize` 决定，保证续传偏移可复算。

### 4.3 传输流程

```
发送方                                          接收方
  │ 预哈希全部文件（进度：校验中 x%）              │
  │ ── manifest ───────────────────────────────► │  查 IndexedDB：这个 transferId/文件已有多少块
  │ ◄──────────────────────── resume-state ───── │  （全新传输则为 0）
  │ 从 resume 偏移开始逐块发送（窗口 8 MiB）       │
  │ ── binary chunk ───────────────────────────► │  完整块 → IndexedDB
  │ ◄──────────────────────────── ack(周期) ──── │  每 2 MiB 或 150 ms
  │ ... 单文件发完 → file-done                     │
  │ ◄── file-done{status:ok|hash-mismatch} ───── │  流式复算 SHA-256 对比 manifest
  │ 全部完成 → transfer-done                      │  ok → 提供下载；失败 → 丢弃并要求重传
```

控制消息集合：

| 消息 | 字段 |
|---|---|
| `manifest` | `transferId, kind:"single"\|"folder", senderName, chunkSize, totalBytes, files:[{i,path,size,sha256,mime}]` |
| `resume-query` | `transferId`（接收端主动查问时用；正常由 manifest 触发） |
| `resume-state` | `transferId, files:[{i,received}]` |
| `ack` | `transferId, i, received`（已落盘的字节数） |
| `file-done` | `transferId, i, status:"ok"\|"hash-mismatch"\|"incomplete", sha256` |
| `transfer-done` | `transferId, status:"ok"\|"partial"` |
| `cancel` | `transferId, reason` |
| `error` | `transferId, message` |

### 4.4 内容寻址的传输 ID（续传的关键）

```
transferId = sha256( sortedFiles.map(f => `${f.path}\n${f.size}\n${f.sha256}`).join("\n") ).slice(0,32)
```

因为"发送前预哈希"是 R6 的硬要求，我们顺手拿到了每个文件的内容哈希，于是：

- 传输身份与"谁发的/什么时候发的"无关，只与内容有关；
- 发送方刷新页面后重新选中同一批文件 → 得到同一 `transferId` → 接收方命中已有分块，从断点继续；
- 内容变了（改了文件）→ 新 `transferId`，不会错误地拼接到旧数据上。

接收端按 `[transferId, fileIndex, chunkIndex]` 存块，元数据里记录 `path/size/sha256`，因此断点数据自带"该有的样子"。

### 4.5 校验（三重）

1. **上传前**：发送方对源文件流式 SHA-256，结果写入 manifest（进度可见）。
2. **传输中**：发送方对"实际发出的字节"再算一次 SHA-256，结束后与预哈希比对 → 检出本地文件在传输期间被修改/截断，直接 `cancel` 并报错。
3. **下载完成后**：接收方对 IndexedDB 中落盘的数据流式复算 SHA-256，与 manifest 比对 → 不匹配则丢弃该文件分块、回 `hash-mismatch`，发送方自动重试一次（从 0 开始）。

### 4.6 流控

接收方每 2 MiB 或 150 ms 发一次 `ack`；发送方维持"未确认字节 ≤ 8 MiB"的窗口，窗口满则等待。避免把接收端 IndexedDB 写队列和发送端内存打爆。

## 5. 空桶与安全边界

- 服务器只监听套接字与内存名单：`src/` 中禁止出现 `File::create` / `fs::write` / `OpenOptions` 等落盘调用（架构测试扫描源码强制）。
- 服务器没有任何"文件上传"路由：架构测试断言 `POST /upload` → 404，源码中不存在接收文件体量的处理。
- 信任模型：**任何能访问该端口的人都能发/收文件**，符合需求原意（局域网内共享工具）；不要在不可信网络（咖啡馆 Wi‑Fi、公网端口映射）上暴露。README 写明。
- 资源上限：`--max-peers`（默认 64）、单帧 64 KiB（信令）、信令速率限制、HTTP 请求体上限（无 body 路由，直接 405/404）。
- 接收端存储：IndexedDB 保存已接收分块（用于断点续传与下载），页面提供"清空接收区"。**服务器端为零存储**。

## 6. 浏览器兼容与关键技术点

- `crypto.subtle` 在 `http://192.168.x.x`（非安全上下文）下**不可用**，因此 SHA-256 自己实现流式版本（`web/lib/sha256.js`），并用 Node 的 `crypto` 做对照测试。
- 下载走 `Blob` + `<a download>`（非安全上下文可用）；不使用 `showSaveFilePicker`。
- 文件夹选择用 `<input type="file" webkitdirectory>`（非安全上下文可用）；拖放用 `webkitGetAsEntry()`。
- WebRTC 局域网直连依赖 host candidate；Chrome 的 mDNS 候选在单播 DNS 可用的局域网可正常解析。若网络屏蔽 mDNS，用 `--ice-server stun:...` 兜底。

## 7. 测试策略（每条需求都要有可执行的验证）

| 层 | 工具 | 覆盖 |
|---|---|---|
| Rust 单元 | `cargo test` | 配置校验、资源 MIME/ETag、信令名单与路由、限额、局域网 IP 探测 |
| Rust 集成 | `axum` + `tower::ServiceExt` + 本地端口 + `tokio-tungstenite` | 静态站点、API、404/405、WebSocket 握手、welcome/peers 广播、信令转发、超限报错、断开后名单清理 |
| 架构 | `cargo test` | 无落盘调用；无上传路由；内嵌资源存在 index.html |
| JS 单元 | `node --test`（零依赖） | SHA-256 对照向量/分块等价/大输入、分帧编解码与畸形输入、协议消息校验、传输计划与自动区分、续传偏移、流控窗口、CRC32/ZIP 结构 |
| JS 协议回环 | `node --test` | sender-core ↔ receiver-core 用内存管道对接：正常传输、断线续传、篡改数据必被检出、块乱序/重复幂等、文件夹打包 |
| 冒烟 | `scripts/smoke.sh` | 构建产物单独放进空目录启动 → `curl` 校验页面/API/404/405 |
| 浏览器 e2e | `scripts/e2e-browser.mjs`（无头 Firefox + WebDriver BiDi） | 两个真实标签页建立 WebRTC 直连 → 真实 File 拖放 → 接收端 IndexedDB 逐字节比对 → 文件夹 ZIP 打包并由 python3 解压校验 |

## 8. 迭代计划（每次提交 = 一个小步，含测试）

| 序 | 提交 | 内容 | 验证 |
|---|---|---|---|
| 1 | `chore: 设计文档与项目脚手架` | DESIGN/README/Cargo 依赖/脚本 | `cargo check` |
| 2 | `feat(server): 内嵌静态站点与 /api 路由` | assets/lib/config/net | Rust 单元 + HTTP 集成测试 |
| 3 | `feat(signal): WebSocket 信令与在线名单` | signal.rs | WS 集成测试（名单广播/转发/限额/清理） |
| 4 | `feat(web): 流式 SHA-256 与二进制分帧` | sha256.js/framing.js/protocol.js | Node 单测（对照 Node crypto） |
| 5 | `feat(web): 传输计划（自动区分文件/文件夹）与流控` | plan.js/window.js | Node 单测 |
| 6 | `feat(web): 接收核心与断点续传` | receiver.js + 内存块存储 | Node 单测 + 回环 |
| 7 | `feat(web): 发送核心与三重校验` | sender.js | Node 回环（续传/篡改/重试） |
| 8 | `feat(web): ZIP 打包与下载` | zip.js | Node 单测（结构可解析） |
| 9 | `feat(web): 浏览器 UI 与 WebRTC 粘合层` | index.html/styles.css/app.js | 冒烟脚本 + 手工/浏览器验证 |
| 10 | `docs: 使用说明与安全边界` + 收尾 | README/scripts | 全量测试 + 构建产物冒烟 |
| 11 | `fix: 端到端验证发现的三处缺陷` | 名单含自己、answer 触发重建、IndexedDB 游标长事务 | 浏览器 e2e 复现 → 修复 → 回归测试 |
| 12 | `test(e2e): 真实浏览器端到端` | 单文件 + 文件夹 + ZIP（python3 独立解压校验） | `scripts/e2e-browser.mjs` 全绿 |

## 9. 已知风险与对策

| 风险 | 对策 |
|---|---|
| 大文件在浏览器内存里组装成 Blob 可能吃内存 | 分块落 IndexedDB，组装时才拼接；文件夹用 store ZIP 落盘；提供分片下载兜底（>4 GiB 时逐个文件下载） |
| mDNS 候选解析失败导致 P2P 连不通 | 提供 `--ice-server`，README 说明；连接失败给出明确提示 |
| 断点数据长期占用磁盘 | 接收区显示占用，提供"清空接收区"；完成项可一键清理 |
| 发送方改文件导致校验失败 | 传输中二次哈希检出并报错；接收端丢弃并允许重传 |
| 非安全上下文缺少 WebCrypto | 自实现 SHA-256 并对照测试 |
