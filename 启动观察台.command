#!/bin/zsh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 20 或更高版本，再重新双击此文件。"
  read "?按回车键关闭…"
  exit 1
fi

if [[ ! -d "node_modules" ]]; then
  echo "正在首次安装运行组件，请稍候…"
  npm install --include=dev
fi

npm run start &
server_pid=$!
sleep 2
open "http://127.0.0.1:8787"
wait "$server_pid"
