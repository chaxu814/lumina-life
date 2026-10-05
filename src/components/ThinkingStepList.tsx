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

import React, { useMemo, useState } from 'react'
import { sanitizeThinkingText } from '../services/thinkingSanitizer'
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
  if (args == null) {return undefined}
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
  // 🔧 2026-10-05：简化思考过程显示。
  //
  // 【用户反馈的现象】一次搜索任务产生「思考过程（15 步）」，其中大量是：
  //   开始处理（第 1 轮）
  //     开始处理（第 1 轮）      ← 重复
  //   推理完成
  //     <整段英文推理草稿>
  //   第 2 轮处理中
  //     第 2 轮处理中            ← 重复
  //   第 3 轮处理中
  //     第 3 轮处理中            ← 重复
  //   ...
  //   正在读取网页：https://...
  //
  // 问题不在于「步数多」（工具调用本来就会产生多条），
  // 而在于【轮次标记本身是噪音】：
  //   · 用户关心的是「它做了什么」，不是「这是第几轮」
  //   · 轮次标记与同名的 reasoning 步骤成对出现，视觉上完全重复
  //   · 15 步里有一半是这两类，翻开面板要滚很久才能看到真正有用的工具记录
  //
  // 【本组件的简化策略】
  //   1. 过滤掉纯轮次标记（开始处理 / 第 N 轮处理中）—— 它们不携带信息
  //   2. 连续的重复 label 只保留一条
  //   3. 步骤数上限默认 6 条，超出折叠为「还有 N 条…」（点开可见）
  // 工具调用、成功/失败、耗时、入参/结果等【全部保留】——
  // 那是用户真正要看的可核查信息。
  const MAX_VISIBLE = 6
  /** 用户是否展开了被折叠的尾部 */
  const [expanded, setExpanded] = useState(false)

  const visible = useMemo(() => {
    const isRoundMarker = (s: ThinkingStep): boolean => {
      const t = stripEmoji(s.label || '')
      return /^开始处理（第\s*\d+\s*轮）$/.test(t)
        || /^第\s*\d+\s*轮处理中$/.test(t)
        || t === '开始处理'
    }
    // 1) 去掉轮次标记
    const noMarkers = steps.filter(s => !isRoundMarker(s))
    // 2) 去掉连续的相同 label（模型常在流式时重复 emit 同一句）
    const deduped: ThinkingStep[] = []
    for (const s of noMarkers) {
      const prev = deduped[deduped.length - 1]
      if (prev && prev.type === s.type && stripEmoji(prev.label) === stripEmoji(s.label)) {
        // 保留更长的 result（后到的通常是累积后的完整内容）
        if ((s.result?.length ?? 0) > (prev.result?.length ?? 0)) {
          deduped[deduped.length - 1] = { ...prev, result: s.result }
        }
        continue
      }
      deduped.push(s)
    }
    return deduped
  }, [steps])

  // 默认只展示前 MAX_VISIBLE 条；用户点「还有 N 条」后才展示全部
  const shown = expanded ? visible : visible.slice(0, MAX_VISIBLE)
  const hidden = visible.length - Math.min(shown.length, MAX_VISIBLE)
  const rows = useMemo(
    () => shown.map((s, i) => {
      // 🧠 2026-10-04：推理文本清洗的收口点就在这里。
      // 四个 thinking_stream 累积入口（协作 / 阶段 / 群聊 / 决策讨论）都把内容
      // 攒进 step.result，再统一交给本组件渲染 —— 所以清洗一次就全覆盖，
      // 不用去 4 个流式入口分别改（分片流在那里逐块清洗会把行截断）。
      const isReasoning = s.type === 'thinking'
      const clean = isReasoning ? sanitizeThinkingText(s.result) : null
      return {
        step: s,
        icon: stepIcon(s.type),
        title: stripEmoji(s.label) || s.label,
        // 错峰入场最多铺前 8 步，再多就一起进，避免长列表末尾干等
        i: Math.min(i, 8),
        // 整段被判定为元推理时 result 变空串 —— 用空串而不是 undefined，
        // 否则会被下面的 `step.result &&` 当成「有详情」而留下空白行。
        detail: isReasoning ? (clean?.text || '') : (s.result || ''),
        foreignLang: !!clean?.foreignLang,
      }
    }),
    [shown],
  )

  return (
    <div className="tsl-list">
      {rows.map(({ step, icon, title, i, detail, foreignLang }) => {
        const isError = step.type === 'tool_error'
        const isDone = step.type === 'tool_end'
        const hasDetail = !!(detail || step.args)
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
              {detail && (
                <div className="tsl-sub tsl-sub-result">
                  {/* 模型用非中文推理时标注出来 —— 不静默丢弃，用户有权知道 */}
                  {foreignLang && (
                    <div className="tsl-sub-key" title="模型这一段用英文推理，原始内容保留在下方">
                      英文推理
                    </div>
                  )}
                  <span className="tsl-sub-text">{detail}</span>
                </div>
              )}
              {!hasDetail && step.type === 'thinking' && (
                <div className="tsl-sub"><span className="tsl-sub-text tsl-sub-muted">思考中…</span></div>
              )}
            </div>
          </div>
        )
      })}

      {/* 🔧 2026-10-05：隐藏部分的展开入口。
          「简化」不等于「删除」—— 用户仍能一键看到完整列表，
          但默认不再需要滚过十几行噪音才能找到工具调用。 */}
      {hidden > 0 && (
        <button
          type="button"
          className="tsl-more"
          onClick={() => setExpanded(true)}
        >
          ▾ 还有 {hidden} 条（点击展开完整过程）
        </button>
      )}
      {expanded && visible.length > MAX_VISIBLE && (
        <button
          type="button"
          className="tsl-more"
          onClick={() => setExpanded(false)}
        >
          ▴ 收起（已显示全部 {visible.length} 条）
        </button>
      )}
    </div>
  )
}

export default ThinkingStepList
