# handoff-guard installer (Windows) — เช็ค Node.js ก่อน แล้วรัน installer จริง
# ใช้: pwsh -File install.ps1  (หรือ powershell -ExecutionPolicy Bypass -File install.ps1)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "X ไม่พบ Node.js — handoff-guard ต้องใช้ node รัน hooks/scripts" -ForegroundColor Red
  Write-Host "  ติดตั้ง Node.js ก่อน แล้วรัน install.ps1 ใหม่:"
  Write-Host "  - ดาวน์โหลด: https://nodejs.org/en/download"
  Write-Host "  - หรือ:      winget install OpenJS.NodeJS.LTS"
  exit 1
}
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$here/scripts/install.mjs"
