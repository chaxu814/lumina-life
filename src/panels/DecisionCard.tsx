// ============================================================
// panels/DecisionCard.tsx — 决策三栏卡片 (DecisionDebateCard, v1.0)
//
// 与 components/DecisionCard.tsx 的区别：
//   components/DecisionCard = ask_user 工具的「问用户选哪个」投票卡（已有，勿动）
//   本组件                  = 一次 /decide 辩论结果的呈现卡（新功能）
//
// 铁则（AGENTS.md）：
//   · 用户永远只跟 Lumina 说话。本卡整体以 Lumina 的口吻呈现，
//     后台两位只展示「执行者 / 审查员」两个职能视角，不暴露名字、
//     也不提供跟他们直接对话的入口。
//   · 组件是纯渲染：只接结构化 props，不自己发请求。
// ============================================================

import React, { useEffect, useRef } from 'react'

// ── 与 electron/decision/decisionDebate.ts 的 DecisionDebateResult 同构 ──
// 渲染层不 import main 进程代码，这里按结构自声明一份 props 类型。

export interface DebateColumnProps {
  title: string
  body: string
  status: 'ok' | 'missing' | 'degraded'
}

export interface DecisionDebateResultProps {
  question: string
  options: string[]
  columns: {
    yak: DebateColumnProps
    recha: DebateColumnProps
  }
  lumina: {
    summary: string
    recommendation: string
    status: 'ok' | 'template'
    source: 'llm' | 'template'
  }
  meta?: {
    durationMs: number
    degradedReasons: string[]
  }
}

// ── scoped 样式（自注入，不动全局样式表） ──────────────────

const CSS_ID = 'decision-debate-card-style'

function useInjectStyles(): void {
  useEffect(() => {
    if (document.getElementById(CSS_ID)) return
    const style = document.createElement('style')
    style.id = CSS_ID
    style.textContent = `
.dd-card {
  margin: 10px 0;
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(120,140,255,0.08), rgba(120,140,255,0.02));
  border: 1px solid rgba(120,140,255,0.25);
  padding: 14px 16px;
  font-size: 13px;
  line-height: 1.6;
  color: inherit;
}
.dd-card-head { margin-bottom: 10px; }
.dd-card-eyebrow { font-size: 11px; opacity: 0.6; letter-spacing: 0.08em; }
.dd-card-question { font-weight: 600; margin-top: 2px; }
.dd-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 560px) { .dd-columns { grid-template-columns: 1fr; } }
.dd-col {
  border-radius: 10px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  padding: 10px 12px;
}
.dd-col-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.dd-col-title { font-weight: 600; font-size: 12.5px; }
.dd-badge {
  font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
  background: rgba(255,180,80,0.15); color: #ffb450;
}
.dd-badge--missing { background: rgba(150,150,150,0.15); color: #999; }
.dd-badge--degraded { background: rgba(255,120,120,0.15); color: #ff8a8a; }
.dd-body { white-space: pre-wrap; opacity: 0.9; font-size: 12.5px; }
.dd-col--missing .dd-body { opacity: 0.55; }
.dd-verdict {
  margin-top: 10px;
  border-radius: 10px;
  padding: 12px 14px;
  background: rgba(130,110,255,0.14);
  border: 1px solid rgba(150,130,255,0.4);
  border-left: 3px solid #9a86ff;
}
.dd-verdict-label { font-size: 11px; opacity: 0.65; letter-spacing: 0.06em; }
.dd-verdict-rec { font-weight: 600; margin-top: 4px; }
.dd-template-note { font-size: 11px; opacity: 0.55; margin-top: 6px; }
.dd-meta { font-size: 10.5px; opacity: 0.45; margin-top: 8px; text-align: right; }
`
    document.head.appendChild(style)
  }, [])
}

// ── 子块 ───────────────────────────────────────────────────

function Badge({ status }: { status: 'ok' | 'missing' | 'degraded' }) {
  if (status === 'ok') return null
  const text = status === 'missing' ? '未响应' : '内容不完整'
  return <span className={`dd-badge ${status === 'missing' ? 'dd-badge--missing' : 'dd-badge--degraded'}`}>{text}</span>
}

function Column({ title, body, status, roleTag }: DebateColumnProps & { roleTag: string }) {
  return (
    <div className={`dd-col ${status === 'missing' ? 'dd-col--missing' : ''}`}>
      <div className="dd-col-head">
        <span className="dd-col-title">{title} · {roleTag}</span>
        <Badge status={status} />
      </div>
      <div className="dd-body">{body || '（这一栏这次没说上话）'}</div>
    </div>
  )
}

// ── 组件本体 ──────────────────────────────────────────────

export interface DecisionDebateCardProps {
  result: DecisionDebateResultProps
}

/**
 * 决策三栏卡片：渲染一次 /decide 的结构化辩论结果。
 * 纯展示组件，不发任何请求。
 */
export default function DecisionDebateCard({ result }: DecisionDebateCardProps) {
  useInjectStyles()
  const rootRef = useRef<HTMLDivElement>(null)

  return (
    <div className="dd-card" ref={rootRef}>
      <div className="dd-card-head">
        <div className="dd-card-eyebrow">Lumina 帮你把这个问题议了一遍</div>
        <div className="dd-card-question">{result.question}</div>
      </div>

      <div className="dd-columns">
        <Column
          title={result.columns.yak.title}
          body={result.columns.yak.body}
          status={result.columns.yak.status}
          roleTag="执行者视角"
        />
        <Column
          title={result.columns.recha.title}
          body={result.columns.recha.body}
          status={result.columns.recha.status}
          roleTag="审查员视角"
        />
      </div>

      <div className="dd-verdict">
        <div className="dd-verdict-label">我的看法</div>
        <div className="dd-body">{result.lumina.summary}</div>
        <div className="dd-verdict-rec">{result.lumina.recommendation}</div>
        {result.lumina.source === 'template' && (
          <div className="dd-template-note">（来源: template · 本次是经验兜底建议，不是现场分析）</div>
        )}
      </div>

      {result.meta && (
        <div className="dd-meta">
          {((result.meta.durationMs / 1000).toFixed(1))}s
          {result.meta.degradedReasons.length > 0 && ` · ${result.meta.degradedReasons.length} 项降级`}
        </div>
      )}
    </div>
  )
}
