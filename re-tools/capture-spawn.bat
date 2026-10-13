@echo off
setlocal
set "STEAM=D:\steam\steam.exe"
set "SCRIPT=%~dp0cs2-gc-capture.js"

echo ============================================================
echo   CS2 GC capture - SPAWN mode (use if ATTACH catches nothing)
echo   Will FORCE-CLOSE Steam and relaunch it under Frida.
echo ============================================================
echo.

where frida >nul 2>nul
if errorlevel 1 goto NOFRIDA
if not exist "%STEAM%" goto NOSTEAMEXE
if not exist "%SCRIPT%" goto NOSCRIPT

tasklist /FI "IMAGENAME eq steam.exe" 2>nul | find /I "steam.exe" >nul
if errorlevel 1 goto RUN
echo [*] Steam is running. Press any key to FORCE-CLOSE and relaunch under Frida,
echo     or close this window to cancel.
pause >nul
taskkill /F /IM steam.exe >nul 2>nul
taskkill /F /IM steamwebhelper.exe >nul 2>nul
taskkill /F /IM steamservice.exe >nul 2>nul
timeout /t 3 /nobreak >nul

:RUN
echo [*] Launching Steam under Frida... then: log in -^> start CS2 -^> Inventory -^> Unseal
echo.
frida -f "%STEAM%" --runtime=v8 -l "%SCRIPT%"
echo.
echo [*] Frida exited.
pause
exit /b 0

:NOFRIDA
echo [ERROR] frida not found. Install:  pip install frida-tools
pause
exit /b 1

:NOSTEAMEXE
echo [ERROR] Steam not found: %STEAM%   (edit STEAM path at top of this file)
pause
exit /b 1

:NOSCRIPT
echo [ERROR] capture script not found next to this .bat:
echo         %SCRIPT%
echo         Keep cs2-gc-capture.js in the SAME folder as this .bat.
pause
exit /b 1