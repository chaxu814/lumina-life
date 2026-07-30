"""
Lumina Agent Node — STT Handler (Whisper + Vosk 双备)
从 stt_server.py 提取，核心逻辑不变
"""

import json, os, struct, asyncio
from ..config import STT_WHISPER_MODEL_SIZE, STT_SAMPLE_RATE

MODEL = None
MODEL_TYPE = None
_ready = False
_error = None

def log(msg):
    try:
        print(f"[STT] {msg}", flush=True)
    except UnicodeEncodeError:
        print(f"[STT] {msg.encode('ascii', errors='replace').decode('ascii')}", flush=True)

def init(model_size: str = None):
    global MODEL, MODEL_TYPE, _ready, _error
    model_size = model_size or STT_WHISPER_MODEL_SIZE

    # 尝试 Whisper
    try:
        import whisper
        log(f"加载 Whisper 模型: {model_size}")
        MODEL = whisper.load_model(model_size)
        MODEL_TYPE = "whisper"
        _ready = True
        log("Whisper 就绪")
        return True
    except ImportError:
        log("whisper 未安装")
    except Exception as e:
        log(f"Whisper 加载失败: {e}")

    # 备选 Vosk
    try:
        import vosk
        model_path = os.environ.get("VOSK_MODEL_PATH", "models/vosk-model-small-cn-0.22")
        if os.path.exists(model_path):
            log(f"加载 Vosk 模型: {model_path}")
            MODEL = vosk.Model(model_path)
            MODEL_TYPE = "vosk"
            _ready = True
            log("Vosk 就绪")
            return True
    except ImportError:
        log("vosk 未安装")
    except Exception as e:
        log(f"Vosk 加载失败: {e}")

    log("无可用的 STT 模型，使用模拟模式")
    MODEL_TYPE = "mock"
    _ready = True
    return True

def health() -> dict:
    return {"ready": _ready, "error": _error, "model": MODEL_TYPE}

def transcribe(audio_data: bytes, sample_rate: int = None) -> str:
    """将 PCM 音频数据转写为文字"""
    sr = sample_rate or STT_SAMPLE_RATE

    if MODEL_TYPE == "whisper":
        import numpy as np
        audio = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0
        result = MODEL.transcribe(audio, language="zh", fp16=False)
        return result.get("text", "").strip()
    elif MODEL_TYPE == "vosk":
        import vosk
        rec = vosk.KaldiRecognizer(MODEL, sr)
        rec.AcceptWaveform(audio_data)
        result = json.loads(rec.FinalResult())
        return result.get("text", "").strip()
    elif MODEL_TYPE == "mock":
        return "[模拟识别] 音频已接收"
    return ""

async def handle_transcribe(params: dict) -> dict:
    """处理语音识别请求"""
    audio_hex = params.get("audio")
    if not audio_hex:
        return {"error": "audio is required"}
    try:
        audio_data = bytes.fromhex(audio_hex)
    except ValueError:
        return {"error": "audio 不是有效的 hex 编码"}
    sample_rate = params.get("sample_rate", STT_SAMPLE_RATE)
    text = transcribe(audio_data, sample_rate)
    return {"text": text}
