// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/gaming/antiCheat.ts — 反作弊游戏黑名单检测
//
// 带 BattlEye / EasyAntiCheat(EAC) / VAC / 其他内核级反作弊的竞技网游，
// 任何自动化键鼠输入 / 截图识别都极可能被判定为外挂导致封号。
// Lumina 的游戏陪伴只适合单机 / 合作 / 官方允许的场景。
//
// 这里用窗口标题匹配做第一道硬拦截：
//   - 命中黑名单 → 强制拒绝启用游戏能力 / 自动游玩立即停止
//   - 注意：窗口标题匹配可能漏检（游戏标题不含游戏名），也可能误报。
// ============================================================

/** 一个带反作弊的竞技网游条目 */
export interface AntiCheatGame {
  /** 展示名（提示文案里用） */
  name: string
  /** 窗口标题匹配正则（不区分大小写） */
  windowMatch: RegExp
  /** 反作弊种类（提示用） */
  anticheat?: string
}

/** 反作弊竞技网游黑名单（窗口标题子串匹配） */
export const ANTI_CHEAT_GAMES: AntiCheatGame[] = [
  { name: 'Counter-Strike 2 (CS2)', windowMatch: /counter[- ]?strike|\bcs2\b|\bcsgo\b/i, anticheat: 'VAC / VACnet' },
  { name: 'Call of Duty / Warzone', windowMatch: /call of duty|\bwarzone\b|\bcodmw\b/i, anticheat: 'Ricochet' },
  { name: 'Valorant', windowMatch: /valorant/i, anticheat: 'Vanguard' },
  { name: 'PUBG: Battlegrounds', windowMatch: /pubg|playerunknown|battlegrounds/i, anticheat: 'BattlEye' },
  { name: 'Fortnite', windowMatch: /fortnite/i, anticheat: 'EasyAntiCheat / BattlEye' },
  { name: 'Apex Legends', windowMatch: /apex legends|\bapex\b/i, anticheat: 'EasyAntiCheat' },
  { name: 'Rainbow Six Siege', windowMatch: /rainbow six|\br6s?\b|siege/i, anticheat: 'BattlEye' },
  { name: 'Overwatch 2', windowMatch: /overwatch/i, anticheat: 'Warden' },
  { name: 'Destiny 2', windowMatch: /destiny\s*2/i, anticheat: 'BattlEye' },
  { name: 'Rust', windowMatch: /\brust\b/i, anticheat: 'BattlEye' },
  { name: 'DayZ', windowMatch: /\bdayz\b/i, anticheat: 'BattlEye' },
  { name: 'Escape from Tarkov', windowMatch: /tarkov/i, anticheat: 'BattleState 自研' },
  { name: 'PUBG: BATTLEGROUNDS', windowMatch: /pubg: battlegrounds/i },
  { name: 'Rainbow Six Mobile', windowMatch: /rainbow six mobile/i },
]

/**
 * 检测窗口标题是否命中反作弊黑名单。
 * 命中返回游戏展示名，否则返回 null。
 */
export function detectAntiCheatGame(windowTitle: string | undefined | null): string | null {
  const t = (windowTitle || '').trim()
  if (!t) {return null}
  for (const g of ANTI_CHEAT_GAMES) {
    if (g.windowMatch.test(t)) {return g.name}
  }
  return null
}

/**
 * 判断是否应在反作弊游戏上拦截游戏能力 / 自动游玩。
 * 即 detectAntiCheatGame 的布尔别名，语义更清晰。
 */
export function isAntiCheatGame(windowTitle: string | undefined | null): boolean {
  return detectAntiCheatGame(windowTitle) !== null
}
