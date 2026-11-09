@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules\vite (
  echo Installing project dependencies for the first run...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
start "Yosif Orders" cmd /k "npm run dev"
timeout /t 3 >nul
start "" http://localhost:5173
