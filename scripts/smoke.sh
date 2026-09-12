#!/usr/bin/env bash
# 冒烟测试：验证"单产物 + 网页访问 + 空桶 API"，并确认二进制不依赖任何外部文件。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 构建 release 单产物 =="
cargo build --release

BIN="$PWD/target/release/file_sharer"
WORK="$(mktemp -d)"
cleanup() {
  if [ -n "${PID:-}" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# 只把可执行文件拷到空目录：如果它还需要任何外部资源，这里就会失败
cp "$BIN" "$WORK/file_sharer"
cd "$WORK"
./file_sharer --port 0 > server.log 2>&1 &
PID=$!

URL=""
for _ in $(seq 1 50); do
  URL="$(grep -o 'http://127\.0\.0\.1:[0-9]*/' server.log | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 0.2
done
if [ -z "$URL" ]; then
  echo "启动失败，日志："
  cat server.log
  exit 1
fi
echo "== 服务地址 $URL =="

echo "-- 首页（内嵌资源）"
curl -fsS "$URL" | grep -q "局域网文件直传"
curl -fsS "${URL}app.js" | grep -q "createSignalClient"
curl -fsS "${URL}styles.css" | grep -q -- "--accent"
curl -fsS "${URL}lib/sha256.js" | grep -q "class Sha256"

echo "-- API"
curl -fsS "${URL}api/health" | grep -q '"status":"ok"'
INFO="$(curl -fsS "${URL}api/info")"
echo "$INFO"
echo "$INFO" | grep -q '"persistence":"none"'
echo "$INFO" | grep -q '"peers":0'

echo "-- 不存在的路径 / 不支持的写接口"
test "$(curl -s -o /dev/null -w '%{http_code}' "${URL}nope.js")" = "404"
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${URL}api/health")" = "405"

echo "-- 工作目录内容（应当只有可执行文件与日志）"
ls -1
test "$(ls -1 | grep -cv -e '^file_sharer$' -e '^server.log$')" = "0"

echo "冒烟通过：单产物、网页可用、服务器零存储、无上传接口"
