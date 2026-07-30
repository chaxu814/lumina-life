@echo off
chcp 65001 >nul
title Lumina Life — 开发环境设置

echo ============================================
echo  Lumina Life — 开发环境设置
echo ============================================
echo.

:: ── 检查 Node.js ──────────────────────────────
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo ✅ Node.js 已就绪
    node --version
) else (
    echo 🔍 正在查找 Node.js...
    if exist "C:\Program Files\nodejs\node.exe" (
        echo ✅ 在 C:\Program Files\nodejs\ 找到 Node.js
        set "PATH=C:\Program Files\nodejs;%PATH%"
        echo ⚡ 已临时添加到当前会话的 PATH
        echo    要永久添加，请手动将 C:\Program Files\nodejs 加入系统环境变量
    ) else (
        echo ❌ 未找到 Node.js！
        echo.
        echo 请从 https://nodejs.org 下载安装 Node.js v18+
        echo 或使用便携版：https://nodejs.org/dist/
        pause
        exit /b 1
    )
)

echo.
echo ── 验证 npm ──
call npm --version

echo.
echo ── 验证构建工具 ──
call npx tsc --version
call npx vite --version

echo.
echo ── 依赖检查 ──
if exist node_modules (
    echo ✅ node_modules 已存在
) else (
    echo 📦 安装依赖...
    call npm install
)

echo.
echo ============================================
echo  开发命令:
echo.
echo  npm run dev       — 启动开发服务器（热重载）
echo  npm run build     — 构建到 out/
echo  npm run test      — 运行测试
echo  npm run pack:win  — 打包为 Windows 安装程序
echo.
echo  npx tsc --noEmit  — 只检查类型错误（不输出文件）
echo ============================================
echo.
echo 项目根目录: %CD%
echo.
pause
