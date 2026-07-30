#!/usr/bin/env bash
# Lumina Life 2.0 — 构建安装包 (macOS / Linux)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  Lumina Life 2.0 — 构建安装包"
echo "============================================"
echo ""

OS="$(uname -s)"

echo "[1/2] 构建 Electron 应用..."
npm run build

echo ""
echo "[2/2] 打包..."
case "$OS" in
  Darwin)
    echo "  → macOS: 构建 dmg + zip"
    npm run pack:mac
    echo ""
    echo "============================================"
    echo "  构建完成! 安装包位于 dist/ 目录"
    echo "============================================"
    ;;
  Linux)
    echo "  → Linux: 构建 AppImage + deb"
    npm run pack:linux
    echo ""
    echo "============================================"
    echo "  构建完成! 安装包位于 dist/ 目录"
    echo "============================================"
    ;;
  *)
    echo "未知系统: $OS"
    exit 1
    ;;
esac
