// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// rituals/present.ts — 口播呈现链：TTS 播报 → 失败降级文字气泡 → 桌宠动作
//
// 降级原则（与 edge-tts 实测行为对齐）：
//   - ttsSpeak 返回 {ok:false, detail} 时 detail 不许吞，写进运行记录
//   - TTS 整条链路任何一步抛错都不阻断流程，降级到气泡
//   - 气泡也没有时静默放弃呈现（记录 delivered='none'），不打断用户
// ============================================================

import type { RitualDeps, RitualKind, RitualUtterance } from './types'

export type Delivered = 'tts' | 'bubble' | 'none'

/** 桌宠动作映射：睡前用最接近「安静休息」的现有动作，晨间用招呼动作（不新增动作资源） */
export function petMotionFor(kind: RitualKind): { motion: string; expression?: string } {
  if (kind === 'night') {return { motion: 'rest', expression: 'gentle' }}
  return { motion: 'seekAttention', expression: 'bright' }
}

/**
 * 呈现一条口播。
 * @returns delivered 呈现方式；ttsDetail TTS 失败原因（可能为空）
 */
export async function presentUtterance(
  utterance: RitualUtterance,
  deps: RitualDeps,
): Promise<{ delivered: Delivered; ttsDetail?: string }> {
  // 1) TTS 播报
  if (deps.ttsSpeak) {
    try {
      const r = await deps.ttsSpeak(utterance.text)
      if (r && r.ok) {
        // 播报完顺手做个对应的桌宠动作
        firePetAction(utterance.kind, deps)
        return { delivered: 'tts' }
      }
      // TTS 起不来：不吞 detail，降级气泡
      return fallbackToBubble(utterance, deps, r?.detail)
    } catch (e: any) {
      return fallbackToBubble(utterance, deps, e?.message || String(e))
    }
  }
  return fallbackToBubble(utterance, deps)
}

function fallbackToBubble(
  utterance: RitualUtterance,
  deps: RitualDeps,
  ttsDetail?: string,
): { delivered: Delivered; ttsDetail?: string } {
  try {
    if (deps.showBubble) {
      deps.showBubble(utterance.text, utterance.source)
      firePetAction(utterance.kind, deps)
      return { delivered: 'bubble', ttsDetail }
    }
  } catch {
    /* 气泡也挂了 → none */
  }
  return { delivered: 'none', ttsDetail }
}

function firePetAction(kind: RitualKind, deps: RitualDeps): void {
  try {
    if (deps.petAction) {
      const { motion, expression } = petMotionFor(kind)
      deps.petAction(motion, expression)
    }
  } catch {
    /* 桌宠没起来不影响主流程 */
  }
}
