"""
Lumina Agent Node — 配置常量
"""

# ── 端口 ────────────────────────────────────────────
HTTP_PORT = 18925       # HTTP REST 端口
WS_PORT = 18926         # WebSocket 端口

# ── TTS ─────────────────────────────────────────────
TTS_DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
TTS_DEFAULT_SPEED = 1.0

# ── STT ─────────────────────────────────────────────
STT_WHISPER_MODEL_SIZE = "base"          # tiny/base/small/medium/large
STT_SAMPLE_RATE = 16000

# ── Embedding ───────────────────────────────────────
EMBED_DEFAULT_MODEL = "all-MiniLM-L6-v2"

# ── 服务发现 ───────────────────────────────────────
SERVICE_NAME = "lumina-agent-node"
HEALTH_CHECK_INTERVAL = 30  # 秒

# ── 路径 ─────────────────────────────────────────────
import os
import sys

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(NODE_DIR)  # python/
os.makedirs(os.path.join(PROJECT_DIR, "models"), exist_ok=True)
