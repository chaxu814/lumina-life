// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ContextUsageIndicator.tsx — 上下文用量实时指示器
//
// 参考 QwenPaw / 豆包设计：在输入栏显示当前对话的上下文占用
//   - 百分比 + 已用/总量（如 "43.4% · 111.0K / 256.0K"）
//   - 微型进度条，颜色随用量变化（绿→黄→红）
//   - 鼠标悬停显示详细信息
// ============================================================

import React, { useMemo } from 'react'
import { useAgentRuntime } from '../stores/agentRuntimeStore'
import { useStore } from '../stores/appStore'

/** 格式化 token 数为易读字符串 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {return `${(n / 1_000_000).toFixed(1)}M`}
  if (n >= 1_000) {return `${(n / 1_000).toFixed(1)}K`}
  return String(n)
}

/** 根据用量百分比返回颜色 */
function getColor(pct: number): { bar: string; text: string; bg: string } {
  if (pct >= 90) {return { bar: '#ef4444', text: '#ef4444', bg: 'rgba(239,68,68,0.12)' }}
  if (pct >= 70) {return { bar: '#f59e0b', text: '#d97706', bg: 'rgba(245,158,11,0.12)' }}
  if (pct >= 40) {return { bar: '#6366f1', text: '#6366f1', bg: 'rgba(99,102,241,0.10)' }}
  return { bar: '#10b981', text: '#059669', bg: 'rgba(16,185,129,0.10)' }
}

const ContextUsageIndicator: React.FC = () => {
  const contextUsage = useAgentRuntime(s => s.contextUsage)
  const llmConfig = useStore(s => s.llmConfig)

  const { promptTokens, contextWindow, percentage, colors, visible, willCompress } = useMemo(() => {
    const used = contextUsage.promptTokens || 0
    // 优先使用运行时检测到的窗口，其次用设置中的值
    let window = contextUsage.contextWindow || llmConfig.contextWindow || 0
    // 如果都为 0，用保守默认 128K（仅用于显示，不影响实际逻辑）
    if (!window) {window = 131_072}
    const pct = Math.min(100, (used / window) * 100)
    return {
      promptTokens: used,
      contextWindow: window,
      percentage: pct,
      colors: getColor(pct),
      visible: used > 0,
      willCompress: pct >= 50,  // 50% 以上提示可能即将压缩
    }
  }, [contextUsage, llmConfig.contextWindow])

  // 没有用量数据时不显示（首次对话前）
  if (!visible) {return null}

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 10px',
        borderRadius: '20px',
        fontSize: '11px',
        fontFamily: 'inherit',
        color: colors.text,
        background: colors.bg,
        cursor: 'default',
        userSelect: 'none',
        transition: 'all 0.3s ease',
        whiteSpace: 'nowrap',
        position: 'relative',
      }}
      title={
        `上下文用量\n` +
        `已用: ${formatTokens(promptTokens)} tokens\n` +
        `总量: ${formatTokens(contextWindow)} tokens\n` +
        `占用: ${percentage.toFixed(1)}%\n` +
        (willCompress ? '\n⚠️ 接近压缩阈值，系统将自动压缩历史对话' : '')
      }
    >
      {/* 微型进度条 */}
      <div style={{
        width: '32px',
        height: '4px',
        borderRadius: '2px',
        background: 'rgba(0,0,0,0.08)',
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        <div style={{
          width: `${percentage}%`,
          height: '100%',
          borderRadius: '2px',
          background: colors.bar,
          transition: 'width 0.5s ease, background 0.3s ease',
        }} />
      </div>

      {/* 文字信息 */}
      <span style={{ fontWeight: 600 }}>
        {percentage.toFixed(1)}%
      </span>
      <span style={{ opacity: 0.7, fontWeight: 400 }}>
        · {formatTokens(promptTokens)} / {formatTokens(contextWindow)}
      </span>

      {/* 压缩提示图标 */}
      {willCompress && (
        <span style={{ fontSize: '10px', opacity: 0.8 }}>🗜️</span>
      )}
    </div>
  )
}

export default ContextUsageIndicator
