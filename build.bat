@echo off
chcp 65001 > nul
echo ============================================
echo   Lumina Life 2.0 — 构建安装包
echo ============================================
echo.
echo [1/2] 构建 Electron 应用...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] 构建失败!
    pause
    exit /b 1
)
echo.
echo [2/2] 打包 Windows 安装包...
call npm run pack:win
if %errorlevel% neq 0 (
    echo [ERROR] 打包失败!
    pause
    exit /b 1
)
echo.
echo ============================================
echo   构建完成! 安装包位于 dist\ 目录
echo ============================================
pause
