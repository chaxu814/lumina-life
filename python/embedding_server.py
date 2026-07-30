"""
Lumina Embedding Server — 本地语义向量服务

启动: python embedding_server.py --port 18923
默认使用 sentence-transformers 的 all-MiniLM-L6-v2 (轻量，CPU 可用)

支持:
  POST /embed  — 批量文本→向量 (JSON: {"texts": ["..."]})
  GET  /health  — 健康检查
"""

import sys, os, json, argparse, threading, time
from http.server import HTTPServer, BaseHTTPRequestHandler

MODEL = None
MODEL_NAME = None

def log(msg):
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode('ascii', errors='replace').decode('ascii'), flush=True)


def load_model(model_name: str = "all-MiniLM-L6-v2"):
    """加载 sentence-transformers 模型"""
    global MODEL, MODEL_NAME
    try:
        from sentence_transformers import SentenceTransformer
        log(f"[Embedding] 加载模型: {model_name}")
        MODEL = SentenceTransformer(model_name)
        MODEL_NAME = model_name
        # 预热
        _ = MODEL.encode("test")
        log(f"[Embedding] 模型就绪，向量维度: {MODEL.get_sentence_embedding_dimension()}")
        return True
    except ImportError:
        log("[Embedding] sentence-transformers 未安装，请运行: pip install sentence-transformers")
        return False
    except Exception as e:
        log(f"[Embedding] 模型加载失败: {e}")
        return False


class EmbeddingHandler(BaseHTTPRequestHandler):
    """HTTP 请求处理器"""

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "model": MODEL_NAME,
                "dimension": MODEL.get_sentence_embedding_dimension() if MODEL else 0
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/embed":
            self.send_response(404)
            self.end_headers()
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body)
            texts = data.get("texts", [])

            if not texts or not isinstance(texts, list):
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "缺少 texts 参数"}')
                return

            if MODEL is None:
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b'{"error": "模型未就绪"}')
                return

            # 批量编码
            embeddings = MODEL.encode(texts, normalize_embeddings=True).tolist()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"embeddings": embeddings}).encode())

        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error": "无效 JSON"}')
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        pass  # 静默 HTTP 日志


def main():
    parser = argparse.ArgumentParser(description="Lumina Embedding Server")
    parser.add_argument("--port", type=int, default=18923, help="端口 (默认 18923)")
    parser.add_argument("--model", type=str, default="all-MiniLM-L6-v2",
                        help="模型名 (默认 all-MiniLM-L6-v2，轻量 384 维)")
    args = parser.parse_args()

    if not load_model(args.model):
        sys.exit(1)

    server = HTTPServer(("127.0.0.1", args.port), EmbeddingHandler)
    log(f"[Embedding] 服务启动: http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("[Embedding] 服务停止")
        server.server_close()


if __name__ == "__main__":
    main()
