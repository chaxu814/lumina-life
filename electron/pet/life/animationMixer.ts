// ============================================================
// pet/life/animationMixer.ts — 🎚️ 分层动作混合器 (v0.2)
//
// 旧实现里动作是封闭枚举、进 idle 直接 resetPoseParams 硬切，呼吸/视线/情绪/说话
// 互相抢参数。这里改为「分层混合」：
//   base    呼吸等生命微动作
//   emotion 情绪姿态（眉/眼/嘴角/头倾/肩，慢变）
//   gaze    视线（眼球 + 轻微头跟随）
//   speech  五元音口型（说话期独占嘴部）
//   action  一次性表演（手势强调/反应，带淡入淡出与 TTL）
// 每帧从低优先级到高优先级按权重软混合；眨眼乘性闭合；再做变化率限速防鬼畜。
// 纯 TS、时间注入，可单测。
// ============================================================

import type { StandardPose, Viseme } from './faceRig'
import { CHANNEL_RANGES, type StandardChannel } from '../live2d/parameterProfile'

export type LayerId = 'base' | 'emotion' | 'gaze' | 'speech' | 'action'

export const LAYER_PRIORITY: Record<LayerId, number> = {
  base: 0, emotion: 1, gaze: 2, speech: 3, action: 4,
}

interface LayerState {
  pose: StandardPose
  weight: number
  /** 绝对过期时间 ms（注入时钟），undefined 表示常驻 */
  expiresAt?: number
  /** action 层淡入淡出时长 ms */
  fadeMs?: number
  bornAt: number
}

export interface MixerOptions {
  /** 每帧每通道最大变化量（角度类与归一化类分别给默认） */
  maxDeltaAngle?: number
  maxDeltaNorm?: number
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export class AnimationMixer {
  private layers = new Map<LayerId, LayerState>()
  private prev: StandardPose = {}
  private blinkAmount = 0
  private opts: Required<MixerOptions>

  constructor(opts: MixerOptions = {}) {
    this.opts = {
      maxDeltaAngle: opts.maxDeltaAngle ?? 9,
      maxDeltaNorm: opts.maxDeltaNorm ?? 0.28,
    }
  }

  setLayer(id: LayerId, pose: StandardPose, opts: { weight?: number; ttlMs?: number; fadeMs?: number; now?: number } = {}): void {
    const now = opts.now ?? 0
    this.layers.set(id, {
      pose,
      weight: opts.weight ?? 1,
      expiresAt: opts.ttlMs === undefined ? undefined : now + opts.ttlMs,
      fadeMs: opts.fadeMs,
      bornAt: now,
    })
  }

  clearLayer(id: LayerId): void { this.layers.delete(id) }
  has(id: LayerId): boolean { return this.layers.has(id) }
  setBlink(amount: number): void { this.blinkAmount = clamp(amount, 0, 1) }

  /** action 层当前 envelope（淡入淡出 0~1）；fadeMs<=0 表示无淡变恒为 1 */
  private envelope(l: LayerState, now: number): number {
    const fade = l.fadeMs && l.fadeMs > 0 ? l.fadeMs : null
    if (!fade) return 1
    const fadeIn = clamp((now - l.bornAt) / fade, 0, 1)
    const fadeOut = l.expiresAt === undefined ? 1 : clamp((l.expiresAt - now) / fade, 0, 1)
    return Math.min(fadeIn, fadeOut)
  }

  /** 计算某一帧最终姿态（纯状态推进；now 注入） */
  frame(now: number): StandardPose {
    // 1) 清理过期层
    for (const [id, l] of Array.from(this.layers)) {
      if (l.expiresAt !== undefined && now >= l.expiresAt) this.layers.delete(id)
    }

    const ordered = (Object.keys(LAYER_PRIORITY) as LayerId[])
      .filter(id => this.layers.has(id))
      .sort((a, b) => LAYER_PRIORITY[a] - LAYER_PRIORITY[b])

    // 2) 逐通道从低到高做权重软混合
    const out: StandardPose = {}
    const channels = Object.keys(CHANNEL_RANGES) as StandardChannel[]
    for (const ch of channels) {
      let acc: number | undefined
      for (const id of ordered) {
        const l = this.layers.get(id)!
        const val = l.pose[ch]
        if (val === undefined) continue
        let w = clamp(l.weight, 0, 1)
        if (id === 'action') w *= this.envelope(l, now)
        if (w <= 0.001) continue
        acc = acc === undefined ? val : lerp(acc, val, w)
      }
      if (acc !== undefined) out[ch] = acc
    }

    // 3) 眨眼：乘性闭合双眼
    if (this.blinkAmount > 0) {
      const k = 1 - this.blinkAmount
      out.eyeLOpen = (out.eyeLOpen ?? 1) * k
      out.eyeROpen = (out.eyeROpen ?? 1) * k
    }

    // 4) 变化率限速（与上一帧比较）
    const result: StandardPose = {}
    for (const ch of channels) {
      if (!(ch in out)) continue
      const [lo, hi] = CHANNEL_RANGES[ch]
      const target = clamp(out[ch] as number, lo, hi)
      const prevVal = this.prev[ch]
      if (prevVal === undefined) {
        result[ch] = target
      } else {
        const span = hi - lo
        const isAngle = span > 3
        const maxD = isAngle ? this.opts.maxDeltaAngle : this.opts.maxDeltaNorm
        const d = clamp(target - prevVal, -maxD, maxD)
        result[ch] = clamp(prevVal + d, lo, hi)
      }
    }
    this.prev = result
    return result
  }

  reset(): void { this.layers.clear(); this.prev = {}; this.blinkAmount = 0 }
}

/** 说话期嘴部由 speech 层独占：把当前 viseme 写入 speech 层的便捷封装 */
export function speechPoseFor(viseme: Viseme, open: number, browRaise = 0): StandardPose {
  const pose: StandardPose = {}
  const map: Record<Exclude<Viseme, 'rest'>, StandardChannel> = {
    A: 'visemeA', I: 'visemeI', U: 'visemeU', E: 'visemeE', O: 'visemeO',
  }
  for (const v of ['A', 'I', 'U', 'E', 'O'] as const) pose[map[v]] = 0
  if (viseme !== 'rest') pose[map[viseme]] = clamp(open, 0, 1)
  if (browRaise > 0) { pose.browLY = browRaise; pose.browRY = browRaise }
  return pose
}
