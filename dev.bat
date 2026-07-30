@echo off
chcp 65001 > nul
echo ============================================
echo   Lumina Life 2.0 — 开发模式启动
echo ============================================
echo.
echo [1/2] 安装依赖 (国内镜像加速)...
call npm install --legacy-peer-deps --registry https://registry.npmmirror.com
if %errorlevel% neq 0 (
    echo [WARN] npm install 失败, 尝试官方源...
    call npm install --legacy-peer-deps
)
echo.
echo [2/2] 启动开发服务器 + Electron 窗口...
call npm run dev
pause
