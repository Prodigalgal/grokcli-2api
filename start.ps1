$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "node")
if (-not (Test-Path "node_modules")) {
  npm ci
}
npm run build
npm start
