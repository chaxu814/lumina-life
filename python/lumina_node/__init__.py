"""
Lumina Agent Node — 统一 Python 后端节点

========== Plan C 架构 ==========

职责: TTS / STT / Embedding / 未来 Agent 计算任务
协议: WebSocket (JSON-RPC) + HTTP (REST 兼容)
进程: 由 Electron 主进程管理生命周期 (pythonManager.ts)

设计原则:
  1. 单进程多 Handler，避免端口碎片
  2. WebSocket 双向通信，支持流式 TTS/STT
  3. 按需加载模型，内存友好
  4. 统一健康检查 / 心跳

========== Phase 1 ==========
  合并原有三个独立服务 (edge_tts_server / embedding_server / stt_server)
  到同一个进程中，由 Electron 统一启停。
  
========== 目录结构 ==========
  lumina_node/
    __init__.py      ← 包入口
    server.py        ← 统一 Server (HTTP + WebSocket)
    config.py        ← 配置常量
    handlers/
      __init__.py
      tts.py         ← TTS 处理
      stt.py         ← STT 处理
      embed.py       ← Embedding 处理
"""

__version__ = "0.1.0"
