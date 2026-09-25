@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Node.js not found.
  echo       Install it first:  https://nodejs.org   (pick the LTS version)
  echo.
  pause
  exit /b 1
)

echo.
echo   vocab-reader is starting...
echo   Open http://localhost:5173
echo   (Ctrl+C or close this window to stop)
echo.
node server.js
pause
