@echo off
title Steam Tool (no auto-update)
cd /d "%~dp0"

:: 逃生入口:绕过 launcher / 远程更新,直接运行当前 app/。
:: 当自动更新出问题、或想跑本地未发布版本时使用。

if not exist ".env" if exist ".env.example" copy .env.example .env >nul

set "APP_ROOT=%~dp0"
echo ============================================
echo   Steam Tool  (direct mode, auto-update OFF)
echo ============================================
echo.
node src\main.ts
set ERR=%errorlevel%
echo.
echo Server stopped (exit code: %ERR%)
pause
