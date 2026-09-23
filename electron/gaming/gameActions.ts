// ============================================================
// electron/gaming/gameActions.ts — 统一动作执行层
//
// 职责：
//   1. 根据配置 resolveRoute 选择视觉 / 程序化路线
//   2. 先过游戏安全审查（reviewGameAction）
//   3. 分发到 visualRoute / botRoute
// ============================================================

import type {
  GameActionRequest, GameActionResult, GameConfig, GameState, ResolvedRoute,
} from './types'
import { resolveRoute } from './gameConfig'
import { reviewGameAction } from './security'
import { visualSee, visualAct, formatGameState } from './visualRoute'
import { isMineflayerAvailable, botSee, botAct } from './botRoute'

/**
 * 探测当前可用路线（带缓存，避免每次都动态 import）。
 */
let _botAvailableCache: boolean | null = null
export async function detectRoute(config: GameConfig): Promise<ResolvedRoute> {
  if (_botAvailableCache == null) {
    _botAvailableCache = await isMineflayerAvailable()
  }
  return resolveRoute(config, _botAvailableCache)
}

/** 测试专用：重置路线探测缓存 */
export function resetRouteCache(): void {
  _botAvailableCache = null
}

/**
 * 获取游戏状态。
 * 未启用模块 → 提示未开启；否则按路线执行。
 */
export async function getGameState(
  config: GameConfig,
  windowTitle?: string,
): Promise<{ state: GameState; route: ResolvedRoute; text: string }> {
  if (!config.enabled) {
    return {
      state: { detected: false, hotbar: [] },
      route: 'visual',
      text: '🎮 游戏集成未启用。请在 .env 设置 LUMINA_GAME_ENABLED=true 后重启。',
    }
  }

  const route = await detectRoute(config)

  if (route === 'bot') {
    const state = await botSee(config)
    return { state, route, text: formatGameState(state) }
  }

  const state = await visualSee(config, windowTitle)
  return { state, route, text: formatGameState(state) }
}

/**
 * 执行游戏动作。安全审查失败直接返回，不分发。
 */
export async function executeGameAction(
  req: GameActionRequest,
  config: GameConfig,
): Promise<GameActionResult> {
  if (!config.enabled) {
    return {
      ok: false,
      content: '🎮 游戏集成未启用。请在 .env 设置 LUMINA_GAME_ENABLED=true 后重启。',
      error: 'game_disabled',
    }
  }

  const guard = reviewGameAction(req)
  if (!guard.allowed) {
    return { ok: false, content: guard.reason || '⛔ 操作被安全护栏拒绝', error: 'guard_blocked' }
  }
  if (guard.needsApproval) {
    // 中风险：仍执行，但在内容中提示（registry 层 dangerous=true 会再触发一次审批门）
    // 这里不阻断，交给外层审批流。
  }

  const route = await detectRoute(config)

  if (route === 'bot') {
    const result = await botAct(req, config)
    // bot 连接失败时上层已回退 visual；这里把提示加上
    return result
  }

  const result = await visualAct(req)
  return result
}
