// ============================================================
// ipc/customAgentIpc.ts — 自定义 Agent 管理 IPC (D5)
//
//   custom-agent:list          列出自定义 Agent
//   custom-agent:get           获取单个
//   custom-agent:create        创建（config）
//   custom-agent:update        更新（id, updates, 可选 soulContent）
//   custom-agent:delete        删除（id）
//   custom-agent:read-soul     读取 SOUL.md
//   custom-agent:write-soul    写入 SOUL.md（通过 update 的 soulContent 亦可）
//   custom-agent:set-default   设置默认 leader 类型 Agent
//   custom-agent:get-default   读取默认 Agent
// ============================================================

import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import {
  getCustomAgentManager,
  registerCustomAgents,
  KNOWN_TOOLSETS,
  type CustomAgentConfig,
} from '../agents/customAgentManager'

function defaultFile(): string {
  return path.join(app.getPath('userData'), 'custom-default-agent.json')
}

function readDefault(): { leaderId: string } {
  try {
    const p = defaultFile()
    if (!fs.existsSync(p)) {return { leaderId: '' }}
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return { leaderId: '' }
  }
}

function writeDefault(leaderId: string): void {
  fs.writeFileSync(defaultFile(), JSON.stringify({ leaderId }, null, 2), 'utf-8')
}

/** 创建后把 Agent 注册到团队（D3） */
function reRegister(): void {
  try {
    const mgr = getCustomAgentManager()
    registerCustomAgents(mgr)
  } catch (err) {
    console.warn('[customAgent] 注册到团队失败:', err)
  }
}

export function registerCustomAgentIpc(): void {
  // ── 列表 ─────────────────────────────────────────
  ipcMain.handle('custom-agent:list', () => {
    try {
      const mgr = getCustomAgentManager()
      const agents = mgr.listCustomAgents()
      const def = readDefault()
      return { ok: true, agents, defaultLeaderId: def.leaderId, toolsets: KNOWN_TOOLSETS }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 获取单个 ─────────────────────────────────────
  ipcMain.handle('custom-agent:get', (_e, id: string) => {
    try {
      const mgr = getCustomAgentManager()
      const cfg = mgr.getAgent(id)
      if (!cfg) {return { ok: false, error: '未找到 Agent' }}
      const soul = mgr.readSoul(id)
      return { ok: true, agent: cfg, soul }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 创建 ────────────────────────────────────────
  ipcMain.handle('custom-agent:create', (_e, config: Partial<CustomAgentConfig> & { id: string }) => {
    try {
      const mgr = getCustomAgentManager()
      const cfg = mgr.createAgent(config)
      reRegister()
      return { ok: true, agent: cfg }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 更新（含 SOUL.md） ────────────────────────────
  ipcMain.handle('custom-agent:update', (_e, id: string, updates: Partial<CustomAgentConfig> & { soulContent?: string }) => {
    try {
      const mgr = getCustomAgentManager()
      const cfg = mgr.updateAgent(id, updates || {})
      reRegister()
      return { ok: true, agent: cfg }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 删除 ──────────────────────────────────────────
  ipcMain.handle('custom-agent:delete', (_e, id: string) => {
    try {
      const mgr = getCustomAgentManager()
      mgr.deleteAgent(id)
      reRegister()
      // 若删除的是默认 leader，清空默认
      const def = readDefault()
      if (def.leaderId === id) {writeDefault('')}
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 读取 SOUL.md ───────────────────────────────────
  ipcMain.handle('custom-agent:read-soul', (_e, id: string) => {
    try {
      const mgr = getCustomAgentManager()
      return { ok: true, soul: mgr.readSoul(id) }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ── 设置默认 leader ────────────────────────────────
  ipcMain.handle('custom-agent:set-default', (_e, id: string) => {
    try {
      const mgr = getCustomAgentManager()
      const cfg = mgr.getAgent(id)
      if (!cfg) {return { ok: false, error: '未找到 Agent' }}
      if (cfg.teamRole !== 'leader') {
        return { ok: false, error: '只有 leader 角色的 Agent 才能设为默认' }
      }
      writeDefault(id)
      return { ok: true, defaultLeaderId: id }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('custom-agent:get-default', () => {
    return { ok: true, defaultLeaderId: readDefault().leaderId }
  })

  console.log('[customAgent] 📡 IPC 已注册 (custom-agent:*)')
}
