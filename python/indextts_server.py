"""
Lumina × IndexTTS-2.5 — 独立 HTTP TTS 服务

用法:
  python indextts_server.py --model-dir K:\\IndexTTS-2.5 --port 18927

需要:
  - Python 3.10 ~ 3.11
  - NVIDIA GPU (约 6GB VRAM)
  - pip install indextts (或从 GitHub 安装)
  - 首次运行会自动下载辅助模型到 hf_cache/

API:
  GET  /health                      → {"ready": true/false, "error": "..."}
  POST /tts                         → {"audio": "<wav hex>", "format": "wav"}
    body: {
      "text": "你好",
      "lang": "ZH",                 # ZH/EN/JA/ES/AR
      "ref_audio": "prompt.wav",    # 参考音频路径（声音克隆）
      "emo_vector": [0,0,0,0,0,0,0,0.8],  # 8维情绪 [happy,angry,sad,afraid,disgusted,melancholic,surprised,calm]
      "duration_factor": 1.0,       # >1 变慢, <1 变快 (0.5~2.0)
      "use_random_emo": false       # 随机情绪
    }
"""

import argparse
import asyncio
import json
import os
import sys
import tempfile
import traceback
from typing import Any, Optional

# ── 全局状态 ──────────────────────────────────────
tts_model = None
model_dir = ""
load_error = None
ready = False

# 情绪标签 → 8维向量
EMOTION_PRESETS = {
    "calm":      [0, 0, 0, 0, 0, 0, 0, 0.8],
    "happy":     [0.8, 0, 0, 0, 0, 0, 0, 0],
    "angry":     [0, 0.8, 0, 0, 0, 0, 0, 0],
    "sad":       [0, 0, 0.8, 0, 0, 0, 0, 0],
    "afraid":    [0, 0, 0, 0.8, 0, 0, 0, 0],
    "disgusted": [0, 0, 0, 0, 0.8, 0, 0, 0],
    "melancholic":[0, 0, 0, 0, 0, 0.8, 0, 0],
    "surprised": [0, 0, 0, 0, 0, 0, 0.8, 0],
    "neutral":   [0, 0, 0, 0, 0, 0, 0, 0],
}


def log(msg: str):
    try:
        print(f"[IndexTTS] {msg}", flush=True)
    except UnicodeEncodeError:
        print(f"[IndexTTS] {msg.encode('ascii', errors='replace').decode('ascii')}", flush=True)


def load_model():
    """延迟加载 IndexTTS2 模型"""
    global tts_model, load_error, ready
    if tts_model is not None:
        return True
    if load_error is not None:
        return False

    try:
        log(f"正在加载 IndexTTS-2.5 模型: {model_dir}")
        from indextts.infer_v2_5 import IndexTTS2

        cfg_path = os.path.join(model_dir, "config.yaml")
        if not os.path.exists(cfg_path):
            load_error = f"config.yaml 不存在于 {model_dir}"
            log(load_error)
            return False

        # use_bf16 在支持的 GPU 上更快
        tts_model = IndexTTS2(
            cfg_path=cfg_path,
            model_dir=model_dir,
            use_bf16=True,
        )
        ready = True
        log("✅ IndexTTS-2.5 模型加载完成")
        return True
    except ImportError as e:
        load_error = f"indextts 包未安装: {e}。请运行: pip install indextts (需要 Python 3.10-3.11)"
        log(load_error)
        return False
    except Exception as e:
        load_error = f"模型加载失败: {e}"
        log(load_error)
        traceback.print_exc()
        return False


async def generate_tts(params: dict) -> dict:
    """生成语音，返回 WAV bytes"""
    text = params.get("text", "").strip()
    if not text:
        return {"error": "text is required"}

    if not load_model():
        return {"error": load_error or "模型未就绪"}

    lang = params.get("lang", "ZH").upper()
    ref_audio = params.get("ref_audio", "")
    duration_factor = float(params.get("duration_factor", 1.0))
    use_random = bool(params.get("use_random_emo", False))

    # 情绪向量
    emo_vector = params.get("emo_vector", None)
    emo_label = params.get("emotion", "")
    if emo_vector is None and emo_label and emo_label in EMOTION_PRESETS:
        emo_vector = EMOTION_PRESETS[emo_label]

    # 如果没有参考音频，使用模型目录下的默认参考音频（如果有）
    if not ref_audio:
        default_ref = os.path.join(model_dir, "default_ref.wav")
        if os.path.exists(default_ref):
            ref_audio = default_ref
        else:
            return {"error": "需要提供参考音频 (ref_audio) 用于声音克隆，或在模型目录放置 default_ref.wav"}

    if not os.path.exists(ref_audio):
        return {"error": f"参考音频不存在: {ref_audio}"}

    # 输出到临时文件
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        output_path = f.name

    try:
        log(f"合成: '{text[:40]}...' lang={lang} emo={emo_label or emo_vector}")

        # 在线程池中运行同步推理
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: tts_model.infer(
                spk_audio_prompt=ref_audio,
                text=text,
                lang=lang,
                output_path=output_path,
                emo_vector=emo_vector if emo_vector else None,
                duration_factor=duration_factor,
                use_random=use_random,
            )
        )

        with open(output_path, "rb") as f:
            wav_data = f.read()

        log(f"生成完成: {len(wav_data)} bytes")
        return {"audio": wav_data.hex(), "format": "wav"}

    except Exception as e:
        log(f"合成失败: {e}")
        traceback.print_exc()
        return {"error": str(e)}
    finally:
        try:
            os.unlink(output_path)
        except:
            pass


# ── HTTP Server ───────────────────────────────────

class HTTPProtocol(asyncio.Protocol):
    _routes = {}

    @classmethod
    def add_route(cls, method, path, handler):
        cls._routes[(method.upper(), path)] = handler

    def connection_made(self, transport):
        self.transport = transport
        self.buffer = b""

    def data_received(self, data):
        self.buffer += data
        if b"\r\n\r\n" not in self.buffer:
            return
        header_end = self.buffer.index(b"\r\n\r\n") + 4
        raw_headers = self.buffer[:header_end].decode("utf-8", errors="replace")
        body = self.buffer[header_end:]
        lines = raw_headers.split("\r\n")
        parts = lines[0].split(" ")
        if len(parts) < 2:
            self._send_error(400, "Bad Request")
            return
        method = parts[0].upper()
        path = parts[1].split("?")[0]
        content_length = 0
        for line in lines[1:]:
            if line.lower().startswith("content-length:"):
                content_length = int(line.split(":")[1].strip())
                break
        if len(body) < content_length:
            return
        asyncio.create_task(self._handle(method, path, body[:content_length]))

    async def _handle(self, method, path, body):
        if path == "/health" and method == "GET":
            return self._send_json({
                "status": "ok" if ready else "loading",
                "ready": ready,
                "engine": "indextts-2.5",
                "error": load_error,
                "model_dir": model_dir,
            })

        handler = self._routes.get((method, path))
        if handler is None:
            return self._send_error(404, f"Not Found: {method} {path}")
        try:
            params = json.loads(body.decode("utf-8")) if body else {}
            result = await handler(params)
            return self._send_json(result)
        except json.JSONDecodeError:
            return self._send_error(400, "Invalid JSON")
        except Exception as e:
            traceback.print_exc()
            return self._send_error(500, str(e))

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send_response(status, "application/json", body)

    def _send_error(self, status, message):
        self._send_json({"error": message}, status)

    def _send_response(self, status, content_type, body):
        status_map = {200: "OK", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error"}
        reason = status_map.get(status, "Unknown")
        response = (
            f"HTTP/1.1 {status} {reason}\r\n"
            f"Content-Type: {content_type}\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Access-Control-Allow-Origin: *\r\n"
            f"Connection: close\r\n\r\n"
        ).encode("ascii") + body
        self.transport.write(response)
        self.transport.close()


async def handle_tts(params):
    return await generate_tts(params)


async def main():
    global model_dir

    parser = argparse.ArgumentParser(description="Lumina × IndexTTS-2.5 HTTP Server")
    parser.add_argument("--model-dir", type=str, default=r"K:\IndexTTS-2.5",
                        help="IndexTTS-2.5 模型权重目录")
    parser.add_argument("--port", type=int, default=18927, help="HTTP 端口")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="监听地址")
    parser.add_argument("--preload", action="store_true", help="启动时立即加载模型（默认首次请求时加载）")
    args = parser.parse_args()

    model_dir = os.path.abspath(args.model_dir)

    log("🚀 Lumina × IndexTTS-2.5 TTS 服务")
    log(f"    模型目录: {model_dir}")
    log(f"    监听: http://{args.host}:{args.port}")
    log(f"    Python: {sys.version}")

    # 检查 indextts 是否可导入
    try:
        import indextts
        log(f"    indextts 包: 已安装")
    except ImportError:
        log("⚠️ indextts 包未安装！")
        log("   请用 Python 3.10-3.11 安装:")
        log("   pip install indextts")
        log("   或从源码: pip install git+https://github.com/index-tts/index-tts.git")

    HTTPProtocol.add_route("POST", "/tts", handle_tts)

    if args.preload:
        log("正在预加载模型...")
        load_model()

    loop = asyncio.get_event_loop()
    server = await loop.create_server(
        lambda: HTTPProtocol(),
        host=args.host,
        port=args.port,
    )
    log(f"✅ 服务已启动 → http://{args.host}:{args.port}")
    log(f"   GET  /health  — 健康检查")
    log(f"   POST /tts     — 语音合成")

    try:
        await asyncio.Future()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        await server.wait_closed()
        log("🛑 服务已停止")


if __name__ == "__main__":
    asyncio.run(main())
