// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/life/faceRig.ts — 😊 面部 / 身体参数原语 (v0.2)
//
// 把「情绪 / 视线 / 眨眼 / 呼吸 / 五元音口型」翻译成与具体模型无关的
// 语义姿态 StandardPose（通道→值）；再由 parameterProfile 映射到真实 ParamId。
// 这样情绪驱动、口型驱动是纯函数，可单测，也与模型资产解耦。
// ============================================================

import type { CoreEmotion } from './emotionCore'
import type { StandardChannel } from '../live2d/parameterProfile'

export type StandardPose = Partial<Record<StandardChannel, number>>
export type Viseme = 'A' | 'I' | 'U' | 'E' | 'O' | 'rest'

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
/** 情绪 → 面部/身体语义姿态 */
export function poseForEmotion(core: CoreEmotion): StandardPose {
  const v = core.valence
  const a = core.arousal
  const fatigue = core.fatigue
  const anxiety = core.anxiety

  const eyeOpen = clamp(0.6 + a * 0.55 - fatigue * 0.55, 0.05, 1.25)
  const eyeSmile = v > 0.3 ? clamp01((v - 0.2) * 0.9) : 0
  const smile = v > 0.12 ? clamp01((v - 0.12) * 1.05) : 0
  const frown = v < -0.1 ? clamp01((-v - 0.1) * 1.0) : 0
  // 高唤醒抬眉；低落/疲惫垂眉
  const browRaise = a > 0.62 ? clamp01((a - 0.62) * 1.6) : 0
  const browDroop = (v < -0.25 || fatigue > 0.6) ? clamp01(Math.max(-v - 0.1, fatigue - 0.4) * 0.8) : 0
  const browY = browRaise * 0.8 - browDroop * 0.7
  // 焦虑/难过：眉头内蹙（角度）
  const browAngle = clamp01(anxiety * 0.9 + (v < -0.4 ? 0.3 : 0))
  // 开心又害羞时脸颊红晕
  const cheek = clamp01(v * a * 0.55)
  // 头：难过低头(+)，兴奋抬头(-)；开心微侧
  const headPitch = clamp((v < 0 ? -v * 14 : 0) - (a > 0.85 ? 6 : 0), -12, 16)
  const headRoll = clamp(v * 7, -9, 9)
  const bodyRoll = headRoll * 0.35
  // 紧张耸肩
  const shoulder = clamp01(anxiety * 0.5 + (a > 0.92 ? 0.2 : 0))

  return {
    eyeLOpen: eyeOpen, eyeROpen: eyeOpen,
    eyeLSmile: eyeSmile, eyeRSmile: eyeSmile,
    mouthUp: smile, mouthDown: frown,
    browLY: browY, browRY: browY,
    browLAngle: browAngle, browRAngle: browAngle,
    cheek,
    headPitch, headRoll,
    bodyRoll,
    shoulderL: shoulder, shoulderR: shoulder,
  }
}

/** 五元音口型（open 为该元音的饱满度 0~1）；rest 显式归零 */
export function visemePose(viseme: Viseme, open = 1): StandardPose {
  const o = clamp01(open)
  const base: StandardPose = { visemeA: 0, visemeI: 0, visemeU: 0, visemeE: 0, visemeO: 0, mouthAngry: 0 }
  if (viseme === 'rest') {return base}
  base[`viseme${viseme}` as StandardChannel] = o
  if (viseme === 'U') {base.mouthAngry = 0.25 * o} // 噘嘴
  return base
}

/** 视线：x/y ∈ [-1,1]；headFollow 0~1 控制头跟随强度 */
export function gazePose(x: number, y: number, headFollow = 0.25): StandardPose {
  const gx = clamp(x, -1, 1)
  const gy = clamp(y, -1, 1)
  return {
    eyeBallX: gx,
    eyeBallY: gy,
    headYaw: gx * 8 * headFollow,
    headPitch: clamp(-gy * 6 * headFollow, -8, 8),
  }
}

/** 眨眼：amount 0(睁眼)~1(完全闭合) */
export function blinkPose(amount: number): StandardPose {
  const open = 1 - clamp01(amount)
  return { eyeLOpen: open, eyeROpen: open }
}

/** 呼吸：phase 0~1 周期 → breath 值（用于 ParamBreath） */
export function breathPose(phase: number): StandardPose {
  const t = ((phase % 1) + 1) % 1
  return { breath: clamp01(0.5 - 0.5 * Math.cos(t * Math.PI * 2)) }
}

/** 休息/中性姿态（让混合器有明确回落目标） */
export function neutralPose(): StandardPose {
  return {
    headPitch: 0, headYaw: 0, headRoll: 0,
    eyeLOpen: 1, eyeROpen: 1, eyeLSmile: 0, eyeRSmile: 0,
    eyeBallX: 0, eyeBallY: 0,
    browLY: 0, browRY: 0, browLAngle: 0, browRAngle: 0,
    visemeA: 0, visemeI: 0, visemeU: 0, visemeE: 0, visemeO: 0,
    mouthUp: 0, mouthDown: 0, mouthAngry: 0, cheek: 0,
    bodyPitch: 0, bodyYaw: 0, bodyRoll: 0, shoulderL: 0, shoulderR: 0,
  }
}
