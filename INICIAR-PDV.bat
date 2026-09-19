@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Instale o Node.js 24 LTS antes de iniciar. Consulte README.md.
  pause
  exit /b 1
)
node src/server.mjs
pause
