// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// components/DecisionCard.tsx — 决策卡片（问用户「走哪条路」）
//
// 对应 agent 的 `ask_decision` 工具。与审批弹窗的区别：
//   审批 = 危险操作闸门，二值，阻塞执行
//   本卡片 = 协作分叉点，N 选项 + 自由输入，**不阻塞**（超时走推荐项）
//
// 视觉上刻意做成「对话中的一张卡」而不是系统弹窗：
// 决策是协作的一部分，弹窗会打断对话流、让人脱离上下文。
// ════════════════════════════════════════════════════════════

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { isImeComposing } from '../lib/ime'

// ═══════════════════════════════════════════════════════════
// 类型（与主进程 decisionService 保持一致）
// ═══════════════════════════════════════════════════════════

export interface DecisionOption {
  id: string
  label: string
  description?: string
  recommended?: boolean
}

export interface DecisionRequest {
  id: string
  askedBy: 'lumina' | 'yak' | 'recha'
  question: string
  context?: string
  options: DecisionOption[]
  multiSelect: boolean
  allowCustomAnswer: boolean
  customPlaceholder?: string
  timeoutMs: number
  createdAt: number
  status: 'pending' | 'answered' | 'timeout' | 'cancelled'
}

const OWNER_META: Record<string, { name: string; emoji: string }> = {
  lumina: { name: 'Lumina', emoji: '🐱' },
  yak: { name: 'Yak', emoji: '💻' },
  recha: { name: '热茶', emoji: '🍵' },
}

/** 全局样式键名前缀，避免与项目其它 css 变量打架 */
const CSS = {
  root: 'decision-card',
  option: 'decision-card-option',
  optionSelected: 'decision-card-option--selected',
  custom: 'decision-card-custom',
  actions: 'decision-card-actions',
}

// ═══════════════════════════════════════════════════════════
// 组件
// ═══════════════════════════════════════════════════════════

interface Props {
  request: DecisionRequest
  onSubmit: (id: string, selectedIds: string[], customText?: string) => void
  onCancel: (id: string) => void
  /** 紧凑模式：嵌在小面板里时用 */
  compact?: boolean
}

export default function DecisionCard({ request, onSubmit, onCancel, compact }: Props) {
  const [selected, setSelected] = useState<string[]>(() => {
    // 默认预选推荐项 —— 用户点「提交」即可，不用逐个点选
    const rec = request.options.find(o => o.recommended)
    return rec ? [rec.id] : []
  })
  const [customText, setCustomText] = useState('')
  const [remaining, setRemaining] = useState(() => Math.ceil(request.timeoutMs / 1000))
  const [collapsed, setCollapsed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 倒计时：让用户知道「不回答会自动继续」，而不是干等
  useEffect(() => {
    const tick = () => {
      const left = Math.ceil((request.timeoutMs - (Date.now() - request.createdAt)) / 1000)
      setRemaining(Math.max(0, left))
      if (left <= 0 && timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    tick()
    timerRef.current = setInterval(tick, 1000)
    return () => { if (timerRef.current) {clearInterval(timerRef.current)} }
  }, [request.id, request.timeoutMs, request.createdAt])

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      if (request.multiSelect) {
        return prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      }
      // 单选：点已选的取消选择，允许「都不选只填自定义」
      return prev.includes(id) ? [] : [id]
    })
  }, [request.multiSelect])

  const canSubmit = selected.length > 0 || customText.trim().length > 0

  const handleSubmit = useCallback(() => {
    if (!canSubmit) {return}
    onSubmit(request.id, selected, customText.trim() || undefined)
  }, [canSubmit, onSubmit, request.id, selected, customText])

  // 自定义输入框：Enter 提交、Shift+Enter 换行
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法选词回车 ≠ 提交
    if (isImeComposing(e)) {return}
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  const meta = OWNER_META[request.askedBy] || OWNER_META.lumina
  const minutes = Math.floor(remaining / 60)
  const seconds = remaining % 60
  const timeLabel = minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`

  return (
    <div className={CSS.root} data-decision-id={request.id} data-testid="decision-card">
      {/* 头部：谁在问 + 倒计时 */}
      <div className="decision-card-head">
        <div className="decision-card-head-left">
          <span className="decision-card-owner" aria-hidden>{meta.emoji}</span>
          <span className="decision-card-question">{request.question}</span>
        </div>
        <div className="decision-card-head-right">
          {remaining > 0 && (
            <span
              className="decision-card-timer"
              title={`不选择将在 ${timeLabel} 后自动按推荐项继续`}
            >
              {timeLabel}
            </span>
          )}
          <button
            className="decision-card-close"
            onClick={() => onCancel(request.id)}
            title="跳过，按推荐项继续"
            aria-label="跳过此决策"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 背景说明（可折叠，避免长文本占满卡片） */}
      {request.context && (
        <div
          className="decision-card-context"
          onClick={() => setCollapsed(c => !c)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') {setCollapsed(c => !c)} }}
        >
          <span className={`decision-card-context-text${collapsed ? ' is-collapsed' : ''}`}>
            {request.context}
          </span>
          {request.context.length > 60 && (
            <span className="decision-card-context-toggle">{collapsed ? '展开' : '收起'}</span>
          )}
        </div>
      )}

      {/* 选项 */}
      <div className="decision-card-options" role={request.multiSelect ? 'group' : 'radiogroup'}>
        {request.options.map((opt, i) => {
          const isSelected = selected.includes(opt.id)
          return (
            <button
              key={opt.id}
              type="button"
              role={request.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={isSelected}
              className={`${CSS.option} ${isSelected ? CSS.optionSelected : ''}`}
              onClick={() => toggle(opt.id)}
            >
              <span className="decision-card-index">{i + 1}</span>
              <span className="decision-card-option-body">
                <span className="decision-card-option-label">
                  {opt.label}
                  {opt.recommended && (
                    <span className="decision-card-badge">推荐</span>
                  )}
                </span>
                {opt.description && !compact && (
                  <span className="decision-card-option-desc">{opt.description}</span>
                )}
              </span>
              <span className="decision-card-check" aria-hidden>
                {isSelected ? '✓' : ''}
              </span>
            </button>
          )
        })}
      </div>

      {/* 自由输入 —— 用户可以不选任何选项，直接说自己的想法 */}
      {request.allowCustomAnswer && (
        <div className={CSS.custom}>
          <textarea
            className="decision-card-input"
            value={customText}
            onChange={e => setCustomText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={request.customPlaceholder || '补充你的想法，或输入其他答案'}
            rows={2}
            aria-label="自定义回答"
          />
        </div>
      )}

      {/* 操作区 */}
      <div className={CSS.actions}>
        <span className="decision-card-hint">
          {request.multiSelect ? '可多选' : '单选'} · 回车提交 · 不会回答将按推荐项继续
        </span>
        <button
          className="decision-card-submit"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          确定
        </button>
      </div>
    </div>
  )
}
