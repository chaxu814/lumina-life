@echo off
chcp 65001 > nul

if "%1"=="" (
    echo Lumina Life — 命令行工具
    echo.
    echo 用法:
    echo   lumina ^<命令^> [参数]
    echo.
    echo 命令:
    echo   chat    向 Lumina 发送消息
    echo   tool    执行工具
    echo   agent   查看 Agent 状态
    echo   memory  搜索记忆
    echo   config  管理配置
    echo   skill   管理技能
    echo   cron    管理定时任务
    echo   doctor  系统诊断
    echo.
    echo 示例:
    echo   lumina chat "今天天气怎么样"
    echo   lumina doctor
    echo   lumina --help
    goto :eof
)

set SCRIPT_DIR=%~dp0

:: 打包态判定：本脚本随安装包落在 <resources>\，同层应存在 app.asar。
:: 安装后的 exe 会自动加载 app.asar，只需带 --cli，不再外部传 asar 内部路径。
if exist "%SCRIPT_DIR%app.asar" (
    set ELECTRON_PATH=%SCRIPT_DIR%..\Lumina Life.exe
    goto :run-packaged
)

:: 开发态：electron 来自 node_modules。
set ELECTRON_PATH=
if exist "%SCRIPT_DIR%node_modules\.bin\electron.cmd" set ELECTRON_PATH=%SCRIPT_DIR%node_modules\.bin\electron.cmd
if exist "%SCRIPT_DIR%node_modules\electron\dist\electron.exe" set ELECTRON_PATH=%SCRIPT_DIR%node_modules\electron\dist\electron.exe
if "%ELECTRON_PATH%"=="" (
    where electron >nul 2>nul
    if %errorlevel% equ 0 (
        set ELECTRON_PATH=electron
    ) else (
        echo [错误] 未找到 Electron。请先运行 npm install。
        exit /b 1
    )
)
set MAIN_ENTRY=%SCRIPT_DIR%out\main\index.js

if not exist "%MAIN_ENTRY%" (
    echo [错误] 未找到构建产物。请先运行 npm run build。
    echo   [期望路径] %MAIN_ENTRY%
    exit /b 1
)
"%ELECTRON_PATH%" --no-sandbox "%MAIN_ENTRY%" --cli %*
goto :eof

:run-packaged
if not exist "%ELECTRON_PATH%" (
    echo [错误] 未找到应用本体: %ELECTRON_PATH%
    exit /b 1
)
"%ELECTRON_PATH%" --no-sandbox --cli %*
