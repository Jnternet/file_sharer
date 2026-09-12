# file_sharer — 局域网文件直传

一个可执行文件、一个网址，局域网内任意设备互相直传文件与文件夹。
**文件字节从不经过服务器**：服务器只做信令转发，浏览器之间用 WebRTC 点对点直传。

## 需求对照

| 需求 | 实现 | 验证方式 |
|---|---|---|
| 最终构建产物为单产物 | 前端 HTML/CSS/JS 用 `include_dir!` 编译期内嵌，`target/release/file_sharer` 是唯一必需文件 | `scripts/smoke.sh` 把二进制单独拷进空目录启动并访问页面 |
| 通过网页访问 | axum 提供静态站点 + `/api` + `/ws`，启动时打印本机/局域网地址 | `tests/http_api.rs`（10 例）+ 冒烟脚本 |
| 每次启动后都是空桶 | 服务器只持有内存在线名单；源码层禁止落盘（架构测试扫描） | `tests/architecture.rs` + `/api/info` 的 `persistence:"none"` |
| 人人可选文件并在线实时传，不预先传给服务器 | 选文件 → 预哈希 → WebRTC DataChannel 直传；服务器只转发 SDP/ICE | 协议回环测试 + `scripts/e2e-browser.mjs`（两个真实标签页） |
| 断点续传 | 内容寻址 transferId + 接收端 IndexedDB 块存储 + `resume-state` 协商偏移 | `transfer-loopback.test.js`：断开 3 块后重连只补传剩余 5 块 |
| 自动 hash 校验（上传前 / 下载完成后） | 发送前预哈希；传输中复算（检出源文件被改）；接收端落盘后复算比对，失败自动重传 | SHA-256 与 `node:crypto` 全长度对照 + 篡改/重传回环测试 |
| 单文件与文件夹自动区分 | 单个文件 → 直传；多文件或带目录结构 → 按目录传输并保留结构，接收端可打包 ZIP | `plan.test.js` + 浏览器 e2e（2 文件 + 子目录 + ZIP 由 python3 解压校验） |
| 使用 git 管理、小步迭代 | 每个功能一次提交（含配套测试），见 `git log --oneline` | — |
| 所有功能代码都有配套测试 | Rust 60 例 + JS 87 例 + 真实浏览器 e2e + 冒烟脚本 | `scripts/test-all.sh`、`scripts/smoke.sh`、`node scripts/e2e-browser.mjs` |

## 快速开始

```bash
cargo build --release
./target/release/file_sharer            # 默认 8080，监听 0.0.0.0
```

输出示例：

```
file_sharer 0.1.0 已启动（服务器零存储：每次启动都是空桶）
  本机:   http://127.0.0.1:8080/
  局域网: http://192.168.1.23:8080/
  在线人数上限: 64（Ctrl+C 退出）
```

两台设备各自打开同一个局域网地址：

1. 页面右上角显示"在线（名字）"，设备列表里出现对方并变成"已直连"；
2. 发送方把文件/文件夹拖进发送区（或点"选择文件"/"选择文件夹"）；
3. 选好目标设备（默认"全部在线设备"）后自动开始：先本地预哈希，再点对点传输；
4. 接收方看到进度，校验通过后点"下载文件"；文件夹则是"打包下载 .zip"。

常用参数：

```bash
file_sharer --port 9000            # 指定端口（0 = 随机空闲端口）
file_sharer --bind 127.0.0.1       # 只监听本机（默认 0.0.0.0）
file_sharer --max-peers 20         # 在线人数上限（默认 64）
file_sharer --ice-server stun:stun.example.org:3478   # 局域网屏蔽 mDNS 时的兜底
file_sharer --quiet                # 只输出错误日志
```

## 工作机制（细节见 [DESIGN.md](DESIGN.md)）

```
浏览器 A ── WebRTC DataChannel（文件字节）──▶ 浏览器 B
   │                                             ▲
   └──── /ws 信令（SDP/ICE，仅几 KiB）────▶ 服务器 ─┘
```

- **分块**：固定 1 MiB 分块；二进制帧 `[kind:u8][fileIndex:u32][chunkIndex:u64][payload]`（大端）。
- **流控**：接收端每 2 MiB 或 150 ms 回一次 `ack`，发送端未确认字节不超过 8 MiB，另有数据通道背压兜底。
- **校验**：流式 SHA-256（FIPS 180-4，自实现——`http://192.168.x.x` 是非安全上下文，`crypto.subtle` 不可用）。
- **续传**：`transferId = sha256(路径+大小+内容哈希)` 前 32 位，与"谁在传、什么时候传"无关；
  接收端按 `[transferId, fileIndex, chunkIndex]` 落 IndexedDB，重连时只补传缺失的块。
- **文件夹**：接收端保留相对路径，可打包为 store 模式 ZIP（不压缩；> 4 GiB 时降级为逐个文件下载）。

## 测试

```bash
scripts/test-all.sh            # Rust（单元/集成/架构）+ 前端（单元/协议回环）
scripts/smoke.sh               # 构建单产物并冒烟：页面 / API / 404 / 405 / 空目录启动
node scripts/e2e-browser.mjs   # 真实浏览器端到端（需要本机有 firefox）
```

各层覆盖：

| 层 | 内容 |
|---|---|
| Rust 单元 | 配置校验、MIME/ETag、路径穿越防护、地址探测、在线名单与限流、协议解析 |
| Rust 集成 | HTTP 页面/API/404/405、WebSocket 握手、名单广播（不含自己）、信令转发、限流/超限/满员 |
| Rust 架构 | 源码禁止落盘调用、只允许读路由、前端必须内嵌 |
| JS 单元 | SHA-256（与 node:crypto 全长度对照）、分帧、协议、传输计划、窗口流控、ZIP（python3 交叉校验）、IndexedDB 键、信令客户端、WebRTC 网格（假 RTC） |
| JS 协议回环 | 发送核心 ↔ 接收核心完整对接：端到端、文件夹、断线续传、篡改检出与重传、幂等块、源文件被改、流控、超时、对端报错 |
| 浏览器 e2e | 两个真实标签页建立 WebRTC 直连 → 拖入真实 File → 接收端 IndexedDB 逐字节比对 → 文件夹 ZIP 打包并由 python3 解压校验 |

## 安全边界与已知限制

- **无鉴权**：任何能访问该端口的人都能收发文件，这正是"局域网共享工具"的定位；
  **不要**把它暴露到公网或不可信网络。传输无身份校验（WebRTC 提供 DTLS 加密，但不验证对端是谁）。
- **服务器零存储是结构性保证**：`src/` 中没有任何落盘调用，也没有接收文件体的路由（由架构测试强制）。
- 接收到的数据存在**接收方浏览器**的 IndexedDB 里，用于断点续传与重复下载；界面提供"清空接收区"。
- 断点数据的有效性依赖"重新选择同一批文件"：发送端刷新后需要重新选文件，接收端会从上次的块继续。
- 非安全上下文限制：不使用 `crypto.subtle` / `showSaveFilePicker`；下载走 `Blob` + `<a download>`。
- 文件夹**选择**必须走系统文件选择器（浏览器安全限制），因此自动化脚本通过 `window.fileSharer.sendEntries`
  注入等价对象覆盖同一条代码路径；单文件路径则是真实拖放事件验证。
- 单个 ZIP 上限 4 GiB（ZIP32），超出时自动降级为逐个文件下载。

## 开发约定

- 协议逻辑全部放在 `web/lib/`，且都以"可注入依赖"的方式编写（store / channel / 时钟 / 连接工厂），
  因此能在 Node 里跑完整协议回环测试；`web/app.js` 只负责接线与渲染。
- 每完成一个功能提交一次，提交信息写清"做了什么 + 怎么验证"；需求级约束（单产物、零存储、无上传路由）
  用架构测试固化，避免后续被无意破坏。
