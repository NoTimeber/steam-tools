@echo off
setlocal
set "SCRIPT=%~dp0cs2-gc-capture.js"

echo ============================================================
echo   CS2 GC capture - ATTACH mode (try this FIRST)
echo ============================================================
echo.
echo   Steps:
echo     1) Steam logged in, and CS2 NOT started yet
echo     2) Run this script (attaches to steam.exe)
echo     3) Wait for line:  hooked CreateInterface ...
echo     4) THEN launch CS2 -^> Inventory -^> click Unseal on a terminal
echo     5) Look below for:  GC Send  msgType=...  hex...
echo.

where frida >nul 2>nul
if errorlevel 1 goto NOFRIDA
if not exist "%SCRIPT%" goto NOSCRIPT

tasklist /FI "IMAGENAME eq steam.exe" 2>nul | find /I "steam.exe" >nul
if errorlevel 1 goto NOSTEAM

echo [*] attaching to steam.exe ...  (quit: Ctrl+C, or type q then Enter)
echo.
frida -n steam.exe --runtime=v8 -l "%SCRIPT%"
echo.
echo [*] Frida exited.
pause
exit /b 0

:NOFRIDA
echo [ERROR] frida not found. Install:  pip install frida-tools
pause
exit /b 1

:NOSCRIPT
echo [ERROR] capture script not found next to this .bat:
echo         %SCRIPT%
echo         Keep cs2-gc-capture.js in the SAME folder as this .bat.
pause
exit /b 1

:NOSTEAM
echo [ERROR] Steam is not running. Start and log into Steam first.
pause
exit /b 1