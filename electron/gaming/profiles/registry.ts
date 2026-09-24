// ============================================================
// electron/gaming/profiles/registry.ts — Profile 注册表与自动探测
//
// 纯函数，可单测。新增游戏只需在 PROFILES 里注册一个 GameProfile。
// ============================================================

import type { GameProfile } from './types'
import { minecraftProfile } from './minecraft'
import { factorioProfile } from './factorio'
import { stardewValleyProfile } from './stardewValley'
import { civilization6Profile } from './civilization6'
import { genericProfile } from './generic'

export const PROFILES: Record<string, GameProfile> = {
  [minecraftProfile.id]: minecraftProfile,
  [factorioProfile.id]: factorioProfile,
  [stardewValleyProfile.id]: stardewValleyProfile,
  [civilization6Profile.id]: civilization6Profile,
  [genericProfile.id]: genericProfile,
}

export function getProfile(id: string): GameProfile | undefined {
  if (!id) {return undefined}
  return PROFILES[id]
}

export function listProfiles(): GameProfile[] {
  return Object.values(PROFILES)
}

/**
 * 根据窗口标题 / 进程名自动探测当前活跃 Profile。
 * 命中规则（按注册顺序返回第一个命中）：
 *   1. windowMatch.includes 任一子串出现在 windowTitle 中
 *   2. windowMatch.regex 任一正则匹配 windowTitle
 *   3. processMatch 包含进程名（小写比较）
 * 都不命中返回 undefined。
 */
export function detectActiveProfile(
  windowTitle?: string,
  processName?: string,
): GameProfile | undefined {
  const title = (windowTitle || '').toLowerCase()
  const proc = (processName || '').toLowerCase().replace(/\.exe$/i, '')

  for (const p of Object.values(PROFILES)) {
    if (title) {
      if (p.windowMatch.includes?.some(sub => title.includes(sub.toLowerCase()))) {
        return p
      }
      if (p.windowMatch.regex?.some(re => new RegExp(re, 'i').test(title))) {
        return p
      }
    }
    if (proc && p.processMatch.some(n => n === proc)) {
      return p
    }
  }
  return undefined
}
