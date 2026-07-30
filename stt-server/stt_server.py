"""
Lumina STT Server — 语音识别服务
基于 Whisper 的 WebSocket 语音转写

启动: python stt_server.py --port 18922
"""
import asyncio
import json
import sys
import struct
import os
import argparse
import hashlib
import base64

MODEL = None
MODEL_TYPE = None

def load_model(model_size: str = "base"):
    global MODEL, MODEL_TYPE
    try:
        import whisper
        print(f"[STT] 加载 Whisper 模型: {model_size}")
        MODEL = whisper.load_model(model_size)
        MODEL_TYPE = "whisper"
        print("[STT] Whisper 模型加载完成")
        return True
    except ImportError:
        print("[STT] whisper 未安装")
    except Exception as e:
        print(f"[STT] Whisper 加载失败: {e}")

    try:
        import vosk
        model_path = os.environ.get("VOSK_MODEL_PATH", "models/vosk-model-small-cn-0.22")
        if os.path.exists(model_path):
            print(f"[STT] 加载 Vosk 模型: {model_path}")
            MODEL = vosk.Model(model_path)
            MODEL_TYPE = "vosk"
            print("[STT] Vosk 模型加载完成")
            return True
    except ImportError:
        print("[STT] vosk 未安装")
    except Exception as e:
        print(f"[STT] Vosk 加载失败: {e}")

    print("[STT] 无可用的 STT 模型，使用模拟模式")
    MODEL_TYPE = "mock"
    return True


def transcribe(audio_data: bytes, sample_rate: int = 16000) -> str:
    if MODEL_TYPE == "whisper":
        import numpy as np
        audio = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0
        result = MODEL.transcribe(audio, language="zh", fp16=False)
        return result.get("text", "").strip()
    elif MODEL_TYPE == "vosk":
        rec = vosk.KaldiRecognizer(MODEL, sample_rate)
        rec.AcceptWaveform(audio_data)
        result = json.loads(rec.FinalResult())
        return result.get("text", "").strip()
    elif MODEL_TYPE == "mock":
        return "[模拟识别] 音频已接收"
    return ""


import http.server
import socketserver


class STTHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/status":
            self._json({"running": True, "model": MODEL_TYPE, "ok": MODEL_TYPE is not None})
        elif self.path == "/ws":
            self._ws_upgrade()
        else:
            self._text(200, "Lumina STT Server v1.0\nGET /status\nGET /ws (16kHz PCM)")

    def do_POST(self):
        if self.path == "/transcribe":
            content_length = int(self.headers.get("Content-Length", 0))
            audio_data = self.rfile.read(content_length)
            text = transcribe(audio_data)
            self._json({"text": text, "ok": True})
        else:
            self._text(404, "Not Found")

    def _json(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

    def _text(self, code, text):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(text.encode() if isinstance(text, str) else text)

    def _ws_upgrade(self):
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            self._text(400, "Missing Sec-WebSocket-Key")
            return

        magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        accept = base64.b64encode(hashlib.sha1((key + magic).encode()).digest()).decode()

        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

        buffer = b""
        last_text = ""

        try:
            while True:
                header = self.rfile.read(2)
                if len(header) < 2: break

                opcode = header[0] & 0x0F
                if opcode == 0x8: break
                if opcode == 0x9:
                    self.rfile.read(2)
                    self.wfile.write(bytes([0x8A, 0x00]))
                    continue

                masked = (header[1] & 0x80) != 0
                length = header[1] & 0x7F
                if length == 126: length = struct.unpack(">H", self.rfile.read(2))[0]
                elif length == 127: length = struct.unpack(">Q", self.rfile.read(8))[0]

                mask_key = self.rfile.read(4) if masked else None
                payload = self.rfile.read(length)
                if masked and mask_key:
                    payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))

                if opcode == 0x1:
                    msg = payload.decode("utf-8", errors="ignore")
                    data = json.loads(msg)
                    if data.get("type") == "transcribe":
                        if buffer:
                            text = transcribe(buffer)
                            buffer = b""
                            if text and text != last_text:
                                self._ws_send({"type": "transcription", "text": text, "is_final": True})
                                last_text = text
                                print(f"[STT] {text}")
                elif opcode == 0x2:
                    buffer += payload
                    if len(buffer) >= 32000:
                        text = transcribe(buffer)
                        buffer = b""
                        if text and text != last_text:
                            self._ws_send({"type": "transcription", "text": text, "is_final": True})
                            last_text = text
                            print(f"[STT] {text}")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _ws_send(self, data):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        frame = bytes([0x81])
        length = len(payload)
        if length < 126: frame += bytes([length])
        elif length < 65536: frame += bytes([126]) + struct.pack(">H", length)
        else: frame += bytes([127]) + struct.pack(">Q", length)
        frame += payload
        try:
            self.wfile.write(frame)
        except: pass


class ThreadedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18922)
    parser.add_argument("--model", type=str, default="base")
    args = parser.parse_args()
    load_model(args.model)
    server = ThreadedServer(("127.0.0.1", args.port), STTHandler)
    print(f"[STT] Lumina STT Server: http://127.0.0.1:{args.port} (模型: {MODEL_TYPE})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[STT] 关闭...")
        server.shutdown()


if __name__ == "__main__":
    main()
