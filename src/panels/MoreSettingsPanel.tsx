// ============================================================
// panels/MoreSettingsPanel.tsx — ⚙️ 更多设置
//
// 将 Agent / 技能 / 用量 / 诊断 / 测试 五个面板整合为
// 统一的 Tab 式「更多设置」入口，与 SettingsPanel 风格一致。
// ============================================================

import React, { useState } from 'react'
import AgentPanel from './AgentPanel'
import SkillsPanel from './SkillsPanel'
import UsagePanel from './UsagePanel'
import DiagnosticsPanel from './DiagnosticsPanel'
import TestCoveragePanel from './TestCoveragePanel'

type MoreTab = 'agent' | 'skills' | 'usage' | 'diagnostics' | 'test'

const TABS: { key: MoreTab; label: string; icon: string }[] = [
  { key: 'agent',       label: 'Agent 配置', icon: '🤖' },
  { key: 'skills',      label: '技能管理',   icon: '⚡' },
  { key: 'usage',       label: '用量限额',   icon: '📊' },
  { key: 'diagnostics', label: '诊断工具',   icon: '🔍' },
  { key: 'test',        label: '测试覆盖',   icon: '🧪' },
]

export default function MoreSettingsPanel() {
  const [tab, setTab] = useState<MoreTab>('agent')

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ── 面板标题 ── */}
      <div className="panel-header">
        <div className="panel-title">⚙️ 更多设置</div>
        <div className="panel-subtitle">Agent 配置 · 技能管理 · 用量限额 · 诊断工具 · 测试覆盖</div>
      </div>

      {/* ── Tab 导航（与 SettingsPanel 风格一致） ── */}
      <div style={{
        display: 'flex', gap: 0,
        borderBottom: '2px solid var(--border-light)',
        margin: '0 20px 16px',
        background: 'var(--surface-0)',
        flexShrink: 0, padding: '0 4px', overflowX: 'auto',
      }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '8px 16px', border: 'none',
              borderBottom: tab === t.key
                ? '2px solid #3b82f6'
                : '2px solid transparent',
              background: 'none', cursor: 'pointer', fontSize: 12,
              fontWeight: tab === t.key ? 600 : 400,
              color: tab === t.key ? '#3b82f6' : 'var(--text-secondary)',
              marginBottom: -2, transition: 'all 0.2s',
              display: 'flex', alignItems: 'center', gap: 5,
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* ── Tab 内容区域 ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {tab === 'agent'       && <AgentPanel embedded />}
        {tab === 'skills'      && <SkillsPanel embedded />}
        {tab === 'usage'       && <UsagePanel embedded />}
        {tab === 'diagnostics' && <DiagnosticsPanel />}
        {tab === 'test'        && <TestCoveragePanel />}
      </div>
    </div>
  )
}
