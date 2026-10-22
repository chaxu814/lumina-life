// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/life/lipsync.ts — 👄 五元音口型同步 (v0.2)
//
// Mao 提供 A/I/U/E/O 五元音参数（比单一张嘴更细腻）。口型数据有两个来源：
//   1) 高精度：TTS 返回音素/词边界（gpt-sovits / indextts 可提供）→ 直接喂 viseme；
//   2) 无音素时的优雅降级（本模块）：
//      - 拉丁字母按元音映射；中文覆盖高频语气/象声词（啊/咦/呜/哦/喵…），
//        其余汉字按「说话默认张嘴」处理（中文字形不含发音，精确口型必须靠 TTS 音素）；
//      - 音频实时能量(RMS)决定张合度，标点产生停顿。
// 纯 TS、零依赖，可单测；渲染层每帧用 sampleViseme 取当前口型。
// ============================================================

import type { Viseme } from './faceRig'

export interface VisemeSeg {
  viseme: Viseme
  start: number
  end: number
  /** 该段口型饱满度 0~1 */
  open: number
}

export interface LipsyncOptions {
  /** 每个字符/音节基准时长 ms */
  charMs?: number
  /** 逗号/顿号停顿 ms */
  shortPauseMs?: number
  /** 句号/问号/叹号停顿 ms */
  longPauseMs?: number
}

// 中文高频语气/象声词 → 五元音（猫娘台词里最常见的口型）
const CN_VOWEL: Record<string, Viseme> = {
  啊: 'A', 呀: 'A', 哇: 'A', 哈: 'A', 啦: 'A', 嘛: 'A', 吧: 'A', 吗: 'A', 哪: 'A', 嘎: 'A', 吖: 'A', 哒: 'A',
  咦: 'I', 嘻: 'I', 咿: 'I', 咪: 'I', 希: 'I',
  呜: 'U', 呼: 'U', 咕: 'U', 噜: 'U', 噗: 'U', 唔: 'U', 乌: 'U',
  诶: 'E', 嘿: 'E', 欸: 'E',
  哦: 'O', 噢: 'O', 喔: 'O', 啵: 'O', 咯: 'O',
}
// 需要拆成两拍的特殊词
const CN_DIPHTHONG: Record<string, Viseme[]> = {
  喵: ['I', 'A'],
}
const LATIN_VOWEL: Record<string, Viseme> = {
  a: 'A', e: 'E', i: 'I', o: 'O', u: 'U', y: 'I',
  ä: 'E', ö: 'O', ü: 'U',
}
const SHORT_PAUSE = new Set(['，', '、', ',', '；', ';'])
const LONG_PAUSE = new Set(['。', '.', '！', '!', '？', '?', '…', '\n'])

type Token = { kind: 'viseme'; viseme: Viseme; dur: number } | { kind: 'pause'; dur: number } | { kind: 'close'; dur: number }

function tokenize(text: string, charMs: number, shortPauseMs: number, longPauseMs: number): Token[] {
  const tokens: Token[] = []
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (LONG_PAUSE.has(ch)) { tokens.push({ kind: 'pause', dur: longPauseMs }); continue }
    if (SHORT_PAUSE.has(ch)) { tokens.push({ kind: 'pause', dur: shortPauseMs }); continue }
    if (/\s/.test(ch)) { tokens.push({ kind: 'pause', dur: charMs * 0.4 }); continue }

    if (CN_DIPHTHONG[ch]) {
      for (const v of CN_DIPHTHONG[ch]) {tokens.push({ kind: 'viseme', viseme: v, dur: charMs * 0.7 })}
      continue
    }
    if (CN_VOWEL[ch]) { tokens.push({ kind: 'viseme', viseme: CN_VOWEL[ch], dur: charMs }); continue }

    const lower = ch.toLowerCase()
    if (LATIN_VOWEL[lower]) { tokens.push({ kind: 'viseme', viseme: LATIN_VOWEL[lower], dur: charMs }); continue }
    if (/[a-z]/.test(lower)) { tokens.push({ kind: 'close', dur: charMs * 0.55 }); continue }

    // 未收录汉字：说话默认轻张嘴（降级），保证嘴部随语音活动
    if (/[\u4e00-\u9fff]/.test(ch)) { tokens.push({ kind: 'viseme', viseme: 'A', dur: charMs * 0.8 }); continue }
    // 其它符号忽略
  }
  return tokens
}

/** 文本 → 五元音时间段（ms 时间轴） */
export function textToVisemeSegments(text: string, opts: LipsyncOptions = {}): VisemeSeg[] {
  const charMs = opts.charMs ?? 120
  const shortPauseMs = opts.shortPauseMs ?? 170
  const longPauseMs = opts.longPauseMs ?? 320
  const tokens = tokenize(text ?? '', charMs, shortPauseMs, longPauseMs)
  const segs: VisemeSeg[] = []
  let t = 0
  for (const tok of tokens) {
    if (tok.kind === 'pause') { segs.push({ viseme: 'rest', start: t, end: t + tok.dur, open: 0 }); t += tok.dur }
    else if (tok.kind === 'close') { segs.push({ viseme: 'rest', start: t, end: t + tok.dur, open: 0 }); t += tok.dur }
    else {
      // 元音前后留极短闭合，形成自然张合
      const lead = charMs * 0.12
      segs.push({ viseme: 'rest', start: t, end: t + lead, open: 0 })
      t += lead
      segs.push({ viseme: tok.viseme, start: t, end: t + tok.dur, open: 1 })
      t += tok.dur
    }
  }
  return segs
}

/** 按时间采样当前口型；超出轨道末尾返回 rest */
export function sampleViseme(segs: VisemeSeg[], atMs: number): { viseme: Viseme; open: number } {
  for (const s of segs) {
    if (atMs >= s.start && atMs < s.end) {return { viseme: s.viseme, open: s.open }}
  }
  return { viseme: 'rest', open: 0 }
}

/**
 * 音频 RMS 电平(0~1) → 嘴张度。带最小/最大钳制与平滑系数，
 * 供没有音素时间轴、只有实时电平时驱动（与 bargeIn 共用同一电平表）。
 */
export function opennessFromRms(level: number, prev = 0, opts?: { min?: number; max?: number; attack?: number; release?: number }): number {
  const min = opts?.min ?? 0.05
  const max = opts?.max ?? 1
  const attack = opts?.attack ?? 0.55   // 张嘴快
  const release = opts?.release ?? 0.28 // 闭嘴慢
  const target = Math.max(min, Math.min(max, level)) * (level > 0.02 ? 1 : 0)
  const k = target > prev ? attack : release
  return prev + (target - prev) * k
}
