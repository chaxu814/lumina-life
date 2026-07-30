@echo off
chcp 65001 >nul
cd /d "%~dp0dist\win-unpacked"

:: 先干掉残留的旧进程，强制重启
taskkill /F /IM "Lumina Life.exe" 2>nul

:: 等一秒确保杀干净
timeout /t 1 /nobreak >nul

:: 启动新实例
start "" "Lumina Life.exe"

echo ✅ Lumina 已启动，请稍候...
exit
