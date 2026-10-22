// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// impl/pomodoro.ts — 番茄钟提醒工具
//
// 默认 25 分钟工作 + 5 分钟休息。
// 用 setTimeout 计时，到点通过 Electron Notification 推送提醒。
// 状态保存在模块级变量中（主进程单例）。
// ============================================================

import type { ToolDef, ToolResult } from '../types'

type PomodoroPhase = 'work' | 'break'

interface PomodoroState {
  running: boolean
  phase: PomodoroPhase
  startedAt: number       // 当前阶段开始时间 (ms)
  totalMs: number        // 当前阶段总时长 (ms)
  breakMs: number        // 休息时长 (ms)
  timer: NodeJS.Timeout | null
}

const state: PomodoroState = {
  running: false,
  phase: 'work',
  startedAt: 0,
  totalMs: 25 * 60 * 1000,
  breakMs: 5 * 60 * 1000,
  timer: null,
}

/** 主进程内发送系统通知（Electron Notification 优先，失败则打印到 console） */
function notify(title: string, body: string): void {
  try {
    const electron = require('electron')
    const Notification = electron?.Notification
    if (Notification && typeof Notification === 'function') {
      new Notification({ title, body: body.slice(0, 200) }).show()
      return
    }
  } catch { /* 非 Electron 主进程环境，忽略 */ }
  console.log(`[pomodoro] 通知: ${title} — ${body}`)
}

/** 清理当前定时器 */
function clearTimer(): void {
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
}

/** 阶段切换：工作结束 → 开始休息；休息结束 → 一轮完成 */
function onPhaseComplete(): void {
  if (state.phase === 'work') {
    // 工作结束，进入休息
    state.phase = 'break'
    state.startedAt = Date.now()
    state.totalMs = state.breakMs
    notify('🍅 番茄钟 · 工作结束', `专注完成！休息 ${state.breakMs / 60000} 分钟，喝口水放松一下。`)
    state.timer = setTimeout(onPhaseComplete, state.breakMs)
  } else {
    // 休息结束，停止
    state.running = false
    state.timer = null
    notify('🍅 番茄钟 · 休息结束', '休息结束，准备进入下一个番茄钟吧！')
  }
}

// ── 工具 1: 启动番茄钟 ────────────────────────────────

export const pomodoroStartDef: ToolDef = {
  name: 'pomodoro_start',
  description: `启动番茄钟（默认 25 分钟工作 + 5 分钟休息）。
到点通过系统通知提醒。

参数:
- work_minutes: 工作时长(分钟)，默认 25
- break_minutes: 休息时长(分钟)，默认 5`,
  params: {
    work_minutes: { type: 'number', description: '工作时长(分钟)', required: false },
    break_minutes: { type: 'number', description: '休息时长(分钟)', required: false },
  },
  toolsets: ['agent'],
}

export async function pomodoroStart(args: Record<string, any>): Promise<ToolResult> {
  const workMin = Math.max(1, Number(args.work_minutes) || 25)
  const breakMin = Math.max(1, Number(args.break_minutes) || 5)

  if (state.running) {
    return {
      callId: '',
      ok: true,
      content: `⏱️ 已有番茄钟在运行中（当前阶段: ${state.phase === 'work' ? '工作' : '休息'}）。如需重新开始，请先 pomodoro_stop。`,
    }
  }

  clearTimer()
  state.running = true
  state.phase = 'work'
  state.startedAt = Date.now()
  state.totalMs = workMin * 60 * 1000
  state.breakMs = breakMin * 60 * 1000
  state.timer = setTimeout(onPhaseComplete, state.totalMs)

  notify('🍅 番茄钟开始', `专注 ${workMin} 分钟，加油！`)

  return {
    callId: '',
    ok: true,
    content:
      `🍅 番茄钟已启动\n\n` +
      `阶段: 工作 (${workMin} 分钟)\n` +
      `休息: ${breakMin} 分钟\n` +
      `到点会通过系统通知提醒你。用 pomodoro_status 查看剩余时间。`,
  }
}

// ── 工具 2: 查询状态 ──────────────────────────────────

export const pomodoroStatusDef: ToolDef = {
  name: 'pomodoro_status',
  description: `查询当前番茄钟状态：是否运行、当前阶段、剩余时间。`,
  params: {},
  toolsets: ['agent'],
}

export async function pomodoroStatus(): Promise<ToolResult> {
  if (!state.running) {
    return { callId: '', ok: true, content: '🍅 当前没有运行中的番茄钟。用 pomodoro_start 开始。' }
  }

  const elapsed = Date.now() - state.startedAt
  const remainMs = Math.max(0, state.totalMs - elapsed)
  const remainMin = Math.floor(remainMs / 60000)
  const remainSec = Math.floor((remainMs % 60000) / 1000)
  const phaseText = state.phase === 'work' ? '工作中' : '休息中'

  return {
    callId: '',
    ok: true,
    content:
      `🍅 番茄钟状态\n\n` +
      `阶段: ${phaseText}\n` +
      `剩余: ${remainMin} 分 ${remainSec} 秒\n` +
      `（总时长 ${Math.round(state.totalMs / 60000)} 分钟）`,
  }
}

// ── 工具 3: 停止番茄钟 ──────────────────────────────────

export const pomodoroStopDef: ToolDef = {
  name: 'pomodoro_stop',
  description: `停止当前番茄钟。`,
  params: {},
  toolsets: ['agent'],
}

export async function pomodoroStop(): Promise<ToolResult> {
  if (!state.running) {
    return { callId: '', ok: true, content: '🍅 当前没有运行中的番茄钟。' }
  }

  clearTimer()
  state.running = false
  state.phase = 'work'
  notify('🍅 番茄钟已停止', '本次专注结束。')

  return { callId: '', ok: true, content: '🍅 番茄钟已停止。用 pomodoro_start 重新开始。' }
}
