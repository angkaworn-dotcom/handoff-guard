#!/usr/bin/env sh
# handoff-guard installer (macOS/Linux) — เช็ค Node.js ก่อน แล้วรัน installer จริง
# ใช้: sh install.sh
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "X ไม่พบ Node.js — handoff-guard ต้องใช้ node รัน hooks/scripts"
  echo "  ติดตั้ง Node.js ก่อน แล้วรัน install.sh ใหม่:"
  echo "  - ดาวน์โหลด: https://nodejs.org/en/download"
  echo "  - macOS:      brew install node"
  echo "  - Debian/Ubuntu: sudo apt install nodejs"
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
node "$HERE/scripts/install.mjs"
