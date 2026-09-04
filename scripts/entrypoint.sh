#!/bin/sh
set -e

# 首次启动把打进镜像的默认资源（asset 素材库 / celebs 名人头像 / currency / ico / login / logo / background）
# 复制到挂载目录（/app/public/uploads ← 宿主机 ./uploads）。
# 幂等：已存在的不覆盖（-n），用户后来上传/替换的内容不会被还原。
if [ -d /app/resource-default ]; then
  mkdir -p /app/public/uploads
  cp -rn /app/resource-default/* /app/public/uploads/ 2>/dev/null || true
fi

# 将镜像内的交易广场种子按动态 ID 合并进数据卷；线上运行期版本优先，
# 因此既能补齐新版镜像新增的历史动态，也不会回滚线上已经更新的内容。
if [ -d /app/trading-square-default ]; then
  node /app/scripts/seed-trading-square.mjs
fi

exec "$@"
