#!/usr/bin/env bash
# Lumina Life 2.0 — 开发模式启动脚本 (macOS / Linux)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  Lumina Life 2.0 — 开发模式启动"
echo "============================================"
echo ""

echo "[1/2] 安装依赖..."
npm install --legacy-peer-deps

echo ""
echo "[2/2] 启动开发服务器 + Electron 窗口..."
npm run dev
