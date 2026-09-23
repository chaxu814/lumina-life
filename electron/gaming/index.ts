// ============================================================
// electron/gaming/index.ts — Minecraft 游戏集成模块入口
//
// 导出：
//   - 4 个工具定义（game_status / game_action / game_look / game_chat）
//   - 对应 handler
//   - registerGamingTools()：注册到 tools/registry
// ============================================================

import type { ToolDef, ToolResult } from '../tools/types'
import { registerTool } from '../tools/registry'
import { loadGameConfig } from './gameConfig'
import { getGameState, executeGameAction } from './gameActions'
import type { GameActionRequest } from './types'

// ──────────────────────────────────────────────────────────
// 工具 1: game_status
// ──────────────────────────────────────────────────────────

export const gameStatusDef: ToolDef = {
  name: 'game_status',
  description: `获取 Minecraft 当前游戏状态（生命值、饥饿值、快捷栏、坐标、模式）。
- 视觉路线：截取游戏画面并用 VLM 识别
- 程序化路线：直接读取 Mineflayer bot 实体状态
参数 window_title (可选)：目标窗口标题片段，默认读配置。`,
  params: {
    window_title: { type: 'string', description: '目标窗口标题片段（可选）', required: false },
  },
  toolsets: ['gaming'],
}

export async function gameStatus(args: Record<string, any>): Promise<ToolResult> {
  const config = loadGameConfig()
  const windowTitle = typeof args.window_title === 'string' ? args.window_title : undefined
  const { text, route } = await getGameState(config, windowTitle)
  return {
    callId: '',
    ok: true,
    content: `${text}\n（路线: ${route}）`,
  }
}

// ──────────────────────────────────────────────────────────
// 工具 2: game_action
// ──────────────────────────────────────────────────────────

export const gameActionDef: ToolDef = {
  name: 'game_action',
  description: `在 Minecraft 中执行一个游戏动作。
action 取值：
- move_forward / move_back / move_left / move_right：移动（需 duration_ms）
- jump：跳跃；sneak：潜行
- attack：攻击准星对准的实体；use：使用物品；place：放置方块
- inventory：打开/关闭背包（E 键）
- select_slot：切换快捷栏槽位（slot 1-9）
参数：
- duration_ms：移动/按键持续时间，默认 500
- slot：select_slot 的槽位（1-9）`,
  params: {
    action: {
      type: 'string',
      description: '游戏动作',
      required: true,
      enum: ['move_forward', 'move_back', 'move_left', 'move_right', 'jump', 'sneak', 'attack', 'use', 'place', 'inventory', 'select_slot'],
    },
    duration_ms: { type: 'number', description: '持续时间（毫秒），默认 500', required: false },
    slot: { type: 'number', description: '快捷栏槽位 1-9', required: false },
  },
  toolsets: ['gaming'],
  dangerous: true,
}

export async function gameAction(args: Record<string, any>): Promise<ToolResult> {
  const config = loadGameConfig()
  const req: GameActionRequest = {
    action: args.action,
    durationMs: args.duration_ms != null ? Number(args.duration_ms) : undefined,
    slot: args.slot != null ? Number(args.slot) : undefined,
  }
  const r = await executeGameAction(req, config)
  return {
    callId: '',
    ok: r.ok,
    content: r.content,
    ...(r.error ? { error: r.error } : {}),
  }
}

// ──────────────────────────────────────────────────────────
// 工具 3: game_look
// ──────────────────────────────────────────────────────────

export const gameLookDef: ToolDef = {
  name: 'game_look',
  description: `调整 Minecraft 视角。
二选一：
- 绝对角：yaw（水平 -180~180）、pitch（垂直 -90~90）
- 相对偏移：delta_x / delta_y（像素级鼠标移动）`,
  params: {
    yaw: { type: 'number', description: '水平角 -180~180', required: false },
    pitch: { type: 'number', description: '垂直角 -90~90', required: false },
    delta_x: { type: 'number', description: '相对水平偏移（像素）', required: false },
    delta_y: { type: 'number', description: '相对垂直偏移（像素）', required: false },
  },
  toolsets: ['gaming'],
  dangerous: true,
}

export async function gameLook(args: Record<string, any>): Promise<ToolResult> {
  const config = loadGameConfig()
  const req: GameActionRequest = {
    action: 'look_at',
    yaw: args.yaw != null ? Number(args.yaw) : undefined,
    pitch: args.pitch != null ? Number(args.pitch) : undefined,
    deltaX: args.delta_x != null ? Number(args.delta_x) : undefined,
    deltaY: args.delta_y != null ? Number(args.delta_y) : undefined,
  }
  const r = await executeGameAction(req, config)
  return {
    callId: '',
    ok: r.ok,
    content: r.content,
    ...(r.error ? { error: r.error } : {}),
  }
}

// ──────────────────────────────────────────────────────────
// 工具 4: game_chat
// ──────────────────────────────────────────────────────────

export const gameChatDef: ToolDef = {
  name: 'game_chat',
  description: `在 Minecraft 游戏内发送聊天消息。
普通文本直接发送；斜杠命令会经过安全审查（/op /stop /kill @e 等管理员命令被拦截）。`,
  params: {
    message: { type: 'string', description: '要发送的聊天内容', required: true },
  },
  toolsets: ['gaming'],
  dangerous: true,
}

export async function gameChat(args: Record<string, any>): Promise<ToolResult> {
  const config = loadGameConfig()
  const req: GameActionRequest = {
    action: 'chat',
    text: typeof args.message === 'string' ? args.message : '',
  }
  const r = await executeGameAction(req, config)
  return {
    callId: '',
    ok: r.ok,
    content: r.content,
    ...(r.error ? { error: r.error } : {}),
  }
}

// ──────────────────────────────────────────────────────────
// 注册函数
// ──────────────────────────────────────────────────────────

export function registerGamingTools(): void {
  registerTool(gameStatusDef, gameStatus)
  registerTool(gameActionDef, gameAction)
  registerTool(gameLookDef, gameLook)
  registerTool(gameChatDef, gameChat)
}

export * from './types'
export { loadGameConfig } from './gameConfig'
export { resetRouteCache } from './gameActions'
