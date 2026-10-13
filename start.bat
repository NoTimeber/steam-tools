@echo off
title Steam Tool

cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js ^>= 20.12
    echo Download: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Check dependencies
if not exist "node_modules\" (
    echo [INFO] First run - installing dependencies...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] npm install failed. Check the errors above.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [OK] Dependencies installed.
    echo.
)

:: Check .env
if not exist ".env" (
    echo [INFO] .env not found, copied from .env.example
    copy .env.example .env >nul
    echo.
)

:: Read port from .env
set "PORT=53110"
for /f "tokens=2 delims==" %%a in ('findstr /b "PORT=" .env 2^>nul') do set "PORT=%%a"
if "%PORT%"=="" set "PORT=53110"

echo ============================================
echo   Steam Tool
echo   URL: http://127.0.0.1:%PORT%/login
echo   Close this window to stop the server
echo ============================================
echo.

node launcher.js
set ERR=%errorlevel%

echo.
echo ============================================
echo   Server stopped (exit code: %ERR%)
echo ============================================
echo.
pause
