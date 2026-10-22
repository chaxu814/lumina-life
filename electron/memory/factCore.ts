// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// memory/factCore.ts — 事实来源强度与内容指纹纯函数（v1.0 抽自 memoryStore.ts）
//
// 【为什么抽这个文件】2026-10-20 冒烟测试暴露：打包产物里
//   memoryStore.ts 的兜底路径 require('./jsonMemoryStore')
//   在 electron-vite 打平后解析不到（out/main/ 下没有这个文件），
//   原生 SQLite 一旦不可用，JSON 兜底存储整个失灵。
//   改成静态 import 才能被 bundler 正确处理——但 jsonMemoryStore
//   又需要本文件的 6 个符号，直接互相 import 会形成运行时环
//   （本项目已有 madge 运行时环门禁，不允许新增）。
//   所以把这批无副作用的纯函数下沉到第三方模块 factCore：
//   memoryStore 与 jsonMemoryStore 都从这儿取，环自然消失。
//
// 本文件内容与 memoryStore.ts 中的原实现逐字一致（含注释），
// 公开 API 经 memoryStore 的 re-export 保持不变，外部 import 路径不用改。
// ============================================================

// ── 事实来源强度（防幻觉固化）────────────────────────────
//
// 为什么要有这一层：记忆被污染比记不住更危险。
// 旧实现里模型只要调一次 memory_save，就写进 confidence=1.0 / source='user_said'，
// 之后 memory_get 把「(100%)」原样喂回模型，于是这一次编造被当成权威事实反复召回，
// 每轮都在加固，且没有任何纠正路径。
//
// 现在的规矩：
//   1. 事实的权威性只由 source（谁说的）决定，不由调用方随手传的 confidence 决定；
//   2. 外部传入的 confidence 一律按 source 上限 clamp，不允许越界；
//   3. 低置信度（<0.8）条目在展示时必须带「未验证」标注；
//   4. 写入按内容指纹去重，更高置信度的说法覆盖旧记录（唯一的纠正路径）。

/** 事实来源枚举：来源强度 = 置信度上限 */
export type FactSource = 'user_stated' | 'user_confirmed' | 'model_inferred'

/** 各来源的置信度上限与缺省值 */
export const SOURCE_CONFIDENCE: Record<FactSource, { cap: number; default: number; label: string }> = {
  user_confirmed: { cap: 1.0, default: 1.0, label: '用户确认过' },
  user_stated: { cap: 0.95, default: 0.95, label: '用户亲口说过' },
  model_inferred: { cap: 0.6, default: 0.6, label: '模型推断，未验证' },
}

/** 低于此值的记忆视为「未验证」，展示时必须带标注 */
export const UNVERIFIED_CONFIDENCE = 0.8

/** 旧数据（无 source / 老枚举值）一律按 user_said 处理，但置信度上限压到 0.9 —— 不给老数据 100% 的权威 */
export const LEGACY_CONFIDENCE_CAP = 0.9

/** memory_save 未声明来源时的缺省来源：模型自己说的，不确定性最高 */
export const DEFAULT_FACT_SOURCE: FactSource = 'model_inferred'

/** 旧枚举 → 新枚举（用于调用方/LLM 传来的 source 归一化；DB 里的旧行不改写，只降权） */
const LEGACY_SOURCE_ALIAS: Record<string, FactSource> = {
  user_said: 'user_stated',    // 老代码把模型输出也标成 user_said，这里按「用户说的」理解
  observed: 'model_inferred',  // 模型自称观察到，但没有独立验证
  inferred: 'model_inferred',
}

/** 归一化 source：未知/缺失一律降级为 model_inferred（最保守，宁可标未验证也不给权威） */
export function normalizeFactSource(raw?: string | null): FactSource {
  const s = (raw || '').trim()
  if (s in SOURCE_CONFIDENCE) { return s as FactSource }
  return LEGACY_SOURCE_ALIAS[s] || DEFAULT_FACT_SOURCE
}

/** 解析一条（可能是旧数据的）source，返回其置信度上限 */
export function resolveSourceCap(raw?: string | null): number {
  const s = (raw || '').trim()
  return (s in SOURCE_CONFIDENCE) ? SOURCE_CONFIDENCE[s as FactSource].cap : LEGACY_CONFIDENCE_CAP
}

/** 把外部传入的 confidence 压进 [0, cap]：只允许往低调，不允许往高调 */
export function clampConfidence(value: number | null | undefined, cap: number): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : cap
  return Math.max(0, Math.min(v, cap))
}

/** 落库前把 confidence 按 source 上限收敛 */
export function resolveConfidence(source: string | null | undefined, requested?: number | null): number {
  return clampConfidence(requested, resolveSourceCap(source))
}

/**
 * 内容归一化（写入去重用的指纹原料）：全角转半角、转小写、去空白与标点。
 * 为什么：同一句幻觉换个标点/大小写再写一遍，不该变成「两条互相印证的事实」。
 */
export function normalizeFactContent(content: string): string {
  return (content || '')
    .replace(/[\uff01-\uff5e]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角 → 半角
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, '') // 只保留字母与数字（\p{Letter} 含中日韩汉字）
}

/** 内容指纹：category + 归一化内容，作为同一条事实的身份 */
export function factContentKey(category: string, content: string): string {
  return `${category}\u0001${normalizeFactContent(content)}`
}

/**
 * 给事实内容加「未验证」标注（低置信度）或置信度百分比（高置信度）。
 * 为什么要标：模型看到 (60%) 不会当权威，看到一句干净的事实会。
 */
export function markUnverifiedFact(content: string, fact: { confidence?: number | null }): string {
  const conf = typeof fact.confidence === 'number' && Number.isFinite(fact.confidence) ? fact.confidence : 0
  const pct = Math.round(conf * 100)
  if (conf < UNVERIFIED_CONFIDENCE) { return `${content}【未验证·模型推断，置信度 ${pct}%】` }
  return `${content}（${pct}%）`
}
