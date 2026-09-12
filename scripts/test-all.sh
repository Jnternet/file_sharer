#!/usr/bin/env bash
# 全量测试：Rust（单元/集成/架构）+ 前端（单元/协议）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Rust 测试 =="
cargo test

echo "== 前端测试 =="
node --test tests/js/*.test.js
