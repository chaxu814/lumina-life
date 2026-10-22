// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/mcpIpc.ts — MCP Client IPC (v3.11)
//
// 注意: 使用 mcp-client:* 前缀，避免与 agentIpc.ts 中的 mcp:* 冲突
// ============================================================

import { ipcMain } from 'electron'
import { getMCPClient } from '../mcpServer'

export function registerMCPIpc(): void {
  const mcp = getMCPClient()

  // ─── 服务器管理 ───────────────────────────────────
  ipcMain.handle('mcp-client:servers', async () => {
    return mcp.getServers()
  })

  ipcMain.handle('mcp-client:add-server', async (_e, config: any) => {
    try {
      mcp.addServer(config)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mcp-client:remove-server', async (_e, id: string) => {
    mcp.removeServer(id)
    return { success: true }
  })

  // ─── 连接 ─────────────────────────────────────────
  ipcMain.handle('mcp-client:connect', async (_e, id: string) => {
    return mcp.connect(id)
  })

  ipcMain.handle('mcp-client:disconnect', async (_e, id: string) => {
    mcp.disconnect(id)
    return { success: true }
  })

  // ─── 工具 ─────────────────────────────────────────
  ipcMain.handle('mcp-client:tools', async (_e, serverId: string) => {
    return mcp.getTools(serverId)
  })

  ipcMain.handle('mcp-client:all-tools', async () => {
    return mcp.getAllTools()
  })

  ipcMain.handle('mcp-client:call-tool', async (_e, serverId: string, toolName: string, args: any) => {
    return mcp.callTool(serverId, toolName, args)
  })

  // ─── 内置 ─────────────────────────────────────────
  ipcMain.handle('mcp-client:install-builtin', async (_e, type: string) => {
    try {
      const config = await mcp.installBuiltinServer(type as any)
      return { success: true, config }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mcp-client:tools-context', async () => {
    return mcp.generateToolsContext()
  })
}
