// ============================================================
// orchestration/theaterBridge.ts — 剧场事件桥接（创新功能 2 的接线层）
//
// 【为什么单独一个文件】
// theater.ts 是纯函数状态机，不认 Electron；
// 但真实的委派流程在 delegationManager 里，需要一个地方把
// 「此刻是谁在做什么、情绪如何」喂进状态机，并转发给渲染进程。
//
// 职责边界（刻意做得很薄）：
//   1. 维护当前剧目（谁在演、什么时候开场）
//   2. 把 mood 字符串桥接成 emotionCore 的三维表示
//   3. 广播事件给渲染进程
//
// **任何一步失败都不能影响委派主流程**——剧场是观赏层，
// 它崩了用户照常用 Agent。所以每个出口都吞异常。
// ============================================================

import { app, BrowserWindow } from 'electron'
import {
  openPlay, addBeat, summarizePlay, renderScript, pickHighlight,
  type TheaterState, type TheaterEvent, type TheaterRole, type TheaterBeat,
} from './theater'
import { MOOD_COORDS, type MoodLabel } from '../pet/life/emotionCore'

// ═══════════════════════════════════════════════════════════
// mood 字符串 → 三维情绪
// ═══════════════════════════════════════════════════

/**
 * socialEngine 用的 mood 字符串 → emotionCore 统一核心的坐标。
 *
 * 只映射 socialEngine 实际在用的取值域；未命中一律按「平静」处理，
 * **不猜**——猜出来的情绪会被渲染成一条假的情节，比没有更糟。
 */
const MOOD_TO_LABEL: Record<string, MoodLabel> = {
  neutral: '平静 😐',
  happy: '开心 😊',
  excited: '兴奋 🤩',
  sad: '低落 😔',
  angry: '闷闷不乐 😕',
  tired: '疲惫 😩',
  lonely: '闷闷不乐 😕',
  shy: '幸福 💖',
  excited_happy: '超开心 🎉',
}

/**
 * 把 socialEngine 的 mood 字符串转成 theater 需要的「三维情绪」。
 *
 * 走 MOOD_COORDS 的权威坐标 → 再反推三维，
 * 而不是另建一张映射表——避免第三套情绪表示各自漂移
 * （这个项目已经因为「三套情绪表示」吃过亏，见 emotionCore 文件头）。
 */
export function moodToThree(mood: string | null | undefined): {
  mood: number; energy: number; affinity: number; label?: MoodLabel
} | null {
  if (!mood) {return null}
  const label = MOOD_TO_LABEL[mood]
  if (!label) {return null}   // 未知 mood → 诚实地说不知道
  const { v, a } = MOOD_COORDS[label]
  return {
    mood: v,                       // valence 直接就是效价
    energy: a,                     // arousal 就是唤醒度
    affinity: 0.5,                 // 亲密度不由 mood 决定，此处中性
    label,
  }
}

// ═══════════════════════════════════════════════════════════
// 剧目状态
// ═══════════════════════════════════════════════════════════

let _play: TheaterState | null = null
let _playCounter = 0

/**
 * 读取功能开关（缓存 1.5s）。
 *
 * 【为什么要缓存而不是每次读盘】
 * emitTheaterBeat 每次委派至少调 3 次，每次都 readFileSync 会变成明显开销。
 * 1.5s 的缓存窗口对人眼不可感知，但能消除绝大部分磁盘 IO。
 * 代价是开关改动最多延迟 1.5 秒生效——对设置项来说完全可以接受。
 */
let _featureCache: { at: number; theater: boolean } | null = null
const FEATURE_CACHE_MS = 1500

function readFeatureFlags(): { theater: boolean } {
  const now = Date.now()
  if (_featureCache && now - _featureCache.at < FEATURE_CACHE_MS) {
    return { theater: _featureCache.theater }
  }
  let theater = true   // 默认开
  try {
    // 延迟 require：避免与 agentConfig 形成加载期循环依赖
    const { getConfig } = require('./agentConfig')
    const cfg: any = getConfig()
    const v = cfg?.features?.theater
    // 键缺失 = 默认开；只有显式 false 才关
    theater = v !== false
  } catch { /* 读不到就用默认 */ }
  _featureCache = { at: now, theater }
  return { theater }
}

/** 开一场新戏（同一时刻只演一场——多剧目同屏会让用户失去叙事焦点） */
export function startPlay(title: string): TheaterState {
  _playCounter++
  const id = `play_${_playCounter}_${Date.now().toString(36)}`
  _play = openPlay(title.slice(0, 60), id)
  broadcast('theater:state', _play)
  return _play
}

export function getPlay(): TheaterState | null {return _play}

export function closePlay(): void {
  if (!_play) {return}
  _play = { ..._play, closed: true }
  broadcast('theater:state', _play)
}

/**
 * 投递一幕。没开场就自动开一场——真实流程里不该要求调用方先 startPlay，
 * 否则一漏掉就是「什么都没发生」，比不剧场更糟。
 */
export function emitTheaterBeat(ev: TheaterEvent): TheaterBeat | null {
  try {
    // 🔇 开关关闭时静默跳过：用户明确不要看过程，就不该有任何开销
    if (!readFeatureFlags().theater) {return null}
    if (!_play) {
      startPlay(ev.kind === 'scene_open' ? '一段日常' : '一次协作')
    }
    if (!_play) {return null}
    const r = addBeat(_play, ev)
    _play = r.state
    broadcast('theater:beat', r.beat)
    broadcast('theater:state', _play)
    return r.beat
  } catch (e) {
    console.warn('[theaterBridge] 投递失败（不影响主流程）:', (e as Error)?.message)
    return null
  }
}

/** 当前角色情绪（供 delegationManager 传入） */
export function getCurrentEmotion3D(): { mood: number; energy: number; affinity: number } | null {
  try {
    // 延迟 require 避免与 luckyModeIntegration 形成加载期循环依赖
    const { getCurrentMood } = require('../luckyModeIntegration')
    return moodToThree(getCurrentMood())
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════
// 广播
// ═══════════════════════════════════════════════════════════

function broadcast(channel: string, payload: unknown): void {
  try {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  } catch { /* 窗口已关或未就绪 */ }
}

// ═══════════════════════════════════════════════════════════
// 对外查询（给工具层 / IPC 用）
// ═══════════════════════════════════════════════════════════

export function theaterScript(): string {
  return _play ? renderScript(_play) : ''
}

export function theaterHighlight(): string | null {
  return _play ? pickHighlight(_play) : null
}

export function theaterSummary(): ReturnType<typeof summarizePlay> | null {
  return _play ? summarizePlay(_play) : null
}

/** 重置（测试 / 换剧用） */
export function _resetTheater(): void {
  _play = null
  _playCounter = 0
  _featureCache = null
}
