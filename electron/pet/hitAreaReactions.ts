// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/hitAreaReactions.ts — 🎯 Live2D 身体部位点击反应（纯函数，可单测）
//
// 渲染层 pet-live2d.html 内联实现了同样的命中检测与动作播放；
// 这里把「部位 → 表情/动作/台词」映射与「3 秒防抖」决策抽成零依赖纯函数，
// 供单元测试锁定行为（任务三要求单测覆盖反应映射与防抖逻辑）。
// ============================================================

export interface HitReaction {
  /** FACE_EXPR_MAP 语义名（happy/surprise/...） */
  face: string
  /** 动作组名（TapBody 等，模型无该组时渲染层静默跳过） */
  motion: string
  /** 气泡台词 */
  line: string
}

/** 身体部位 → 反应映射表（与 pet-live2d.html HIT_AREA_REACTIONS 保持一致） */
export const HIT_AREA_REACTIONS: Record<'Head' | 'Body', HitReaction> = {
  Head: { face: 'happy', motion: 'TapBody', line: '摸头~好舒服~' },
  Body: { face: 'surprise', motion: 'TapBody', line: '干嘛啦~' },
}

/** 同一部位防抖窗口（毫秒） */
export const HIT_DEBOUNCE_MS = 3000

/** 把模型命中区名规范化为 Head/Body（大小写不敏感），其余返回 null */
export function normalizeHitArea(area: string): 'Head' | 'Body' | null {
  if (!area) {return null}
  if (/head/i.test(area)) {return 'Head'}
  if (/body/i.test(area)) {return 'Body'}
  return null
}

/** 命中部位 → 反应；未知部位返回 null（调用方应退回默认行为：开聊天窗） */
export function resolveHitReaction(area: string): HitReaction | null {
  const norm = normalizeHitArea(area)
  return norm ? HIT_AREA_REACTIONS[norm] : null
}

/**
 * 防抖判定：同一部位在 debounceMs 内重复触发视为被抑制。
 * @param area 命中区名
 * @param lastHitAt 各部位上次触发时间戳表（由渲染层维护）
 * @param now 当前时间戳
 * @param debounceMs 防抖窗口，默认 3000
 */
export function isHitThrottled(
  area: string,
  lastHitAt: Record<string, number>,
  now: number,
  debounceMs: number = HIT_DEBOUNCE_MS,
): boolean {
  const t = lastHitAt[area]
  if (t === undefined) {return false}
  return now - t < debounceMs
}
