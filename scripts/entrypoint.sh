#!/bin/sh
set -e

# 首次启动把打进镜像的默认资源（asset 素材库 / celebs 名人头像 / currency / ico / login / logo / background）
# 复制到挂载目录（/app/public/uploads ← 宿主机 ./uploads）。
# 幂等：已存在的不覆盖（-n），用户后来上传/替换的内容不会被还原。
if [ -d /app/resource-default ]; then
  mkdir -p /app/public/uploads
  cp -rn /app/resource-default/* /app/public/uploads/ 2>/dev/null || true
fi

exec "$@"
