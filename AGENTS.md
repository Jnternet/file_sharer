# 协作约定

## 推送与发布（重要）

- **不要自动推送**：只有用户明确说「推送」时才执行 `git push`。
- **不要自动打标签或发版本**：只有用户明确要求「发布版本」时才 `git tag` / 建 GitHub Release。
- 平时照常小步提交（每个功能一次提交，含配套测试），但**提交只留在本地**，等用户发话再推。

## 提交前必须通过

```bash
cargo fmt --check
cargo test                       # 单元 / 集成 / 架构（需要绑定本机端口）
node --test tests/js/*.test.js   # 协议回环 / 单元（ZIP 用例需要 python3）
```

涉及界面或端到端行为时再加跑：`bash scripts/smoke.sh`、`node scripts/e2e-browser.mjs`（需要 firefox + python3）。
提交信息写清"做了什么 + 怎么验证"。

## 代码约定

- 协议与核心逻辑放在 `web/lib/`，用可注入依赖（store / 转发通道 / 时钟）以便在 Node 里跑协议回环；
  `web/app.js` 只做接线与渲染。
- 需求级约束由测试固化，不要绕过：单产物（`tests/architecture.rs` 的前端内嵌检查）、
  服务器零存储且不记录文件（源码扫描）、无广播、接收端不自动下载（浏览器 e2e 断言 `savedCount`）。
- 服务器只做定向转发：不解析负载语义、不落盘、不保存文件清单。

## 本机网络

- `github.com:443` 在本机需要走代理：`git sp`（设置为 `192.168.110.213:7890`），`git ps` 查看、`git usp` 关闭。
- 代理不可用时可改用 `scripts/publish-github.mjs` 走 GitHub REST API 发布。
