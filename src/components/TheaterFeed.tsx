// ============================================================
// components/TheaterFeed.tsx — 团队可见性剧场 UI（创新功能 2）
//
// 把主进程 theater.ts 产生的事件流渲染成「一场正在上演的戏」。
// 与依赖泳道画布的常见多 Agent 视图的根本区别：
//   画布回答「谁在等谁」，剧场回答「刚才发生了什么」。
//
// 三个设计决定：
//   1. **情绪用颜色说话**——7 档 EmotionBeat 各有固定色，
//      不用 emoji 堆砌。用户扫一眼就知道团队现在是什么氛围。
//   2. **实时滚动**——新一幕到达时自动滚到底，但用户手动上滑后
//      停止自动跟随（否则会一直把人从正在读的内容里拽走）。
//   3. **可折叠**——默认折叠成一条状态条。这是观赏层，
//      绝不能抢占对话区的主导权。
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TheaterBeat, TheaterState, EmotionBeat, TheaterRole } from '../../electron/orchestration/theater'

// ── 情绪配色 ──────────────────────────────────────────────
// 色相按「从平静到激动再到负面」排列，负面统一偏红、正面偏绿，
// 让人不读文字也能大致判断局势。
const EMOTION_STYLE: Record<EmotionBeat, { label: string; color: string; bg: string; icon: string }> = {
  calm:      { label: '平静',  color: '#8b93a7', bg: 'rgba(139,147,167,0.12)', icon: '\u{1F610}' },
  confident: { label: '有把握', color: '#3fb950', bg: 'rgba(63,185,80,0.14)',  icon: '\u{1F4AA}' },
  focused:   { label: '专注',  color: '#58a6ff', bg: 'rgba(88,166,255,0.14)', icon: '\u{1F3AF}' },
  anxious:   { label: '焦虑',  color: '#d29922', bg: 'rgba(210,153,34,0.16)', icon: '\u{1F630}' },
  weary:     { label: '疲惫',  color: '#8b949e', bg: 'rgba(139,148,158,0.14)', icon: '\u{1F634}' },
  pleased:   { label: '开心',  color: '#56d364', bg: 'rgba(86,211,100,0.14)', icon: '\u{1F60A}' },
  upset:     { label: '不爽',  color: '#f85149', bg: 'rgba(248,81,73,0.14)',  icon: '\u{1F621}' },
}

const KIND_META: Record<TheaterBeat['kind'], { label: string; mark: string }> = {
  scene_open:   { label: '开场', mark: '\u{1F3AC}' },
  delegate:     { label: '派活', mark: '\u{1F4E4}' },
  worker_start: { label: '开工', mark: '\u{1F6E0}' },
  speech:       { label: '发言', mark: '\u{1F4AC}' },
  review:       { label: '审查', mark: '\u{1F50D}' },
  revision:     { label: '返工', mark: '\u{1F504}' },
  worker_done:  { label: '收工', mark: '\u{2705}' },
  scene_close:  { label: '收场', mark: '\u{1F3C1}' },
  incident:     { label: '意外', mark: '\u{26A0}' },
}

const ROLE_COLOR: Record<TheaterRole, string> = {
  lumina: '#ff7bac',
  yak: '#58a6ff',
  recha: '#d29922',
  intern: '#a371f7',
  system: '#8b949e',
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) {return `${Math.max(0, Math.round(ms))}ms`}
  const s = ms / 1000
  if (s < 60) {return `${s.toFixed(1)}s`}
  const m = Math.floor(s / 60)
  return `${m}分${Math.round(s % 60)}秒`
}

interface Props {
  /** 主进程推来的最新剧目状态；null = 没有戏在演 */
  play: TheaterState | null
  /** 单幕增量事件（用于实时滚动动画） */
  lastBeat?: TheaterBeat | null
  onClose?: () => void
}

export default function TheaterFeed({ play, lastBeat, onClose }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [follow, setFollow] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const beatCount = play?.beats.length ?? 0

  // 实时跟随：只在用户没手动上滑时滚到底
  useEffect(() => {
    if (!follow || !expanded) {return}
    const el = listRef.current
    if (el) {el.scrollTop = el.scrollHeight}
  }, [beatCount, follow, expanded])

  const onScroll = useCallback(() => {
    const el = listRef.current
    if (!el) {return}
    // 距底部 < 24px 才算「在底部」，否则取消跟随
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setFollow(atBottom)
  }, [])

  const stats = useMemo(() => {
    if (!play) {return null}
    const last = play.beats[play.beats.length - 1]
    const startedAt = play.openedAt
    return { elapsed: (last?.at ?? Date.now()) - startedAt, actors: new Set(play.beats.map(b => b.role)).size }
  }, [play])

  if (!play || play.beats.length === 0) {return null}

  // ── 折叠态：一条状态条 ──────────────────────────────
  if (!expanded) {
    const lastBeatOfPlay = play.beats[play.beats.length - 1]
    const emo = EMOTION_STYLE[lastBeatOfPlay?.emotion ?? 'calm']
    return (
      <div className="theater-feed theater-collapsed" role="status">
        <button className="theater-toggle" onClick={() => setExpanded(true)} aria-expanded="false">
          <span className="theater-dot" style={{ background: emo.color }} />
          <span className="theater-title">{play.title}</span>
          <span className="theater-meta">
            {stats?.actors} 位在台 · {beatCount} 幕
            {stats ? ` · ${fmtElapsed(stats.elapsed)}` : ''}
          </span>
        </button>
        <span className="theater-peek" style={{ color: emo.color }}>
          {emo.icon} {lastBeatOfPlay?.actor}：{lastBeatOfPlay?.text.slice(0, 24)}
          {lastBeatOfPlay && lastBeatOfPlay.text.length > 24 ? '…' : ''}
        </span>
      </div>
    )
  }

  // ── 展开态：时间轴 ─────────────────────────────────
  return (
    <div className="theater-feed theater-expanded" role="log" aria-live="polite">
      <div className="theater-header">
        <span className="theater-dot" style={{ background: play.closed ? '#8b949e' : '#58a6ff' }} />
        <strong className="theater-title">{play.title}</strong>
        <span className="theater-meta">
          {stats?.actors} 位在台 · {beatCount} 幕
          {stats ? ` · ${fmtElapsed(stats.elapsed)}` : ''}
          {play.closed ? ' · 已收场' : ' · 进行中'}
        </span>
        <div className="theater-actions">
          <button className="theater-btn" onClick={() => { setFollow(f => !f); if (!follow) { const el = listRef.current; if (el) {el.scrollTop = el.scrollHeight} } }}>
            {follow ? '跟随中' : '已暂停跟随'}
          </button>
          <button className="theater-btn" onClick={() => setExpanded(false)}>收起</button>
          {onClose && <button className="theater-btn" onClick={onClose}>结束本场</button>}
        </div>
      </div>

      <div className="theater-timeline" ref={listRef} onScroll={onScroll}>
        {play.beats.map((b) => {
          const emo = EMOTION_STYLE[b.emotion] ?? EMOTION_STYLE.calm
          const kind = KIND_META[b.kind] ?? KIND_META.speech
          const isNew = lastBeat?.seq === b.seq
          return (
            <div
              key={b.seq}
              className={`theater-beat${isNew ? ' is-new' : ''}${b.kind === 'incident' ? ' is-incident' : ''}`}
              style={{ borderLeftColor: ROLE_COLOR[b.role] || '#8b949e' }}
            >
              <div className="theater-beat-head">
                <span className="theater-kind" title={kind.label}>{kind.mark}</span>
                <span className="theater-actor" style={{ color: ROLE_COLOR[b.role] }}>{b.actor}</span>
                <span className="theater-emotion" style={{ color: emo.color, background: emo.bg }}>
                  {emo.icon} {emo.label}
                </span>
                {b.detail && <span className="theater-detail">{b.detail}</span>}
              </div>
              <div className="theater-text">{b.text}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
