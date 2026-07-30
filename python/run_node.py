#!python
"""
Lumina Agent Node — 入口脚本 (Phase 2)

用法:
  python run_node.py --http-port 18925 --ws-port 18926

功能:
  - HTTP REST  :18925  (TTS / STT / Embedding / Health)
  - WebSocket  :18926  (流式 TTS / STT)

参数:
  --lazy            按需加载模型 (默认开启，STT/Embed 首次使用时才加载)
  --stt-model       指定 Whisper 模型大小 (tiny/base/small/medium/large)
  --embed-model     指定 Embedding 模型名

Electron 集成:
  由 pythonManager.ts 自动调用，无需手动启动
"""

import sys
import os

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

from lumina_node.server import main

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
