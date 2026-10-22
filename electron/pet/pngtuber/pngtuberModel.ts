// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/pngtuber/pngtuberModel.ts — 🖼 PNGTuber 模型定义与状态机 (v0.1)
//
// PNGTuber = 静态立绘 + 口型/眨眼切换，不需要 Live2D 核、不需要 three.js，
// 成本极低（一张透明 PNG 切两张即可）。本模块只定义「模型长什么样、
// 状态怎么跳」，纯逻辑无 DOM 依赖，可单测；真正画到 canvas 的在
// pngtuberRenderer.ts。
//
// 帧约定（与 modelImporter 的 PNGTUBER_FRAMES 保持一致）：
//   2 态：idle.png（闭嘴）+ talking.png（张嘴）
//   4 态：上面两张 + blink.png + blink-talking.png（闭眼版）
// ============================================================

/** 四态帧 */
export type PngTuberFrame = 'idle' | 'talking' | 'blink' | 'blinkTalking'

/** 运行期可调参数（可被 pngtuber.json 覆盖） */
export interface PngTuberConfig {
  /** 眨眼间隔下限（毫秒，随机区间 [min, max]） */
  blinkMinMs: number
  /** 眨眼间隔上限（毫秒） */
  blinkMaxMs: number
  /** 一次闭眼持续时长（毫秒） */
  blinkHoldMs: number
  /** 说话状态切换去抖：连续说话超过该时长才切 talking，避免每句话跳帧 */
  talkHoldMs: number
}

export const DEFAULT_PNGTUBER_CONFIG: PngTuberConfig = {
  blinkMinMs: 2200,
  blinkMaxMs: 6500,
  blinkHoldMs: 140,
  talkHoldMs: 260,
}

/** 帧文件名 → 状态（相对模型目录） */
export const FRAME_FILES: Record<PngTuberFrame, string> = {
  idle: 'idle.png',
  talking: 'talking.png',
  blink: 'blink.png',
  blinkTalking: 'blink-talking.png',
}

/** 目录里实际存在的帧集合（由导入器探测） */
export interface PngTuberFrames {
  idle: string
  talking: string
  blink?: string
  blinkTalking?: string
}

/** 根据当前状态挑选应绘制的帧；缺帧时自动降级 */
export function pickFrame(state: { talking: boolean; blinking: boolean }, frames: PngTuberFrames): PngTuberFrame {
  const { talking, blinking } = state
  if (blinking && frames.blinkTalking) {return 'blinkTalking'}
  if (blinking && frames.blink) {return 'blink'}
  if (talking) {return 'talking'}
  return 'idle'
}

/** 随机下一次眨眼的时间偏移（ms） */
export function nextBlinkDelay(cfg: PngTuberConfig, rand: () => number = Math.random): number {
  return Math.round(cfg.blinkMinMs + rand() * Math.max(0, cfg.blinkMaxMs - cfg.blinkMinMs))
}

/**
 * 解析可选 pngtuber.json（宽松合并：只认字段类型，忽略多余键）。
 * 文件缺失/损坏时回退默认配置，不报错。
 */
export function parsePngTuberConfig(raw: unknown, base: PngTuberConfig = DEFAULT_PNGTUBER_CONFIG): PngTuberConfig {
  if (typeof raw !== 'object' || raw === null) {return { ...base }}
  const o = raw as Record<string, unknown>
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback)
  return {
    blinkMinMs: num(o.blinkMinMs, base.blinkMinMs),
    blinkMaxMs: num(o.blinkMaxMs, base.blinkMaxMs),
    blinkHoldMs: num(o.blinkHoldMs, base.blinkHoldMs),
    talkHoldMs: num(o.talkHoldMs, base.talkHoldMs),
  }
}
