#!/usr/bin/env bash
# =====================================================================
# 本机构建 linux/amd64 平台的 fire 纯净版镜像，并导出 tar 供 docker load。
# 用法(在 fire-web/scripts 下或仓库根): ./scripts/build-amd64-image.sh
# 依赖:Docker Desktop 已启动,且有 linux/amd64 构建能力(buildx / QEMU)。
# =====================================================================
set -euo pipefail

# 定位到 fire-web 根目录(兼容从 scripts/ 或仓库根调用)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

echo "==> 构建 linux/amd64 纯净版镜像 fire:latest ..."
docker buildx build --platform linux/amd64 -t fire:latest .

# 默认导出到仓库 ./dist；可用 FIRE_IMAGE_OUTPUT_DIR 指定其他目录。
OUTPUT_DIR="${FIRE_IMAGE_OUTPUT_DIR:-$ROOT/dist}"
mkdir -p "$OUTPUT_DIR"
OUT="$OUTPUT_DIR/fire-amd64-image.tar.gz"
echo "==> 导出到: $OUT ..."

echo "==> 正在导出镜像(约 300–400MB,视网络速度)..."
docker save fire:latest | gzip > "$OUT"
ls -lh "$OUT"

echo
echo "==> 完成。群晖上执行:"
echo "  docker load < fire-amd64-image.tar.gz"
echo "  docker compose up -d      # 镜像已存在,不会再 build"
