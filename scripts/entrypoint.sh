#!/bin/sh
set -e

# 路径默认与容器内一致；下面几个环境变量只为本地模拟 / 回归测试预留，生产不需要设置。
DATA_DIR="${FIRE_ENTRYPOINT_DATA_DIR:-/app/data}"
UPLOADS_DIR="${FIRE_ENTRYPOINT_UPLOADS_DIR:-/app/public/uploads}"
DEFAULTS_DIR="${FIRE_ENTRYPOINT_DEFAULTS_DIR:-/app/resource-default}"
CACHE_DIR="${FIRE_ENTRYPOINT_CACHE_DIR:-/app/public-cache-default}"
SEED_SCRIPT="${FIRE_ENTRYPOINT_SEED_SCRIPT:-/app/scripts/seed-trading-square.mjs}"
FIX_HINT="请在有 sudo 权限的账号下执行：chown -R 1000:1000 data uploads（路径对应 .env 里的 DATA_DIR / UPLOADS_DIR）"

# 权限自检：容器以非 root（uid 1000 的 node 用户）运行，而 DATA_DIR / UPLOADS_DIR 通常是宿主机
# bind mount，属主由宿主机决定。数据目录不可写时 SQLite 根本无法工作，这里先给出明确的中文提示，
# 避免线上只留下一行英文 EACCES、看着像"无缘无故无限重启"。
mkdir -p "$DATA_DIR" 2>/dev/null || true
if ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
  echo "[entrypoint] 数据目录不可写：$DATA_DIR" >&2
  echo "[entrypoint] 容器内的 node 用户（uid 1000）需要该目录的写权限（SQLite 建库 / WAL 都依赖它）。" >&2
  echo "[entrypoint] $FIX_HINT" >&2
  exit 1
fi
rm -f "$DATA_DIR/.write-test" 2>/dev/null || true

mkdir -p "$UPLOADS_DIR" 2>/dev/null || true
if ! touch "$UPLOADS_DIR/.write-test" 2>/dev/null; then
  echo "[entrypoint] 警告：上传目录不可写：$UPLOADS_DIR（头像 / 图标上传会失败，服务仍会启动）" >&2
  echo "[entrypoint] $FIX_HINT" >&2
else
  rm -f "$UPLOADS_DIR/.write-test" 2>/dev/null || true
fi

# 部署素材自检：插图（public/images）、字体、图标、分享图既不在仓库也不在镜像里（见 ASSETS.md），
# 需要部署者放到宿主机目录后挂载进来。缺失时服务照常运行，只是 FIRE 页面会出现「小丑鱼不见了」
# 这种静默视觉缺失 —— 这里给一行中文提示，避免只能靠肉眼发现。
PUBLIC_DIR="${FIRE_ENTRYPOINT_PUBLIC_DIR:-/app/public}"
media_missing=""
for media in images fonts icons share; do
  if [ -d "$PUBLIC_DIR/$media" ] && [ -n "$(ls -A "$PUBLIC_DIR/$media" 2>/dev/null || true)" ]; then
    :
  else
    media_missing="$media_missing $media"
  fi
done
if [ -n "$media_missing" ]; then
  echo "[entrypoint] 提示：$PUBLIC_DIR 下缺少部署素材：$media_missing" >&2
  echo "[entrypoint] 影响：FIRE 页面的小丑鱼与礁石贴图、自定义字体与图标会 404（服务不受影响）。" >&2
  echo "[entrypoint] 处理：按 docs/synology-deploy.md「挂载插图 / 字体 / 图标素材」把目录放进宿主机并挂载后重启容器。" >&2
fi

# 首次启动把打进镜像的默认资源（asset 素材库 / celebs 名人头像 / currency / ico / login / logo / background）
# 复制到挂载目录（/app/public/uploads ← 宿主机 ./uploads）。
# 幂等：已存在的不覆盖（-n），用户后来上传/替换的内容不会被还原。
if [ -d "$DEFAULTS_DIR" ]; then
  mkdir -p "$UPLOADS_DIR"
  cp -rn "$DEFAULTS_DIR"/* "$UPLOADS_DIR"/ 2>/dev/null || true
fi

# 将镜像内的公开缓存种子合并进数据卷；线上运行期版本优先，
# 因此既能补齐新版镜像数据，也不会回滚线上已经更新的内容。
# 种子只是首屏优化：失败只告警、绝不阻塞启动（否则权限/配额问题会变成"无限重启"）。
if [ -d "$CACHE_DIR" ]; then
  FIRE_TRADING_DATA_DIR="$DATA_DIR" FIRE_PUBLIC_CACHE_DEFAULTS_DIR="$CACHE_DIR" node "$SEED_SCRIPT" \
    || echo "[entrypoint] 警告：公开缓存种子合并失败（不影响启动，原因见上方报错）" >&2
fi

exec "$@"
