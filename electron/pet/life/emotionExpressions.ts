// ============================================================
// pet/life/emotionExpressions.ts — 🎭 情绪外显 (I2, v0.1)
//
// emotionCore 里 valence/arousal/焦虑/疲劳 是「连续数值」，但用户看不见——
// 她焦虑时话还是一样长，累了样子还是一样精神。本模块把连续情绪翻译成
// 用户可感知的行为提示（BehaviorHints）：
//   - 焦虑 > 0.6      → 话术变短（speechShort，主进程拼 prompt / 截长句时读）
//   - 疲劳 > 0.6      → 桌宠变淡（petOpacity 降到 0.7，主进程发 set-opacity 命令）
//   - 冷战（>3 天没理）→ 转身背对（petAction='turnaway'，主动搭话倾向归零）
//   - 刚被哄好（24h 内主动搭话）→ 眼睛一亮（petAction='perk'，原谅回暖）
//
// 纯 TS、零依赖（不引用 Electron / DOM），主进程、渲染运行时、单测同构可用。
// 「亲密度+1（原谅）」是调用方（intentDispatcher）拿到 perk 后的副作用，
// 本函数只负责给出提示，不写关系库。
// ============================================================

import type { CoreEmotion } from './emotionCore'

/** 冷战三态（与 coldWar.ts 的纯状态机对齐） */
export type ColdState = 'warm' | 'cooling' | 'cold'

/** 桌宠即时动作（映射到 runtime 的 action 层姿态） */
export type PetAction = 'idle' | 'sigh' | 'perk' | 'turnaway'

/** 外显行为提示：主进程/渲染层据此调整话术、透明度、动作、主动搭话频率 */
export interface BehaviorHints {
  /** 焦虑时话术变短（拼 prompt 时收紧篇幅上限） */
  speechShort: boolean
  /** 桌宠整体透明度 0~1（疲劳时变淡） */
  petOpacity: number
  /** 桌宠即时动作 */
  petAction: PetAction
  /** 主动搭话倾向 0~1（冷战时归零，被哄好时冲高） */
  initiativeTendency: number
}

/** 计算提示时需要的外部上下文（冷战状态 / 近期是否被搭话） */
export interface ExpressionContext {
  coldState: ColdState
  /** 用户在最近 24h 内主动说过话（原谅/回暖窗口） */
  userSpokeWithin24h: boolean
}

// ── 阈值（与报告 I2 文案一致，集中在此便于调参）──
const ANXIETY_SPEECH_SHORT = 0.6
const FATIGUE_DIM = 0.6
/** 疲劳时桌宠降到这个透明度 */
const TIRED_OPACITY = 0.7

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/**
 * 由连续情绪 + 冷战上下文推出外显行为提示。
 * 纯函数：同输入必同输出，时间/持久化由调用方负责。
 *
 * 动作优先级（高→低）：
 *   冷战且未被哄 → 转身背对(turnaway)
 *   刚被哄好(非 warm 状态下 24h 内搭话) → 精神一振(perk)「原谅」
 *   疲劳 > 0.6 → 叹气(sigh)
 *   其余 → 待机(idle)
 */
export function deriveBehaviorHints(
  emotion: Pick<CoreEmotion, 'anxiety' | 'fatigue' | 'valence' | 'arousal'>,
  ctx: ExpressionContext,
): BehaviorHints {
  const anxiety = clamp01(emotion.anxiety)
  const fatigue = clamp01(emotion.fatigue)
  const valence = Number.isFinite(emotion.valence) ? emotion.valence : 0

  // 焦虑 → 话术变短
  const speechShort = anxiety > ANXIETY_SPEECH_SHORT
  // 疲劳 → 桌宠变淡
  const petOpacity = fatigue > FATIGUE_DIM ? TIRED_OPACITY : 1

  let petAction: PetAction = 'idle'
  let initiativeTendency = 0.5

  if (ctx.coldState === 'cold' && !ctx.userSpokeWithin24h) {
    // 冷战：不主动搭话，背对（硬归零，不受 valence 微调影响）
    petAction = 'turnaway'
    initiativeTendency = 0
  } else if (ctx.userSpokeWithin24h && ctx.coldState !== 'warm') {
    // 原谅/回暖：用户主动搭话把她哄回来了
    petAction = 'perk'
    initiativeTendency = 0.8
  } else if (fatigue > FATIGUE_DIM) {
    petAction = 'sigh'
    initiativeTendency = 0.25
  } else {
    // 非冷战时再用情绪微调：越正越愿意搭话，越负越缩
    initiativeTendency = clamp01(initiativeTendency + valence * 0.15)
  }

  return { speechShort, petOpacity, petAction, initiativeTendency }
}
