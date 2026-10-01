// ============================================================
// electron/gaming/gameActions.ts — 统一动作执行层
//
// 职责：
//   1. 解析当前 Profile（req.profileId > config.activeProfile > 自动探测 > 默认 minecraft）
//   2. 根据 Profile.supportedRoutes 与配置选择视觉 / 程序化路线
//   3. 先过游戏安全审查（reviewGameAction，带 Profile 规则）
//   4. 分发到 visualRoute / botRoute
// ============================================================

import type {
  GameActionRequest, GameActionResult, GameConfig, GameState, ResolvedRoute,
} from './types'
import type { GameProfile } from './profiles'
import { getProfile, detectActiveProfile, minecraftProfile } from './profiles'
import { resolveRoute } from './gameConfig'
import { reviewGameAction } from './security'
import { visualSee, visualAct, formatGameState } from './visualRoute'
import { isMineflayerAvailable, botSee, botAct, GAME_COMPANION_EXTENSION_NOTICE } from './botRoute'

/**
 * 解析当前 Profile。优先级：
 *   1. req.profileId（调用方显式指定）
 *   2. config.activeProfile（env LUMINA_GAME_PROFILE）
 *   3. detectActiveProfile(windowTitle)（按窗口标题自动探测）
 *   4. 兜底 minecraftProfile（向后兼容）
 */
export function resolveProfile(
  req: Pick<GameActionRequest, 'profileId'> | undefined,
  config: GameConfig,
  windowTitle?: string,
): GameProfile {
  if (req?.profileId) {
    const p = getProfile(req.profileId)
    if (p) {return p}
  }
  if (config.activeProfile) {
    const p = getProfile(config.activeProfile)
    if (p) {return p}
  }
  const detected = detectActiveProfile(windowTitle || config.windowTitle)
  if (detected) {return detected}
  return minecraftProfile
}

/**
 * 探测当前可用路线（带缓存，避免每次都动态 import）。
 * Profile 不支持 bot（如 Factorio）时强制 visual。
 */
let _botAvailableCache: boolean | null = null
export async function detectRoute(config: GameConfig, profile?: GameProfile): Promise<ResolvedRoute> {
  if (profile && !profile.supportedRoutes.includes('bot')) {
    return 'visual'
  }
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
 * 判断「支持程序化 bot 的 profile（Minecraft）」是否缺少游戏陪伴扩展。
 * 非 bot profile（Factorio 等）返回 false（它们走视觉路线，不需要 mineflayer）。
 */
async function botExtensionMissing(profile: GameProfile): Promise<boolean> {
  if (!profile.supportedRoutes.includes('bot')) {
    return false
  }
  if (_botAvailableCache == null) {
    _botAvailableCache = await isMineflayerAvailable()
  }
  return !_botAvailableCache
}

/**
 * 获取游戏状态。
 * 未启用模块 → 提示未开启；否则按 Profile 与路线执行。
 */
export async function getGameState(
  config: GameConfig,
  windowTitle?: string,
): Promise<{ state: GameState; route: ResolvedRoute; text: string; profile: GameProfile }> {
  if (!config.enabled) {
    return {
      state: { detected: false, hotbar: [] },
      route: 'visual',
      text: '🎮 游戏集成未启用。请在 .env 设置 LUMINA_GAME_ENABLED=true 后重启。',
      profile: minecraftProfile,
    }
  }

  const profile = resolveProfile(undefined, config, windowTitle)

  // 发行版未内置 mineflayer：返回友好的「可选扩展」状态，不报错、不跑 VLM
  if (await botExtensionMissing(profile)) {
    return {
      state: { detected: false, hotbar: [], raw: GAME_COMPANION_EXTENSION_NOTICE },
      route: 'visual',
      text: GAME_COMPANION_EXTENSION_NOTICE,
      profile,
    }
  }

  const route = await detectRoute(config, profile)

  if (route === 'bot') {
    const state = await botSee(config)
    return { state, route, text: formatGameState(state, profile), profile }
  }

  const state = await visualSee(config, windowTitle, profile)
  return { state, route, text: formatGameState(state, profile), profile }
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

  const profile = resolveProfile(req, config)

  // 发行版未内置 mineflayer：返回友好的「可选扩展」提示，不执行、不报错
  if (await botExtensionMissing(profile)) {
    return {
      ok: false,
      content: GAME_COMPANION_EXTENSION_NOTICE,
      error: 'game_companion_extension',
    }
  }

  const guard = reviewGameAction(req, profile)
  if (!guard.allowed) {
    return { ok: false, content: guard.reason || '⛔ 操作被安全护栏拒绝', error: 'guard_blocked' }
  }
  if (guard.needsApproval) {
    // 中风险：仍执行，但在内容中提示（registry 层 dangerous=true 会再触发一次审批门）
  }

  const route = await detectRoute(config, profile)

  if (route === 'bot') {
    return botAct(req, config)
  }

  return visualAct(req, profile)
}
