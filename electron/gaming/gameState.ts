// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/gaming/gameState.ts — 游戏状态解析
//
// 把 VLM 返回的 JSON / 文本解析为结构化 GameState。纯函数，可单测。
// ============================================================

import type { GameState, GameItemStack } from './types'
import type { GameProfile } from './profiles'
import { minecraftProfile } from './profiles'

/** VLM 游戏状态识别提示词（Minecraft 默认，视觉路线专用） */
export const GAME_VLM_SYSTEM_PROMPT = minecraftProfile.vlmPrompt

/**
 * 根据 Profile 构建完整 VLM 系统提示词。
 * 通用 JSON 字段说明 + 游戏专属读屏要点。
 */
export function buildVlmPrompt(profile: GameProfile = minecraftProfile): string {
  const base = `你是游戏视觉分析助手。请观察游戏截图，输出一个 JSON 对象，描述玩家当前的游戏状态。
只输出 JSON，不要解释。通用字段如下：
{
  "detected": true/false,
  "window_title": "窗口标题（若可见）",
  "health": 0-100 之间的数字,
  "max_health": 100,
  "food": 数字或 null,
  "xp_level": 整数或 null,
  "yaw": 水平视角角(度, -180~180, 估算),
  "pitch": 垂直视角角(度, -90~90, 估算),
  "position": {"x":0,"y":0,"z":0} 或 null,
  "gamemode": "模式或 unknown",
  "hotbar": [{"slot":1,"name":"物品名","count":1}],
  "near_entities": ["附近的实体/玩家/资源"],
  "summary": "一句话描述当前局面"
}
`
  return `${base}\n【${profile.displayName} 专属读屏要点】\n${profile.vlmPrompt}`
}

/** 从 VLM 原始输出中提取 JSON 对象（容忍 markdown 代码块包裹） */
function extractJson(raw: string): any | null {
  if (!raw) {return null}
  let s = raw.trim().replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) {s = s.slice(start, end + 1)}
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** 安全取数字字段，越界/非数返回 undefined */
function num(v: any, min?: number, max?: number): number | undefined {
  if (v == null || v === '') {return undefined}
  const n = Number(v)
  if (!Number.isFinite(n)) {return undefined}
  if (min != null && n < min) {return min}
  if (max != null && n > max) {return max}
  return n
}

function str(v: any): string | undefined {
  if (v == null) {return undefined}
  const s = String(v).trim()
  return s.length > 0 ? s : undefined
}

function parseHotbar(arr: any): GameItemStack[] {
  if (!Array.isArray(arr)) {return []}
  const out: GameItemStack[] = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') {continue}
    const slot = Number(it.slot)
    if (!Number.isFinite(slot)) {continue}
    out.push({
      slot: Math.floor(slot),
      name: str(it.name),
      count: num(it.count, 1, 64),
    })
  }
  // 按槽位排序
  out.sort((a, b) => a.slot - b.slot)
  return out
}

/**
 * 把 VLM 输出解析为结构化 GameState。
 * 解析失败时返回 detected:false 的兜底对象，不抛异常。
 */
export function parseVlmGameState(raw: string): GameState {
  const fallback: GameState = { detected: false, hotbar: [], raw: raw?.slice(0, 500) }
  const j = extractJson(raw)
  if (!j) {return fallback}

  const detected = Boolean(j.detected)
  const position = (() => {
    const p = j.position
    if (!p || typeof p !== 'object') {return undefined}
    const x = num(p.x), y = num(p.y), z = num(p.z)
    if (x == null || y == null || z == null) {return undefined}
    return { x, y, z, dimension: str(p.dimension) }
  })()

  return {
    detected,
    windowTitle: str(j.window_title),
    health: num(j.health, 0, 20),
    maxHealth: num(j.max_health, 0, 20) ?? 20,
    food: num(j.food, 0, 20),
    xpLevel: num(j.xp_level, 0, 24799),
    yaw: num(j.yaw, -180, 180),
    pitch: num(j.pitch, -90, 90),
    position,
    gamemode: str(j.gamemode),
    hotbar: parseHotbar(j.hotbar),
    nearEntities: Array.isArray(j.near_entities)
      ? j.near_entities.map((e: any) => str(e)).filter(Boolean) as string[]
      : undefined,
    raw: typeof j.summary === 'string' ? j.summary : raw?.slice(0, 500),
  }
}

/** 把 GameState 渲染为给 Agent 的可读文本 */
export function formatGameState(s: GameState, profile: GameProfile = minecraftProfile): string {
  const name = profile.displayName
  if (!s.detected) {
    return `🎮 未识别到 ${name} 游戏画面。${s.raw ? `\n描述: ${s.raw}` : ''}`
  }
  const lines: string[] = [`🎮 ${name} 状态:`]
  if (s.windowTitle) {lines.push(`  窗口: ${s.windowTitle}`)}
  if (s.gamemode) {lines.push(`  模式: ${s.gamemode}`)}
  if (s.health != null) {lines.push(`  生命: ${s.health}/${s.maxHealth ?? 100}`)}
  if (s.food != null) {lines.push(`  饥饿: ${s.food}`)}
  if (s.xpLevel != null) {lines.push(`  经验等级: ${s.xpLevel}`)}
  if (s.yaw != null || s.pitch != null) {
    lines.push(`  视角: yaw=${(s.yaw ?? 0).toFixed(0)}° pitch=${(s.pitch ?? 0).toFixed(0)}°`)
  }
  if (s.position) {
    const p = s.position
    lines.push(`  坐标: x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} z=${p.z.toFixed(1)}${p.dimension ? ` (${p.dimension})` : ''}`)
  }
  if (s.hotbar.length > 0) {
    const hb = s.hotbar.map(i => `[${i.slot}]${i.name || '?'}(x${i.count ?? 1})`).join(' ')
    lines.push(`  快捷栏: ${hb}`)
  }
  if (s.nearEntities && s.nearEntities.length > 0) {
    lines.push(`  附近: ${s.nearEntities.join(', ')}`)
  }
  return lines.join('\n')
}
