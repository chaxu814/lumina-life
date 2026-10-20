# ============================================================
# Lumina Life — Headless 镜像（CLI / API 模式，无 GUI）
#
# 桌宠本体是 Electron 桌面应用，需要桌面环境；本镜像提供「无头」用法：
# 容器里跑内置 HTTP API（--api），用 xvfb 为 Electron 提供一个虚拟显示。
# 适合：自托管、被其它程序通过 HTTP 调用 Lumina 的 agent / 记忆 / 工具。
#
# 构建：docker build -t lumina-life:headless .
# 运行：docker run -p 3456:3456 \
#         -e LUMINA_API_KEY=your-key \
#         -v lumina-data:/root/.local/share/lumina-life \
#         lumina-life:headless
# ============================================================
FROM node:22-bookworm-slim

# Electron 运行时依赖 + xvfb（虚拟显示）
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
    libatspi2.0-0 libdrm2 libgbm1 libasound2 libsecret-1-0 \
    xdg-utils libfuse2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package*.json ./
RUN npm ci

# 拷贝源码并构建
COPY . .
RUN npm run build && npm run rebuild:electron

# 数据目录（记忆库等）；Electron 以 root 运行时 home 为 /root，
# 也可通过 LUMINA_DATA_DIR 显式指定（建议挂载卷）。
ENV LUMINA_API_ENABLED=1 \
    LUMINA_API_HOST=0.0.0.0 \
    LUMINA_API_PORT=3456 \
    LUMINA_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 3456

# xvfb-run 提供虚拟显示，Electron 以 API 模式常驻
# --disable-gpu：容器里没有真实 GPU，xvfb 也不提供硬件加速；不禁用的话
# Chromium 会反复重启 GPU 进程，累计崩溃后整个进程 FATAL 退出（2026-10-20 实测）。
# 应用层在 --api 模式下也会调 app.disableHardwareAcceleration()，这里是双保险。
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1024x768x24", \
     "node_modules/electron/dist/electron", "--no-sandbox", "--disable-gpu", \
     "out/main/index.js", "--api"]
