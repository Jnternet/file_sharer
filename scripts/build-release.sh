#!/usr/bin/env bash
# 本地打出 Linux（glibc / 静态 musl）与 Windows x86_64 三个发布文件，并生成校验和。
# Windows / musl 交叉编译依赖 zig 与 cargo-zigbuild（cargo install cargo-zigbuild + zig）。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
OUT="dist"
mkdir -p "$OUT"

echo "== 版本 $VERSION =="

echo "-- Linux x86_64 (glibc)"
cargo build --release --locked --target x86_64-unknown-linux-gnu
cp "target/x86_64-unknown-linux-gnu/release/file_sharer" "$OUT/file_sharer-v$VERSION-linux-x86_64"

if command -v cargo-zigbuild >/dev/null 2>&1 && command -v zig >/dev/null 2>&1; then
  echo "-- Linux x86_64 (静态 musl)"
  cargo zigbuild --release --locked --target x86_64-unknown-linux-musl
  cp "target/x86_64-unknown-linux-musl/release/file_sharer" "$OUT/file_sharer-v$VERSION-linux-x86_64-musl"

  echo "-- Windows x86_64"
  cargo zigbuild --release --locked --target x86_64-pc-windows-gnu
  cp "target/x86_64-pc-windows-gnu/release/file_sharer.exe" "$OUT/file_sharer-v$VERSION-windows-x86_64.exe"
else
  echo "跳过长产物：未找到 cargo-zigbuild/zig"
fi

echo "-- 校验和"
( cd "$OUT" && sha256sum file_sharer-* > "SHA256SUMS-$VERSION.txt" )
ls -lh "$OUT"
