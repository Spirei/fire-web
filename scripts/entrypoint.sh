#!/bin/sh
set -e

# 首次启动把打进镜像的默认资源（asset 素材库 / celebs 名人头像 / currency / ico / login / logo / background）
# 复制到挂载目录（/app/public/uploads ← 宿主机 ./uploads）。
# 幂等：已存在的不覆盖（-n），用户后来上传/替换的内容不会被还原。
if [ -d /app/resource-default ]; then
  mkdir -p /app/public/uploads
  cp -rn /app/resource-default/* /app/public/uploads/ 2>/dev/null || true
fi

# 数据卷首次创建时，用镜像内的交易广场缓存初始化。兼容此前线上已经生成的空数组文件，
# 但绝不覆盖任何已有动态，避免容器升级回滚运行期抓取结果。
if [ -d /app/trading-square-default ]; then
  mkdir -p /app/data
  for source in /app/trading-square-default/*.json; do
    [ -f "$source" ] || continue
    target="/app/data/$(basename "$source")"
    if [ ! -s "$target" ] || grep -Eq '^[[:space:]]*\[[[:space:]]*\][[:space:]]*$' "$target" 2>/dev/null; then
      cp "$source" "$target"
    fi
  done
fi

exec "$@"
