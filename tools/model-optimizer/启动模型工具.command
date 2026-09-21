#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
trap 'printf "\n按回车关闭窗口。"; read -r _' EXIT
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  printf '请先安装 Node.js 22 或更高版本，再双击启动。\n'
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("请升级到 Node.js 22 或更高版本"); process.exit(1); }'
if [ ! -f node_modules/.fire-lock ] || ! cmp -s package-lock.json node_modules/.fire-lock; then
  printf '首次准备本地工具依赖，后续启动可复用…\n'
  npm ci --omit=dev --no-audit --no-fund
  cp package-lock.json node_modules/.fire-lock
fi
node app.mjs --gui
