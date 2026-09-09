@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12+ or 24+ first. See README.md.
  pause
  exit /b 1
)
if not exist node_modules\.package-lock.json (
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Open http://127.0.0.1:5180 in your browser.
call npm run build
if errorlevel 1 (
  pause
  exit /b 1
)
call npm start
pause
