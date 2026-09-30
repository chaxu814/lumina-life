// ============================================================
// components/ThinkingStepList.tsx — 思考过程步骤列表（单聊 / 群聊共用）
//
// 为什么抽成组件：ChatPanel 和 GroupChatView 之前各写了一份，
// 样式漂移 + 都有同一个视觉毛病——
//   1) 左边已经有按 type 画的图标列，label 里又带着 "🔨 / ✅ / 💭" 前缀，
//      等于同一个图标画两遍，行首参差不齐；
//   2) 主标题、[工具名]、耗时 全挤在一个 inline span 里混排，基线对不齐；
//   3) result 直接整段平铺，没有缩进，长文本糊住整块。
// 这里统一成"图标列 + 标题行 + [tool] 标签 + 耗时 + 缩进详情"的固定栅格，
// 所有文字左边线严格对齐。
// ============================================================

import React, { useMemo } from 'react'
import type { ThinkingStep } from '../chat/chatShared'

/** 按步骤类型决定图标；label 自带的前缀 emoji 在这里剥掉，避免重复 */
function stepIcon(type: ThinkingStep['type']): string {
  switch (type) {
    case 'tool_start': return '🔧'
    case 'tool_end': return '✅'
    case 'tool_error': return '❌'
    case 'text': return '📝'
    default: return '💭'
  }
}

/** 剥掉 label 开头的 emoji / 符号前缀（🔨 ✅ ❌ 💭 🧠 📝 等） */
function stripEmoji(label: string): string {
  return label
    .replace(/^[\s]+/, '')
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}️⃣✔️✖️⚙️🔨-]+\s*/u, '')
    .trim()
}

/**
 * 把 ChatPanel 的 lastAgentEvents 归一成 ThinkingStep。
 *
 * 那是个混合数组：既有 AgentEvent（type/text/tool/args/result），
 * 又有 ThinkingStep（type/label/...）。两边字段名不一样，
 * 之前是两套渲染逻辑各画各的，视觉自然对不齐。
 */
export function normalizeThinkingStep(
  raw: any,
  idx = 0,
): ThinkingStep {
  const type: ThinkingStep['type'] =
    raw?.type === 'tool_start' ? 'tool_start'
    : raw?.type === 'tool_end' ? 'tool_end'
    : raw?.type === 'tool_error' ? 'tool_error'
    : raw?.type === 'text' || raw?.type === 'text_stream' ? 'text'
    : 'thinking'

  // label 可能不存在（AgentEvent 只有 text）
  const label: string =
    raw?.label ||
    raw?.text ||
    (type === 'tool_start' ? `执行 ${raw?.tool || '工具'}` : raw?.tool || '') ||
    '思考中…'

  const resultText =
    raw?.result != null
      ? typeof raw.result === 'string'
        ? raw.result
        : (raw.result?.content ?? raw.result?.error ?? JSON.stringify(raw.result))
      : undefined

  return {
    id: raw?.id || `tsl-${raw?.timestamp ?? Date.now()}-${idx}`,
    type,
    label,
    tool: raw?.tool,
    args: typeof raw?.args === 'string' ? raw.args : summarizeShort(raw?.args),
    result: resultText ? String(resultText).slice(0, 800) : undefined,
    durationMs: raw?.durationMs ?? raw?.result?._durationMs,
    timestamp: raw?.timestamp ?? Date.now(),
  }
}

function summarizeShort(args: unknown, max = 120): string | undefined {
  if (args == null) return undefined
  let s: string
  try { s = typeof args === 'string' ? args : JSON.stringify(args) } catch { s = String(args) }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : s.slice(0, max) + '…'
}

interface Props {
  steps: ThinkingStep[]
  /** 折叠态容器是否已展开（用于错峰入场动画） */
  animate?: boolean
}

const ThinkingStepList: React.FC<Props> = ({ steps, animate = true }) => {
  const rows = useMemo(
    () => steps.map((s, i) => ({
      step: s,
      icon: stepIcon(s.type),
      title: stripEmoji(s.label) || s.label,
      // 错峰入场最多铺前 8 步，再多就一起进，避免长列表末尾干等
      i: Math.min(i, 8),
    })),
    [steps],
  )

  return (
    <div className="tsl-list">
      {rows.map(({ step, icon, title, i }) => {
        const isError = step.type === 'tool_error'
        const isDone = step.type === 'tool_end'
        const hasDetail = !!(step.result || step.args)
        return (
          <div
            key={step.id || `${step.timestamp}-${i}`}
            className={[
              'tsl-row',
              isDone ? 'is-done' : '',
              isError ? 'is-error' : '',
              animate ? 'tsl-animate' : '',
            ].filter(Boolean).join(' ')}
            style={animate ? ({ ['--i' as any]: i }) : undefined}
          >
            <span className="tsl-icon" aria-hidden>{icon}</span>

            <div className="tsl-body">
              <div className="tsl-title-row">
                <span className="tsl-title">{title}</span>
                {step.tool && <span className="tsl-tag">[{step.tool}]</span>}
                {step.durationMs != null && (
                  <span className="tsl-duration">{(step.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>

              {step.args && (
                <div className="tsl-sub tsl-sub-args">
                  <span className="tsl-sub-key">入参</span>
                  <span className="tsl-sub-text">{step.args}</span>
                </div>
              )}
              {step.result && (
                <div className="tsl-sub tsl-sub-result">
                  <span className="tsl-sub-text">{step.result}</span>
                </div>
              )}
              {!hasDetail && step.type === 'thinking' && (
                <div className="tsl-sub"><span className="tsl-sub-text tsl-sub-muted">思考中…</span></div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default ThinkingStepList
