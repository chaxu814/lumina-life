"""Edge TTS Server - 使用 edge-tts 库，稳定可靠"""
import sys, os, json, tempfile, asyncio, argparse, threading, time
from http.server import HTTPServer, BaseHTTPRequestHandler

def log(msg):
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode('ascii', errors='replace').decode('ascii'), flush=True)

log("[EdgeTTS] Starting...")


def generate_tts(text: str, voice: str = "zh-CN-XiaoxiaoNeural", speed: float = 1.0) -> bytes:
    """同步生成 TTS，返回 mp3 bytes"""
    import edge_tts

    # 映射语速: edge-tts 用 +/- 百分比字符串
    rate_str = f"{int((speed - 1.0) * 100):+d}%"

    async def _gen():
        communicate = edge_tts.Communicate(text, voice, rate=rate_str)
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            await communicate.save(f.name)
            return f.name

    tmp_path = asyncio.run(_gen())
    with open(tmp_path, "rb") as f:
        data = f.read()
    os.unlink(tmp_path)
    return data


class TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # 安静模式

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _send_audio(self, mp3_bytes):
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(mp3_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(mp3_bytes)
        except Exception:
            pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"status": "ok"})
        else:
            self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        if self.path == "/tts":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length))
                text = body.get("text", "")
                if not text:
                    self._send_json({"error": "text is required"}, 400)
                    return
                voice = body.get("voice", "zh-CN-XiaoxiaoNeural")
                speed = float(body.get("speed", 1.0))
                log(f"[EdgeTTS] {text[:30]}...")
                mp3_bytes = generate_tts(text, voice, speed)
                self._send_audio(mp3_bytes)
            except Exception as e:
                log(f"[EdgeTTS] Error: {e}")
                self._send_json({"error": str(e)}, 500)
        else:
            self._send_json({"error": "Not found"}, 404)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18921)
    args = parser.parse_args()
    log(f"[EdgeTTS] Server on :{args.port}")
    server = HTTPServer(("127.0.0.1", args.port), TTSHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("[EdgeTTS] Shutting down...")
        server.server_close()


if __name__ == "__main__":
    main()
