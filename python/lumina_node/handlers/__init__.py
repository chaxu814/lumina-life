"""
Lumina Agent Node — 处理器注册

每个 Handler 是一个模块，暴露:
  - init(): 初始化（加载模型等）
  - register_routes(server): 注册 HTTP + WebSocket 路由
  - health(): 返回健康状态 dict
"""
