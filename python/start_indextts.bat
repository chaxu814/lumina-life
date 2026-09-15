@echo off
chcp 65001 >nul 2>&1
title Lumina × IndexTTS-2.5 TTS 服务

echo ═══════════════════════════════════════════════════
echo   Lumina × IndexTTS-2.5 TTS 服务启动器
echo ═══════════════════════════════════════════════════
echo.

REM ── 配置 ──
set MODEL_DIR=K:\IndexTTS-2.5
set PORT=18927

REM ── 查找 Python 3.10/3.11 ──
set PYTHON_CMD=

REM 优先检查 py launcher
py -3.11 --version >nul 2>&1
if %errorlevel%==0 (
    set PYTHON_CMD=py -3.11
    goto :found
)

py -3.10 --version >nul 2>&1
if %errorlevel%==0 (
    set PYTHON_CMD=py -3.10
    goto :found
)

REM 检查常见安装路径
for %%P in (
    "C:\Python311\python.exe"
    "C:\Python310\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
) do (
    if exist %%P (
        set PYTHON_CMD=%%~P
        goto :found
    )
)

echo [错误] 未找到 Python 3.10 或 3.11！
echo.
echo IndexTTS-2.5 需要 Python 3.10 ~ 3.11。
echo 当前系统 Python 版本不兼容。
echo.
echo 请安装 Python 3.11: https://www.python.org/downloads/release/python-3119/
echo 安装后运行: pip install indextts
echo.
pause
exit /b 1

:found
echo [√] 找到 Python: %PYTHON_CMD%
%PYTHON_CMD% --version

REM ── 检查 indextts 包 ──
%PYTHON_CMD% -c "import indextts" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [!] indextts 包未安装，正在安装...
    %PYTHON_CMD% -m pip install indextts
    if %errorlevel% neq 0 (
        echo.
        echo [错误] indextts 安装失败，请手动运行:
        echo   %PYTHON_CMD% -m pip install indextts
        echo.
        pause
        exit /b 1
    )
)

echo.
echo [√] indextts 已安装
echo [√] 模型目录: %MODEL_DIR%
echo [√] 端口: %PORT%
echo.
echo 正在启动服务...（首次加载模型需要 10-30 秒）
echo 按 Ctrl+C 停止服务
echo ═══════════════════════════════════════════════════
echo.

%PYTHON_CMD% "%~dp0indextts_server.py" --model-dir "%MODEL_DIR%" --port %PORT%

pause
