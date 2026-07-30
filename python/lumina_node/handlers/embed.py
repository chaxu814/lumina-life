"""
Lumina Agent Node — Embedding Handler (sentence-transformers)
从 embedding_server.py 提取，核心逻辑不变
"""

import json, os
from ..config import EMBED_DEFAULT_MODEL

MODEL = None
MODEL_NAME = None
_ready = False
_error = None

def log(msg):
    try:
        print(f"[Embed] {msg}", flush=True)
    except UnicodeEncodeError:
        print(f"[Embed] {msg.encode('ascii', errors='replace').decode('ascii')}", flush=True)

def init(model_name: str = None):
    global MODEL, MODEL_NAME, _ready, _error
    model_name = model_name or EMBED_DEFAULT_MODEL
    try:
        from sentence_transformers import SentenceTransformer
        log(f"加载模型: {model_name}")
        MODEL = SentenceTransformer(model_name)
        MODEL_NAME = model_name
        # 预热
        _ = MODEL.encode("test")
        dim = MODEL.get_sentence_embedding_dimension()
        _ready = True
        log(f"就绪，向量维度: {dim}")
        return True
    except ImportError:
        _error = "sentence-transformers 未安装 (pip install sentence-transformers)"
        log(_error)
        return False
    except Exception as e:
        _error = str(e)
        log(f"加载失败: {e}")
        return False

def health() -> dict:
    return {
        "ready": _ready,
        "error": _error,
        "model": MODEL_NAME,
        "dimension": MODEL.get_sentence_embedding_dimension() if MODEL else 0,
    }

async def handle_embed(params: dict) -> dict:
    """批量文本 → 向量"""
    texts = params.get("texts", [])
    if not texts or not isinstance(texts, list):
        return {"error": "缺少 texts 参数"}
    if MODEL is None:
        return {"error": "模型未就绪"}
    try:
        embeddings = MODEL.encode(texts, normalize_embeddings=True).tolist()
        return {"embeddings": embeddings, "dimension": len(embeddings[0]) if embeddings else 0}
    except Exception as e:
        return {"error": str(e)}
