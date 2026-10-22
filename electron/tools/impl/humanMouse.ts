// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// humanMouse.ts — 拟人化鼠标移动（Human-like Mouse Movement）
//
// 背景：原 PlatformAdapter.mouseClick / mouseHover / mouseDrag 直接 SetCursorPos
// 瞬移，光标从 A 跳到 B，不像人操作。本模块在不破坏原适配器契约的前提下，
// 给 click / hover / drag 套一层「可见的缓动 + 随机抖动 + 点击前停顿」的移动。
//
// 设计要点：
//   1. 纯函数 buildHumanPath() 生成路径点（缓动 easeOutCubic + 中间步随机偏移），
//      便于单测覆盖步数/缓动/抖动范围。
//   2. 副作用函数 humanMoveTo / humanClick / humanHover / humanDrag 通过
//      PlatformAdapter.mouseMove 逐步落位；instant 模式（LUMINA_CU_INSTANT_MOUSE=1）
//      或适配器不支持 getCursorPos 时退回原瞬移路径。
//   3. 拖拽走「mousedown → 路径点 mouseMove → mouseup」，适配器需提供可选的
//      mouseDown / mouseUp；未提供时退回整体 mouseDrag（保持旧行为）。
//
// 诚实披露：缓动曲线与抖动范围是工程近似，真实手感需实机目检；单测只验证逻辑。
// ============================================================

import type { PlatformAdapter } from '../../core/platform/PlatformAdapter'

// ──────────────────────────────────────────────────────────
// 类型与默认参数
// ──────────────────────────────────────────────────────────

export interface HumanMouseOptions {
  /** 强制步数；不传则按距离自适应（8–15 步） */
  steps?: number
  /** 每步实际延迟 ms 在 [lo, hi] 内随机 */
  stepDelayRange?: [number, number]
  /** 中间步随机偏移半径（像素），终点不抖 */
  jitterPx?: number
  /** 点击前停顿 ms 范围 */
  pauseBeforeClickRange?: [number, number]
  /** 注入随机源（测试用） */
  random?: () => number
  /** 注入 sleep（测试用） */
  sleep?: (ms: number) => Promise<void>
}

export interface HumanPathPoint { x: number; y: number }

export interface HumanPath {
  /** 含起点与终点；调用方按顺序逐步落位 */
  points: HumanPathPoint[]
  /** 本次移动每步的延迟 ms（已随机） */
  stepDelayMs: number
  /** 点击前停顿 ms（已随机） */
  pauseBeforeClickMs: number
}

const DEFAULTS = {
  stepsMin: 8,
  stepsMax: 15,
  stepDelayRange: [6, 14] as [number, number],
  jitterPx: 1.5,
  pauseRange: [60, 140] as [number, number],
  /** 距离每增加多少像素，步数 +1（用于自适应） */
  pxPerStep: 40,
}

// ──────────────────────────────────────────────────────────
// instant 模式开关
// ──────────────────────────────────────────────────────────

/** 极速/原始模式：环境变量 LUMINA_CU_INSTANT_MOUSE=1 时关闭拟人化，走原瞬移 */
export function isInstantMouse(): boolean {
  return process.env.LUMINA_CU_INSTANT_MOUSE === '1'
}

// ──────────────────────────────────────────────────────────
// 纯函数：路径生成
// ──────────────────────────────────────────────────────────

/** easeOutCubic：起步快、收尾慢，接近人伸手够目标的运动曲线 */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function randRange(rnd: () => number, lo: number, hi: number): number {
  return lo + rnd() * (hi - lo)
}

/**
 * 生成一条从 (x1,y1) 到 (x2,y2) 的拟人化路径。
 * - 步数：默认按距离自适应（8–15 步），可用 opts.steps 覆盖
 * - 缓动：easeOutCubic
 * - 抖动：除起点/终点外，每步在 ±jitterPx 内随机偏移（终点无抖动）
 * - 延迟与停顿：在返回值里给出已随机化的数值，便于测试断言
 */
export function buildHumanPath(
  x1: number, y1: number, x2: number, y2: number,
  opts: HumanMouseOptions = {},
): HumanPath {
  const rnd = opts.random ?? Math.random
  const dist = Math.hypot(x2 - x1, y2 - y1)

  let steps = opts.steps
  if (!steps) {
    steps = Math.round(DEFAULTS.stepsMin + dist / DEFAULTS.pxPerStep)
    steps = Math.max(DEFAULTS.stepsMin, Math.min(DEFAULTS.stepsMax, steps))
  }

  const jitter = opts.jitterPx ?? DEFAULTS.jitterPx
  const delayRange = opts.stepDelayRange ?? DEFAULTS.stepDelayRange
  const pauseRange = opts.pauseBeforeClickRange ?? DEFAULTS.pauseRange

  const points: HumanPathPoint[] = [{ x: Math.round(x1), y: Math.round(y1) }]
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const e = easeOutCubic(t)
    const isEnd = i === steps
    const jx = isEnd ? 0 : randRange(rnd, -jitter, jitter)
    const jy = isEnd ? 0 : randRange(rnd, -jitter, jitter)
    points.push({
      x: Math.round(x1 + (x2 - x1) * e + jx),
      y: Math.round(y1 + (y2 - y1) * e + jy),
    })
  }

  return {
    points,
    stepDelayMs: randRange(rnd, delayRange[0], delayRange[1]),
    pauseBeforeClickMs: randRange(rnd, pauseRange[0], pauseRange[1]),
  }
}

// ──────────────────────────────────────────────────────────
// 副作用：逐步落位
// ──────────────────────────────────────────────────────────

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function sleepOf(opts: HumanMouseOptions): (ms: number) => Promise<void> {
  return opts.sleep ?? realSleep
}

/**
 * 拟人化移动到 (x,y)。
 * - instant 模式：直接 adapter.mouseMove（瞬移）
 * - 适配器提供 getCursorPos：以当前光标为起点，生成完整可见路径
 * - 否则：瞬移到一个离目标 ~50px 的随机偏移点，再缓动到目标（避免从画面任意位置直接跳过去）
 */
export async function humanMoveTo(
  adapter: PlatformAdapter, x: number, y: number,
  opts: HumanMouseOptions = {},
): Promise<void> {
  const sleep = sleepOf(opts)

  if (isInstantMouse()) {
    await adapter.mouseMove(x, y)
    return
  }

  let sx = x - 50, sy = y - 40
  if (typeof adapter.getCursorPos === 'function') {
    try {
      const cur = await adapter.getCursorPos()
      if (cur && Number.isFinite(cur.x) && Number.isFinite(cur.y)) {
        sx = cur.x; sy = cur.y
      }
    } catch { /* 读不到位置就用偏移起点 */ }
  }

  // 起点已离目标极近（<6px）就不演了，直接瞬移过去，避免抖动反而难看
  if (Math.hypot(x - sx, y - sy) < 6) {
    await adapter.mouseMove(x, y)
    return
  }

  const path = buildHumanPath(sx, sy, x, y, opts)
  // 第一个点（sx,sy）就是我们要「跳过去」的起点；随后逐点缓动
  await adapter.mouseMove(path.points[0].x, path.points[0].y)
  for (let i = 1; i < path.points.length; i++) {
    await sleep(path.stepDelayMs)
    await adapter.mouseMove(path.points[i].x, path.points[i].y)
  }
}

/** 拟人化点击：先缓动到目标 → 停顿 60–140ms → 调适配器原语（此时光标已在目标点，适配器内部的 SetCursorPos 不会再产生可见跳动） */
export async function humanClick(
  adapter: PlatformAdapter, x: number, y: number,
  button: 'left' | 'right', dbl: boolean,
  opts: HumanMouseOptions = {},
): Promise<string> {
  const sleep = sleepOf(opts)
  if (isInstantMouse()) {
    return adapter.mouseClick(x, y, button, dbl)
  }
  await humanMoveTo(adapter, x, y, opts)
  // 点击前短暂停顿（人在落位后会犹豫一下）
  const path = buildHumanPath(x, y, x, y, opts) // 仅取随机化的 pause 值
  await sleep(path.pauseBeforeClickMs)
  return adapter.mouseClick(x, y, button, dbl)
}

/** 拟人化悬停：缓动到目标 → 停留 holdMs */
export async function humanHover(
  adapter: PlatformAdapter, x: number, y: number, holdMs: number,
  opts: HumanMouseOptions = {},
): Promise<string> {
  const sleep = sleepOf(opts)
  if (isInstantMouse()) {
    return adapter.mouseHover(x, y, holdMs)
  }
  await humanMoveTo(adapter, x, y, opts)
  await sleep(Math.max(0, holdMs))
  return '悬停完成'
}

/**
 * 拟人化拖拽：
 *   1. 缓动到起点 (x1,y1)
 *   2. 停顿一下 → mouseDown
 *   3. 沿缓动路径逐步 mouseMove 到 (x2,y2)
 *   4. 停顿一下 → mouseUp
 * 适配器未提供 mouseDown/mouseUp 时，退回旧的整体 mouseDrag（保持兼容）。
 */
export async function humanDrag(
  adapter: PlatformAdapter, x1: number, y1: number, x2: number, y2: number,
  opts: HumanMouseOptions = {},
): Promise<string> {
  const sleep = sleepOf(opts)

  if (isInstantMouse()
    || typeof adapter.mouseDown !== 'function'
    || typeof adapter.mouseUp !== 'function') {
    return adapter.mouseDrag(x1, y1, x2, y2)
  }

  // 1. 缓动到起点
  await humanMoveTo(adapter, x1, y1, opts)
  await sleep(60)

  // 2. 按下
  await adapter.mouseDown(x1, y1, 'left')
  await sleep(50)

  // 3. 路径逐步拖到终点（从起点开始，起点已在 (x1,y1)，跳过第 0 个点）
  const path = buildHumanPath(x1, y1, x2, y2, opts)
  for (let i = 1; i < path.points.length; i++) {
    await sleep(path.stepDelayMs)
    await adapter.mouseMove(path.points[i].x, path.points[i].y)
  }

  // 4. 抬起
  await sleep(50)
  await adapter.mouseUp(x2, y2, 'left')
  return '拖拽完成'
}
