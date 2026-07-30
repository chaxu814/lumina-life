"""
Lumina Agent Node — 统一 HTTP + WebSocket 服务 (Phase 2)

架构:
  单进程统一管理 TTS / STT / Embedding 三个模块
  - HTTP REST :18925  用于请求-响应模式
  - WebSocket :18926  用于流式传输（STT 流式识别、TTS 流式合成）

与 Electron 集成:
  pythonManager.ts 负责启停、健康检查、端口分配

Phase 2 新增:
  - WebSocket 流式 TTS（逐 chunk 返回音频）
  - WebSocket 流式 STT（实时语音转写）
  - 按需加载（STT 模型在首次请求时才加载）
"""

import argparse
import asyncio
import json
import os
import sys
import signal
from typing import Any, Optional

# ── 确保项目根目录在 sys.path 中 ─────────────────────
_NODE_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR = os.path.dirname(_NODE_DIR)
if _PROJECT_DIR not in sys.path:
    sys.path.insert(0, _PROJECT_DIR)

from .handlers import tts, stt, embed
from .config import HTTP_PORT, WS_PORT

# ── 日志 ────────────────────────────────────────────

def log(msg: str):
    try:
        print(f"[Node] {msg}", flush=True)
    except UnicodeEncodeError:
        print(f"[Node] {msg.encode('ascii', errors='replace').decode('ascii')}", flush=True)

# ── HTTP Server (asyncio) — REST API ────────────────

class HTTPProtocol(asyncio.Protocol):
    """简化的 HTTP 处理器 — 路由分发给各 handler"""

    _routes: dict = {}

    @classmethod
    def add_route(cls, method: str, path: str, handler):
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
        request_line = lines[0]
        parts = request_line.split(" ")
        if len(parts) < 2:
            self._send_error(400, "Bad Request")
            return
        method = parts[0].upper()
        path = parts[1]
        content_length = 0
        for line in lines[1:]:
            if line.lower().startswith("content-length:"):
                content_length = int(line.split(":")[1].strip())
                break
        if len(body) < content_length:
            return
        asyncio.create_task(self._handle(method, path, body))

    async def _handle(self, method: str, path: str, body: bytes):
        if path == "/health" and method == "GET":
            return self._send_json({
                "status": "ok",
                "services": {
                    "tts": tts.health(),
                    "stt": stt.health(),
                    "embed": embed.health(),
                }
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
            log(f"Handler 异常: {e}")
            return self._send_error(500, str(e))

    def _send_json(self, data: Any, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send_response(status, "application/json", body)

    def _send_error(self, status: int, message: str):
        self._send_json({"error": message}, status)

    def _send_response(self, status: int, content_type: str, body: bytes):
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


# ── WebSocket Server — 流式 API ─────────────────────

class WebSocketHandler:
    """WebSocket 消息分发 — 每个连接一个 handler 实例"""

    def __init__(self, ws):
        self.ws = ws

    async def handle(self):
        """主消息循环: 接收 JSON 消息 → 分发 → 返回结果"""
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
                msg_type = msg.get("type", "")
                msg_id = msg.get("id", None)

                if msg_type == "ping":
                    await self._send({"type": "pong", "id": msg_id})
                    continue

                result = await self._dispatch(msg_type, msg)
                response = {"type": msg_type + ":result", "id": msg_id, **result}
                await self._send(response)

            except json.JSONDecodeError:
                await self._send({"type": "error", "message": "Invalid JSON"})
            except Exception as e:
                log(f"WS handler 异常: {e}")
                await self._send({"type": "error", "message": str(e)})

    async def _dispatch(self, msg_type: str, msg: dict) -> dict:
        """根据消息类型分发到对应 handler"""
        if msg_type == "tts":
            return await tts.handle_tts(msg)
        elif msg_type == "stt":
            return await stt.handle_transcribe(msg)
        elif msg_type == "embed":
            return await embed.handle_embed(msg)
        elif msg_type == "tts.stream":
            # 流式 TTS: 逐 chunk 发送音频
            return await self._handle_tts_stream(msg)
        elif msg_type == "stt.stream":
            # 流式 STT: 接收音频 chunk，返回实时转写
            return await self._handle_stt_stream(msg)
        else:
            return {"error": f"Unknown type: {msg_type}"}

    async def _handle_tts_stream(self, msg: dict) -> dict:
        """流式 TTS — 生成完成后一次性返回（简化版）
        完整流式: 需要 edge-tts 的 stream 模式，留待 Phase 3
        """
        text = msg.get("text", "")
        if not text:
            return {"error": "text is required"}
        voice = msg.get("voice", "zh-CN-XiaoxiaoNeural")
        speed = float(msg.get("speed", 1.0))
        audio = await tts.generate(text, voice, speed)
        return {"audio": audio.hex(), "format": "mp3", "streamed": False}

    async def _handle_stt_stream(self, msg: dict) -> dict:
        """流式 STT — 接收单帧音频，返回部分转写
        完整流式: 需要维护 session 状态，留待 Phase 3
        """
        return await stt.handle_transcribe(msg)

    async def _send(self, data: dict):
        if self.ws.closed:
            return
        await self.ws.send(json.dumps(data, ensure_ascii=False))


async def run_websocket_server(host: str, port: int):
    """启动 WebSocket 服务器"""
    import websockets

    async def _on_connect(ws):
        log(f"WebSocket 客户端已连接")
        handler = WebSocketHandler(ws)
        try:
            await handler.handle()
        except websockets.ConnectionClosed:
            pass
        finally:
            log(f"WebSocket 客户端已断开")

    async def _serve():
        async with websockets.serve(_on_connect, host, port, ping_interval=30):
            log(f"✅ WebSocket 服务运行在 ws://{host}:{port}")
            await asyncio.Future()  # 永久运行

    try:
        await _serve()
    except ImportError:
        log("⚠️ websockets 库未安装，WebSocket 服务不可用")
        log("   pip install websockets")
    except OSError as e:
        log(f"⚠️ WebSocket 端口 {port} 被占用: {e}")


# ── 路由注册 ────────────────────────────────────────

def _register_routes():
    HTTPProtocol.add_route("POST", "/tts", tts.handle_tts)
    HTTPProtocol.add_route("POST", "/stt", stt.handle_transcribe)
    HTTPProtocol.add_route("POST", "/embed", embed.handle_embed)


# ── 按需加载（lazy init） ───────────────────────────

LAZY_HANDLERS = {"stt": False, "embed": False}

def lazy_init_stt(model_size: Optional[str]):
    """STT 首次使用时才加载模型"""
    if not LAZY_HANDLERS["stt"]:
        log("[Node] 🔄 按需加载 STT 模型...")
        stt.init(model_size)
        LAZY_HANDLERS["stt"] = True


# ── 主入口 ──────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="Lumina Agent Node v0.2.0")
    parser.add_argument("--http-port", type=int, default=HTTP_PORT, help="HTTP REST 端口")
    parser.add_argument("--ws-port", type=int, default=WS_PORT, help="WebSocket 端口")
    parser.add_argument("--stt-model", type=str, default=None, help="STT 模型大小")
    parser.add_argument("--embed-model", type=str, default=None, help="Embedding 模型名称")
    parser.add_argument("--lazy", action="store_true", default=True,
                        help="按需加载模型（STT/Embedding 首次使用时才加载）")
    args = parser.parse_args()

    log(f"🚀 Lumina Agent Node v0.2.0 (Plan C Phase 2)")
    log(f"    HTTP :{args.http_port}  WebSocket :{args.ws_port}")

    # 1. 初始化 handler
    # TTS 轻量，始终立即加载
    tts.init()
    log(f"  ✅ TTS (edge-tts)")

    if args.lazy:
        # 按需加载
        log(f"  ⏳ STT (按需加载)")
        log(f"  ⏳ Embed (按需加载)")
        # 替换 handle 函数以支持 lazy init
        _orig_stt_handle = stt.handle_transcribe
        async def _lazy_stt_handle(params):
            lazy_init_stt(args.stt_model)
            return await _orig_stt_handle(params)
        stt.handle_transcribe = _lazy_stt_handle
    else:
        # 立即加载
        stt.init(args.stt_model)
        embed.init(args.embed_model)
        log(f"  ✅ STT ({args.stt_model or 'base'})")
        log(f"  ✅ Embed ({args.embed_model or 'all-MiniLM-L6-v2'})")

    # 2. 注册路由
    _register_routes()
    log(f"  📡 路由已注册")

    # 3. 启动 HTTP + WebSocket 服务（带端口回退）
    loop = asyncio.get_event_loop()

    http_port = args.http_port
    ws_port = args.ws_port
    MAX_PORT_RETRY = 10

    # 尝试 HTTP 端口
    http_server = None
    for attempt in range(MAX_PORT_RETRY):
        try:
            http_server = await loop.create_server(
                lambda: HTTPProtocol(),
                host="127.0.0.1",
                port=http_port,
            )
            log(f"✅ HTTP  → http://127.0.0.1:{http_port}")
            break
        except OSError as e:
            if attempt < MAX_PORT_RETRY - 1:
                log(f"⚠️ 端口 {http_port} 被占用，尝试 {http_port + 1}...")
                http_port += 1
                ws_port += 1  # WS 端口同步偏移
            else:
                log(f"❌ 无法找到可用 HTTP 端口（尝试了 {MAX_PORT_RETRY} 个）")
                raise

    # 尝试 WebSocket 端口
    ws_task = None
    for attempt in range(MAX_PORT_RETRY):
        try:
            ws_task = asyncio.create_task(
                run_websocket_server("127.0.0.1", ws_port)
            )
            break
        except OSError as e:
            if attempt < MAX_PORT_RETRY - 1:
                log(f"⚠️ WS 端口 {ws_port} 被占用，尝试 {ws_port + 1}...")
                ws_port += 1
            else:
                log(f"⚠️ 无法找到可用 WS 端口，WebSocket 服务降级")
                break

    # 如果有端口偏移，打印最终端口
    if http_port != args.http_port or ws_port != args.ws_port:
        log(f"📌 最终端口: HTTP={http_port}, WS={ws_port}")

    # 4. 等待停止信号
    stop = asyncio.Future()

    def _shutdown():
        if not stop.done():
            stop.set_result(True)

    if sys.platform != "win32":
        loop.add_signal_handler(signal.SIGTERM, _shutdown)
        loop.add_signal_handler(signal.SIGINT, _shutdown)

    try:
        await stop
    except KeyboardInterrupt:
        pass
    finally:
        log("🛑 正在关闭...")
        http_server.close()
        await http_server.wait_closed()
        ws_task.cancel()
        try:
            await ws_task
        except (asyncio.CancelledError, Exception):
            pass
        log("✅ 服务已停止")


if __name__ == "__main__":
    asyncio.run(main())
