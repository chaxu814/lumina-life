"""
Lumina Agent Node — TTS Handler
从 edge_tts_server.py 提取，核心逻辑不变
"""

import json, tempfile, os, asyncio
from ..config import TTS_DEFAULT_VOICE, TTS_DEFAULT_SPEED

_ready = False
_error = None

def log(msg):
    try:
        print(f"[TTS] {msg}", flush=True)
    except UnicodeEncodeError:
        print(f"[TTS] {msg.encode('ascii', errors='replace').decode('ascii')}", flush=True)

def init():
    global _ready, _error
    try:
        import edge_tts  # noqa: F401 — 仅验证可导入
        _ready = True
        log("Edge-TTS 就绪")
        return True
    except ImportError:
        _error = "edge-tts 未安装 (pip install edge-tts)"
        log(_error)
        return False
    except Exception as e:
        _error = str(e)
        log(f"初始化失败: {e}")
        return False

def health() -> dict:
    return {"ready": _ready, "error": _error, "engine": "edge-tts"}

async def generate(text: str, voice: str = None, speed: float = None) -> bytes:
    """异步生成 TTS，返回 mp3 bytes"""
    import edge_tts
    voice = voice or TTS_DEFAULT_VOICE
    speed = speed if speed is not None else TTS_DEFAULT_SPEED
    rate_str = f"{int((speed - 1.0) * 100):+d}%"
    communicate = edge_tts.Communicate(text, voice, rate=rate_str)
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        await communicate.save(f.name)
        tmp_path = f.name
    with open(tmp_path, "rb") as f:
        data = f.read()
    os.unlink(tmp_path)
    return data

async def handle_tts(params: dict) -> dict:
    """处理 TTS 请求"""
    text = params.get("text", "")
    if not text:
        return {"error": "text is required"}
    voice = params.get("voice", TTS_DEFAULT_VOICE)
    speed = float(params.get("speed", TTS_DEFAULT_SPEED))
    log(f"'{text[:40]}...' voice={voice}")
    try:
        audio = await generate(text, voice, speed)
        return {"audio": audio.hex(), "format": "mp3"}
    except Exception as e:
        log(f"生成失败: {e}")
        return {"error": str(e)}
