#!/usr/bin/env bash
# macOS / Linux 启动脚本；Windows 用 启动.bat
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "  [!] Node.js not found. Install it first: https://nodejs.org"
  exit 1
fi

echo "  vocab-reader is starting..."
echo "  Open http://localhost:5173"
exec node server.js
