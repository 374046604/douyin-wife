@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 20 或更高版本，再双击此文件。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 正在首次安装运行组件，请稍候...
  call npm install --include=dev
  if errorlevel 1 (
    echo 运行组件安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

start "潮汐观察台" /b cmd /c "npm run start"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8787"
echo 观察台正在运行。关闭此窗口会停止本地服务。
pause
