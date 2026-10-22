// ============================================================
// mcpServerEntry.ts — 纯 Node 形态的 MCP stdio server 入口
//
// 背景：Electron GUI 进程在 Windows 上无法读取 stdin（GUI 子系统拿不到
// 控制台管道），所以 MCP stdio server 不能跑在 Electron 主进程里。
// 本入口由 electron 二进制以 ELECTRON_RUN_AS_NODE=1（即纯 Node 运行时）
// 加载，stdin/stdout 正常工作。
//
// 打包：用 esbuild 单独 bundle（见 package.json 的 build:mcp-server），
//   electron 与原生模块标记为 external，运行时再 require。
// ============================================================

import { registerAllTools } from '../tools'
import { startExposedMcpServer } from './exposeMcpServer'

// 注册全部工具（幂等），随后启动 stdio server
registerAllTools()
startExposedMcpServer()
