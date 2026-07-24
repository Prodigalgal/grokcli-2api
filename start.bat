@echo off
setlocal
cd /d %~dp0node
if not exist node_modules call npm ci || exit /b 1
call npm run build || exit /b 1
call npm start
