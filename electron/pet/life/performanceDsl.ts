// ============================================================
// pet/life/performanceDsl.ts — 🎭 AI 表演 DSL（解析 / 校验 / 护栏）(v0.2)
//
// 不让 LLM 逐帧刷 100+ 裸参数（贵、不稳、会鬼畜、可能触发魔法特效）。
// 大脑在原有 {action,mood,speech} 之外，可额外给一个高层 performance 指令：
//   { expression, gaze, gesture, headTilt, motion, effect, durationMs, blend }
// 本模块把任意不可信输入校验、钳制、规范化为类型安全的表演命令；
// 表情/手势/特效全部走白名单，非法项丢弃并记录 errors，绝不抛穿。
// 纯 TS、零依赖，可单测。
// ============================================================

import { normalizeMood, type MoodLabel } from './emotionCore'

export type GazeTarget = 'user' | 'away' | 'up' | 'down' | 'left' | 'right'
export type BlendMode = 'override' | 'add'

/** 现有渲染器已实现的动作（do* / motion3），一定可播 */
export const BUILTIN_GESTURES = [
  'wave', 'nod', 'shake', 'think', 'clap', 'dance', 'happy', 'surprised',
  'idle', 'sleep', 'wake', 'walk',
] as const
/** 可用语义参数姿态合成的手势（渲染层尽力，无实现则安全降级） */
export const PARAMETRIC_GESTURES = [
  'shrug', 'tilt', 'spread_hands', 'point', 'look_around', 'bounce', 'sad', 'angry',
] as const
export const GESTURE_WHITELIST: ReadonlySet<string> = new Set([...BUILTIN_GESTURES, ...PARAMETRIC_GESTURES])

/** 模型魔法特效高层白名单（渲染层映射到对应开关参数并在结束后归零） */
export const EFFECT_WHITELIST: ReadonlySet<string> = new Set([
  'heart', 'sparkle', 'stars', 'aura', 'heal', 'smoke', 'ink', 'rabbit',
])

const BASIC_EXPRESSIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy', 'thinking', 'sleepy'] as const
export type BasicExpression = (typeof BASIC_EXPRESSIONS)[number]

export interface NormalizedPerformance {
  expression?: MoodLabel | BasicExpression
  gaze?: { target?: GazeTarget; x?: number; y?: number }
  gesture?: { name: string; intensity: number; builtin: boolean }
  headTilt?: number
  motion?: string
  effect?: { name: string; amount: number }
  durationMs: number
  blend: BlendMode
}

export interface ParseResult {
  ok: boolean
  command: NormalizedPerformance | null
  errors: string[]
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null

function asGazeTarget(x: unknown): GazeTarget | undefined {
  return typeof x === 'string' && ['user', 'away', 'up', 'down', 'left', 'right'].includes(x)
    ? (x as GazeTarget) : undefined
}

/** 解析并规范化一段表演指令（输入不可信） */
export function parsePerformance(input: unknown): ParseResult {
  const errors: string[] = []
  if (!isObj(input)) {return { ok: false, command: null, errors: ['performance 必须是对象'] }}

  const command: NormalizedPerformance = { durationMs: 1200, blend: 'override' }

  // 表情：9 mood 标签或基础表情
  if (input.expression !== undefined) {
    const mood = normalizeMood(input.expression)
    if (mood) {command.expression = mood}
    else if (typeof input.expression === 'string' && (BASIC_EXPRESSIONS as readonly string[]).includes(input.expression))
      {command.expression = input.expression as BasicExpression}
    else {errors.push(`未知 expression: ${String(input.expression)}`)}
  }

  // 视线
  if (input.gaze !== undefined) {
    if (isObj(input.gaze)) {
      const g: NormalizedPerformance['gaze'] = {}
      const t = asGazeTarget(input.gaze.target)
      if (input.gaze.target !== undefined && !t) {errors.push(`未知 gaze.target: ${String(input.gaze.target)}`)}
      if (t) {g.target = t}
      if (typeof input.gaze.x === 'number') {g.x = clamp(input.gaze.x, -1, 1)}
      if (typeof input.gaze.y === 'number') {g.y = clamp(input.gaze.y, -1, 1)}
      if (g.target !== undefined || g.x !== undefined || g.y !== undefined) {command.gaze = g}
    } else {errors.push('gaze 必须是对象')}
  }

  // 手势
  const rawGesture = typeof input.gesture === 'string' ? { name: input.gesture } : input.gesture
  if (rawGesture !== undefined) {
    if (isObj(rawGesture) && typeof rawGesture.name === 'string') {
      const name = rawGesture.name
      if (GESTURE_WHITELIST.has(name)) {
        command.gesture = {
          name,
          intensity: typeof rawGesture.intensity === 'number' ? clamp(rawGesture.intensity, 0, 1) : 1,
          builtin: (BUILTIN_GESTURES as readonly string[]).includes(name),
        }
      } else {errors.push(`手势不在白名单: ${name}`)}
    } else if (input.gesture !== undefined) {errors.push('gesture 必须是字符串或 {name,intensity}')}
  }

  // 头侧倾
  if (input.headTilt !== undefined) {
    if (typeof input.headTilt === 'number') {command.headTilt = clamp(input.headTilt, -1, 1)}
    else {errors.push('headTilt 必须是数字')}
  }

  // motion3 名（只允许安全字符，防止路径穿越）
  if (input.motion !== undefined) {
    if (typeof input.motion === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(input.motion)) {command.motion = input.motion}
    else {errors.push(`非法 motion: ${String(input.motion)}`)}
  }

  // 特效
  const rawEffect = typeof input.effect === 'string' ? { name: input.effect } : input.effect
  if (rawEffect !== undefined) {
    if (isObj(rawEffect) && typeof rawEffect.name === 'string') {
      const name = rawEffect.name
      if (EFFECT_WHITELIST.has(name))
        {command.effect = { name, amount: typeof rawEffect.amount === 'number' ? clamp(rawEffect.amount, 0, 1) : 0.8 }}
      else {errors.push(`特效不在白名单: ${name}`)}
    } else if (input.effect !== undefined) {errors.push('effect 必须是字符串或 {name,amount}')}
  }

  if (typeof input.durationMs === 'number') {command.durationMs = clamp(Math.round(input.durationMs), 300, 6000)}
  if (input.blend === 'add' || input.blend === 'override') {command.blend = input.blend}

  const hasAny = ['expression', 'gaze', 'gesture', 'headTilt', 'motion', 'effect'].some(k => (command as any)[k] !== undefined)
  if (!hasAny) {return { ok: false, command: null, errors: [...errors, 'performance 没有任何有效字段'] }}
  return { ok: true, command, errors }
}

/** 便捷：把 LLM 可能给出的 performance（或 action:'perform'）安全解析，失败返回 null */
export function safePerformance(input: unknown): NormalizedPerformance | null {
  const r = parsePerformance(input)
  return r.ok ? r.command : null
}
