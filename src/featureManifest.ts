// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// featureManifest.ts — 功能分级清单（单一事实来源）
//
// 用来解决「功能蔓延、广度 > 深度」的问题：把所有功能明确划分为
//   core         核心体验（围绕「3 分钟生命时刻」：聊天、人格、记忆、桌宠）
//   beta         已可用但持续打磨
//   experimental 实验彩蛋（模板/早期实现，明确标注，避免误导用户）
//
// 导航、社区弹窗、设置中的「实验室」开关都从这里读取，避免各处硬编码。
// ============================================================

export type FeatureTier = 'core' | 'beta' | 'experimental'

export interface FeatureDef {
  id: string
  tier: FeatureTier
  /** 面板/入口名（中文） */
  label: string
  /** 一句话说明，告诉用户这项功能当前成熟度 */
  note?: string
}

export const FEATURE_TIERS: Record<string, FeatureTier> = {
  // ── 核心：构成 Lumina 的「生命感」 ──
  chat: 'core',
  profile: 'core',
  memory: 'core',
  emotions: 'core',
  team: 'core',
  agent: 'core',
  settings: 'core',
  // ── 可用 / 持续打磨 ──
  mail: 'beta',
  news: 'beta',
  knowledge: 'beta',
  skillmarket: 'beta',
  skills: 'beta',
  deepresearch: 'beta',
  bookmarks: 'beta',
  tasks: 'beta',
  security: 'beta',
  diagnostics: 'beta',
  plugins: 'beta',
  familytree: 'beta',
  teamcommunity: 'beta',
  social: 'beta',
  // ── 实验彩蛋：模板或早期实现，明确标注 ──
  dream: 'experimental',
  reality: 'experimental',
}

export const FEATURE_DEFS: FeatureDef[] = [
  { id: 'dream',   tier: 'experimental', label: '梦境日记', note: '配置大脑模型后由模型生成，否则用叙事模板兜底' },
  { id: 'reality', tier: 'experimental', label: '真人秀',   note: '内心独白可由模型生成，互动/冲突/成就为剧本' },
]

export function tierOf(id: string): FeatureTier {
  return FEATURE_TIERS[id] ?? 'beta'
}

export function isExperimental(id: string): boolean {
  return tierOf(id) === 'experimental'
}

export const TIER_LABEL: Record<FeatureTier, string> = {
  core: '核心',
  beta: '测试',
  experimental: '🧪 实验',
}
