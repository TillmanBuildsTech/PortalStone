@echo off
rem Install Portalstone as a Windows service. Double-click, approve the UAC prompt.
rem Extra arguments pass through, e.g. install-service.cmd --print
setlocal
net session >nul 2>&1
if %errorlevel%==0 goto :run
echo Asking for administrator rights...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
exit /b
:run
cd /d "%~dp0.."
node "%~dp0install-service.mjs" %*
echo.
pause
