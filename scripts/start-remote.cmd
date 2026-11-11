@echo off
setlocal
cd /d "%~dp0.."
if "%~1"=="" (
  echo Usage: scripts\start-remote.cmd edit.example.com
  echo Use the exact hostname configured in Cloudflare Tunnel and Access.
  exit /b 2
)
if not exist "dist\index.html" (
  echo Frontend build not found. Run: npm run build
  exit /b 3
)
set "ROAD_EDITOR_PUBLIC_HOST=%~1"
set "ROAD_EDITOR_SERVE_FRONTEND=1"
set "ROAD_EDITOR_SECURE_COOKIES=1"
echo Backend and Vue UI: http://127.0.0.1:8000
 echo Cloudflare public hostname: https://%ROAD_EDITOR_PUBLIC_HOST%
 echo Keep this console running. Do NOT open port 8000 on the router.
py -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
