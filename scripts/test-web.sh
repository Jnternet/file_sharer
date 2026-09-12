#!/usr/bin/env bash
# 只跑前端（JS）测试：零依赖，使用 Node 内置测试运行器。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --test tests/js/*.test.js
