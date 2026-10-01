// ============================================================
// electron/gaming/index.ts — 多游戏集成模块入口
//
// 导出：
//   - 5 个工具定义（game_status / game_action / game_look / game_chat / game_auto）
//   - 对应 handler
//   - registerGamingTools()：注册到 tools/registry
// ============================================================

import type { ToolDef, ToolResult } from '../tools/types'
import { registerTool } from '../tools/registry'
import { loadGameConfig } from './gameConfig'
import { getGameState, executeGameAction } from './gameActions'
import { runAutoPlay } from './autoPlay'
import { getProfile, listProfiles, minecraftProfile } from './profiles'
import { GAME_COMPANION_EXTENSION_NOTICE } from './botRoute'
import type { GameActionRequest } from './types'

// ──────────────────────────────────────────────────────────
// 工具 1: game_status
// ──────────────────────────────────────────────────────────

export const gameStatusDef: ToolDef = {
  name: 'game_status',
  description: `获取当前游戏状态（生命值、快捷栏、附近实体、坐标等）。
支持的游戏：${listProfiles().map(p => p.displayName).join(' / ')}。
- 视觉路线：截取游戏画面并用 VLM 识别
- 程序化路线（仅 Minecraft）：直接读取 Mineflayer bot 实体状态
参数 window_title (可选)：目标窗口标题片段；profile_id (可选)：指定游戏 profile。`,
  params: {
    window_title: { type: 'string', description: '目标窗口标题片段（可选）', required: false },
    profile_id: { type: 'string', description: '游戏 profile id（minecraft | factorio，可选）', required: false },
  },
  toolsets: ['gaming'],
}

export async function gameStatus(args: Record<string, any>): Promise<ToolResult> {
  const config = loadGameConfig()
  const windowTitle = typeof args.window_title === 'string' ? args.window_title : undefined
  const { text, route, profile } = await getGameState(config, windowTitle)
  return {
    callId: '',
    ok: true,
    content: `${text}\n（游戏: ${profile.displayName}，路线: ${route}）`,
  }
}

// ──────────────────────────────────────────────────────────
// 工具 2: game_action
// ──────────────────────────────────────────────────────────

export const gameActionDef: ToolDef = {
  name: 'game_action',
  description: `在当前游戏中执行一个游戏动作。
通用动作：move_forward / move_back / move_left / move_right（移动，需 duration_ms）、jump、sneak、attack/use/inventory/select_slot/look_at/chat/craft。
Minecraft 专属：attack（左键）、place（右键）。
Factorio 专属：shoot（左键采矿/建造/开火）、rotate（R 旋转实体）、map（Tab 看地图）。
参数：
- duration_ms：移动/按住持续时间，默认 500
- slot：select_slot 的槽位（Minecraft 1-9，Factorio 1-5）
- profile_id：指定游戏（可选，缺省自动探测/读配置）`,
  params: {
    action: {
      type: 'string',
      description: '游戏动作',
      required: true,
      enum: [
        'move_forward', 'move_back', 'move_left', 'move_right',
        'jump', 'sneak', 'attack', 'use', 'place',
        'inventory', 'select_slot', 'chat', 'craft', 'look_at',
        'shoot', 'rotate', 'map',
      ],
    },
    duration_ms: { type: 'number', description: '持续时间（毫秒），默认 500', required: false },
    slot: { type: 'number', description: '快捷栏槽位', required: false },
    profile_id: { type: 'string', description: '游戏 profile id（minecraft | factorio）', required: false },
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
    profileId: typeof args.profile_id === 'string' ? args.profile_id : undefined,
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
  description: `调整游戏视角。
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
  description: `在游戏内发送聊天消息。
普通文本直接发送；斜杠命令会经过安全审查（管理员命令/执行脚本被拦截）。
不同游戏打开聊天框的按键不同（Minecraft=T，Factorio=\`），由 profile 自动处理。`,
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
// 工具 5: game_auto（自主游玩闭环）
// ──────────────────────────────────────────────────────────

export const gameAutoDef: ToolDef = {
  name: 'game_auto',
  description: `让 AI 自主游玩一段时间：自己看画面、做决策、执行动作。
参数：
- max_rounds：最大轮数，默认 20
- max_duration_sec：最大时长（秒），默认 120
⚠️ 请在人在旁边照看时使用，不要在带反作弊的竞技游戏里跑。`,
  params: {
    max_rounds: { type: 'number', description: '最大轮数，默认 20', required: false },
    max_duration_sec: { type: 'number', description: '最大时长（秒），默认 120', required: false },
  },
  toolsets: ['gaming'],
  dangerous: true,
}

export async function gameAuto(args: Record<string, any>): Promise<ToolResult> {
  const config = loadGameConfig()
  const profile = getProfile(config.activeProfile || '') || minecraftProfile

  // 发行版未内置 mineflayer（Minecraft 自主陪伴扩展缺失）：友好提示，不空转
  if (profile.supportedRoutes.includes('bot')) {
    const { isMineflayerAvailable } = await import('./botRoute')
    if (!(await isMineflayerAvailable())) {
      return { callId: '', ok: false, content: GAME_COMPANION_EXTENSION_NOTICE, error: 'game_companion_extension' }
    }
  }

  const maxRounds = args.max_rounds != null ? Number(args.max_rounds) : 20
  const maxDurationSec = args.max_duration_sec != null ? Number(args.max_duration_sec) : 120
  const result = await runAutoPlay({
    profile,
    config,
    maxRounds,
    maxDurationMs: maxDurationSec * 1000,
  })
  return {
    callId: '',
    ok: true,
    content: `🤖 自主游玩结束（${profile.displayName}）：
轮数: ${result.roundsPlayed}
执行动作: ${result.actionsExecuted}
被护栏拦截: ${result.dangerousBlocked}
停止原因: ${result.stopReason}`,
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
  registerTool(gameAutoDef, gameAuto)
}

export * from './types'
export { loadGameConfig } from './gameConfig'
export { resetRouteCache } from './gameActions'
export { runAutoPlay } from './autoPlay'
export * from './profiles'
