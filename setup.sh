#!/usr/bin/env bash
# Lumina Life 2.0 — 开发环境设置 (macOS / Linux)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  Lumina Life — 开发环境设置"
echo "============================================"
echo ""

# ── 检查 Node.js ──────────────────────────────
if command -v node &>/dev/null; then
  echo "✅ Node.js 已就绪"
  node --version
else
  echo "🔍 未找到 Node.js！"
  echo ""
  echo "请从 https://nodejs.org 下载安装 Node.js v18+"
  echo "或使用包管理器:"
  echo "  macOS: brew install node"
  echo "  Linux: apt install nodejs 或 nvm install 20"
  exit 1
fi

echo ""
echo "── 验证 npm ──"
npm --version

echo ""
echo "── 验证构建工具 ──"
npx tsc --version 2>/dev/null || echo "   (typescript 将在 npm install 后可用)"
npx vite --version 2>/dev/null || echo "   (vite 将在 npm install 后可用)"

echo ""
echo "── 依赖检查 ──"
if [ -d node_modules ]; then
  echo "✅ node_modules 已存在"
else
  echo "📦 安装依赖..."
  npm install
fi

echo ""
echo "============================================"
echo "  开发命令:"
echo ""
echo "  npm run dev       — 启动开发服务器（热重载）"
echo "  npm run build     — 构建到 out/"
echo "  npm run test      — 运行测试"
echo "  npm run pack:mac  — 打包为 macOS 安装程序 (dmg)"
echo "  npm run pack:linux— 打包为 Linux 安装程序 (AppImage)"
echo ""
echo "  npx tsc --noEmit  — 只检查类型错误（不输出文件）"
echo "============================================"
echo ""
echo "项目根目录: $(pwd)"
