// ============================================================
// electron/gaming/botRoute.ts — 路线2：Mineflayer 程序化控制（可选）
//
// mineflayer 是 optionalDependency，运行时通过 `await import('mineflayer')`
// 动态加载；未安装 / 连接失败时上层自动回退视觉路线。
//
// 安全：
//   - 只走离线/本地模式（auth: 'offline'），不处理正版 session token
//   - 连接参数由 env 显式配置，reviewBotConnection 审查
// ============================================================

import type { GameActionRequest, GameActionResult, GameConfig, GameState, ResolvedRoute } from './types'
import { reviewBotConnection } from './security'

// bot 单例连接（进程级缓存）
let cachedBot: any = null
let cachedConnecting: Promise<any> | null = null

/** 探测 mineflayer 是否可用（动态 import 成功即视为可用） */
export async function isMineflayerAvailable(): Promise<boolean> {
  try {
    await import('mineflayer')
    return true
  } catch {
    return false
  }
}

/** 断开 bot（退出/重连时调用） */
export function disconnectBot(): void {
  try { cachedBot?.quit?.('lumina disconnect') } catch { /* ignore */ }
  cachedBot = null
  cachedConnecting = null
}

/**
 * 连接（或复用）bot。连接失败返回 null。
 */
async function connectBot(config: GameConfig): Promise<any> {
  if (cachedBot) {return cachedBot}
  if (cachedConnecting) {return cachedConnecting}

  const guard = reviewBotConnection(config.bot.host, config.bot.username)
  if (!guard.allowed) {throw new Error(guard.reason || 'bot 连接被拒绝')}

  cachedConnecting = (async () => {
    const mod: any = await import('mineflayer')
    const create = mod.createBot || mod.default?.createBot
    if (typeof create !== 'function') {throw new Error('mineflayer 导出格式异常')}

    const bot = create({
      host: config.bot.host,
      port: config.bot.port,
      username: config.bot.username,
      version: config.bot.version,
      auth: 'offline',
    })

    // 连接超时 8s
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bot 连接超时(8s)')), 8000)
      bot.once('spawn', () => { clearTimeout(timer); resolve() })
      bot.once('error', (e: any) => { clearTimeout(timer); reject(e) })
    })

    cachedBot = bot
    return bot
  })()

  try {
    return await cachedConnecting
  } catch (e) {
    cachedConnecting = null
    cachedBot = null
    throw e
  }
}

/** 程序化读取游戏状态 */
export async function botSee(config: GameConfig): Promise<GameState> {
  try {
    const bot = await connectBot(config)
    const e = bot.entity || {}
    const pos = e.position || {}
    return {
      detected: true,
      windowTitle: `mineflayer://${config.bot.host}:${config.bot.port}`,
      health: typeof bot.health === 'number' ? bot.health : undefined,
      maxHealth: 20,
      food: typeof bot.food === 'number' ? bot.food : undefined,
      xpLevel: typeof bot.experienceLevel === 'number' ? bot.experienceLevel : undefined,
      yaw: typeof e.yaw === 'number' ? e.yaw : undefined,
      pitch: typeof e.pitch === 'number' ? e.pitch : undefined,
      position: (typeof pos.x === 'number')
        ? { x: pos.x, y: pos.y, z: pos.z, dimension: bot.game?.dimension }
        : undefined,
      gamemode: bot.game?.mode,
      hotbar: [],
      nearEntities: bot.entities
        ? Object.values(bot.entities).map((en: any) => en?.name || en?.entityType).filter(Boolean).slice(0, 10) as string[]
        : undefined,
    }
  } catch (e: any) {
    return { detected: false, hotbar: [], raw: `bot 状态获取失败: ${e?.message || e}` }
  }
}

/** 程序化执行动作 */
export async function botAct(req: GameActionRequest, config: GameConfig): Promise<GameActionResult> {
  try {
    const bot = await connectBot(config)
  } catch (e: any) {
    return { ok: false, content: `⚠️ bot 连接失败，回退视觉路线: ${e?.message || e}`, error: 'bot_unavailable', route: 'visual' }
  }
  const bot = cachedBot

  const route: ResolvedRoute = 'bot'
  const dur = Math.max(50, Math.min(5000, Math.floor(req.durationMs ?? 500)))

  switch (req.action) {
    case 'move_forward':
    case 'move_back':
    case 'move_left':
    case 'move_right': {
      const stateMap: Record<string, string> = {
        move_forward: 'forward', move_back: 'back', move_left: 'left', move_right: 'right',
      }
      const s = stateMap[req.action]
      bot.setControlState(s, true)
      await new Promise(r => setTimeout(r, dur))
      bot.setControlState(s, false)
      return { ok: true, content: `🤖 bot ${req.action} ${dur}ms`, route }
    }
    case 'jump':
      bot.setControlState('jump', true)
      await new Promise(r => setTimeout(r, 200))
      bot.setControlState('jump', false)
      return { ok: true, content: '🤖 bot 跳跃', route }
    case 'sneak':
      bot.setControlState('sneak', true)
      await new Promise(r => setTimeout(r, dur))
      bot.setControlState('sneak', false)
      return { ok: true, content: `🤖 bot 潜行 ${dur}ms`, route }
    case 'select_slot': {
      const slot = Math.floor(Number(req.slot) ?? 0)
      try {
        await new Promise<void>((resolve, reject) => {
          try {
            bot.setQuickBarSlot(slot - 1)
            resolve()
          } catch (e) { reject(e) }
        })
        return { ok: true, content: `🤖 bot 切换槽位 ${slot}`, route }
      } catch (e: any) {
        return { ok: false, content: `切换槽位失败: ${e?.message || e}`, error: 'slot_fail', route }
      }
    }
    case 'inventory':
      return { ok: true, content: '🤖 bot 背包已可通过 inventory API 访问（视觉路线用 E 键）', route }
    case 'attack': {
      const target = bot.nearestEntity?.((e: any) => e?.type === 'mob' || e?.kind === 'Hostile mobs') || bot.nearestEntity?.()
      if (!target) {return { ok: true, content: '🤖 附近无实体，未攻击', route }}
      bot.attack(target)
      return { ok: true, content: `🤖 bot 攻击: ${target.name || target.entityType || '实体'}`, route }
    }
    case 'use':
      bot.activateItem()
      return { ok: true, content: '🤖 bot 使用物品', route }
    case 'place':
      return { ok: true, content: '🤖 bot 放置方块（需指定目标方块，简化版未实现）', route }
    case 'chat': {
      const text = (req.text || '').trim()
      bot.chat(text)
      return { ok: true, content: `🤖 bot 发送: ${text}`, route }
    }
    case 'look_at': {
      const yaw = Number(req.yaw ?? (req.deltaX != null ? bot.entity.yaw : 0))
      const pitch = Number(req.pitch ?? (req.deltaY != null ? bot.entity.pitch : 0))
      await bot.look(yaw, pitch)
      return { ok: true, content: `🤖 bot 视角 yaw=${yaw.toFixed(1)} pitch=${pitch.toFixed(1)}`, route }
    }
    case 'craft':
      return { ok: false, content: '🤖 bot 合成需指定配方（简化版未实现 itemName→recipe 解析）', error: 'craft_unsupported', route }
    default:
      return { ok: false, content: `未知动作: ${req.action}`, error: 'unknown_action', route }
  }
}
