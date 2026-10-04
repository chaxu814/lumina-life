// ============================================================
// components/MoreSettingsModal.tsx — 更多设置弹窗
//
// 将 Agent 配置 / 技能管理 / 用量限额 / 诊断工具 /
// 测试覆盖 / 技能开发 整合为一个局内 UI 弹窗，
// 与 SettingsModal / TeamCommunityModal 风格一致。
// ============================================================

import React, { useState, useRef, useEffect } from 'react'
import AgentPanel from '../panels/AgentPanel'
import CustomAgentPanel from '../panels/CustomAgentPanel'
import SkillsPanel from '../panels/SkillsPanel'
import UsagePanel from '../panels/UsagePanel'
import DiagnosticsPanel from '../panels/DiagnosticsPanel'
import TestCoveragePanel from '../panels/TestCoveragePanel'
import SkillDevPanel from '../panels/SkillDevPanel'
// 🔬 2026-10-04：两个新面板写完时既没进 panelMap 也没进这里，
//  等于完全没有入口。现在同时挂上「更多设置」和 panelMap 两条路。
import SwimlaneCanvas from '../panels/SwimlaneCanvas'
import MemoryTrialBenchPanel from '../panels/MemoryTrialBenchPanel'
// 🔬 2026-10-04：两个孤儿面板接上入口（此前全仓零引用）
import EmotionDashboardPanel from '../panels/EmotionDashboardPanel'
import ProactiveSettingsPanel from '../panels/ProactiveSettingsPanel'
import PluginPanelContainer from './PluginPanelContainer'
import SettingsPanel from '../panels/SettingsPanel'
import AppearancePanel from '../panels/AppearancePanel'  // 🎨 外观主题
import ModelStorePanel from '../panels/ModelStorePanel'
import SettingsA11y from '../panels/settings/SettingsA11y'
import MemoryFederationPanel from '../panels/MemoryFederationPanel'
import WebDavSyncPanel from '../panels/WebDavSyncPanel'
import BrowserLinksPanel from '../panels/settings/BrowserLinksPanel'
import TheaterPanel from '../panels/settings/TheaterPanel'

/* ── 侧边栏导航项 ── */
const SIDEBAR_ITEMS = [
  { id: 'agent',       icon: '🤖', label: 'Agent 配置' },
  { id: 'customAgent', icon: '🧩', label: '自定义 Agent' },
  { id: 'agentPool',   icon: '🏊', label: 'Agent' },
  { id: 'routing',     icon: '🧭', label: '路由' },
  { id: 'access',      icon: '🛡️', label: '权限' },
  { id: 'modes',       icon: '🎭', label: '模式' },
  { id: 'workflow',    icon: '📋', label: '工作流' },
  { id: 'modelStore',  icon: '🪆', label: 'Live2D 模型' },
  { id: 'skills',      icon: '⚡',  label: '技能管理' },
  { id: 'swimlane',    icon: '🛳️', label: '团队泳道' },
  { id: 'memorytrial', icon: '⚖️', label: '记忆审判台' },
  { id: 'emotionsdash', icon: '🎭', label: '情绪仪表盘' },
  { id: 'proactive', icon: '🔔', label: '主动推送' },
  { id: 'usage',       icon: '📊', label: '用量限额' },
  { id: 'diagnostics', icon: '🔍', label: '诊断工具' },
  { id: 'test',        icon: '🧪', label: '测试覆盖' },
  { id: 'skilldev',    icon: '🔧', label: '技能开发' },
  { id: 'plugins',     icon: '📦', label: '插件面板' },
  { id: 'appearance',  icon: '🎨', label: '外观' },
  { id: 'a11y',        icon: '♿', label: '无障碍' },
  { id: 'theater',     icon: '🎭', label: '任务剧场' },
  { id: 'browser',     icon: '🌐', label: '浏览器' },
  { id: 'federation', icon: '🤝', label: '记忆共享' },
  { id: 'webdav',      icon: '☁️', label: '云同步' },
] as const

type SidebarId = (typeof SIDEBAR_ITEMS)[number]['id']

interface MoreSettingsModalProps {
  open: boolean
  onClose: () => void
}

export default function MoreSettingsModal({ open, onClose }: MoreSettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SidebarId>('agent')
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // ♿ 焦点陷阱：打开时聚焦弹窗、Tab 循环、Esc 关闭、关闭后焦点归还
  useEffect(() => {
    if (!open) {return}
    previousFocusRef.current = document.activeElement as HTMLElement
    // 初始聚焦到弹窗容器
    dialogRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {e.stopPropagation(); onClose(); return}
      if (e.key !== 'Tab' || !dialogRef.current) {return}
      // 收集可聚焦元素，循环 Tab
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) {return}
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      // 关闭后焦点还给触发元素
      previousFocusRef.current?.focus?.()
    }
  }, [open, onClose])

  if (!open) {return null}

  return (
    /* ── 背景遮罩 ── */
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 0.15s ease-out',
        fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
      }}
      onClick={onClose}
    >
      {/* ── 弹窗主体 ── */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="更多设置"
        tabIndex={-1}
        style={{
          display: 'flex',
          width: 960,
          maxWidth: '92vw',
          height: '85vh',
          maxHeight: 720,
          backgroundColor: 'var(--surface-0)',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          overflow: 'hidden',
          animation: 'fadeInDown 0.2s ease-out',
          outline: 'none',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ═══ 左侧导航栏 ═══ */}
        <div
          style={{
            width: 200,
            flexShrink: 0,
            backgroundColor: 'var(--surface-50)',
            borderRight: '1px solid var(--border-light)',
            display: 'flex',
            flexDirection: 'column',
            padding: '16px 0 12px',
          }}
        >
          {/* 标题 */}
          <div
            style={{
              padding: '0 16px 14px',
              fontSize: 16,
              fontWeight: 700,
              color: 'var(--text-primary)',
              borderBottom: '1px solid var(--border-light)',
              marginBottom: 8,
              fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
            }}
          >
            ⚙️ 更多设置
          </div>

          {/* 导航项列表 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}>
            {SIDEBAR_ITEMS.map((item) => {
              const active = activeSection === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveSection(item.id)}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: 'none',
                    fontSize: 13,
                    fontWeight: active ? 600 : 400,
                    color: active ? 'var(--accent-600)' : 'var(--text-secondary)',
                    backgroundColor: active ? 'var(--accent-50)' : 'transparent',
                    cursor: 'pointer',
                    transition: 'all 0.12s',
                    textAlign: 'left',
                    marginBottom: 1,
                    fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) {
                      e.currentTarget.style.backgroundColor = 'var(--surface-100)'
                      e.currentTarget.style.color = 'var(--text-primary)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!active) {
                      e.currentTarget.style.backgroundColor = 'transparent'
                      e.currentTarget.style.color = 'var(--text-secondary)'
                    }
                  }}
                >
                  <span style={{ fontSize: 16, width: 22, textAlign: 'center', flexShrink: 0 }}>
                    {item.icon}
                  </span>
                  <span style={{ lineHeight: 1.3 }}>{item.label}</span>
                </button>
              )
            })}
          </div>

          {/* 底部版本信息 */}
          <div
            style={{
              padding: '8px 16px 0',
              fontSize: 10,
              color: 'var(--text-secondary)',
              borderTop: '1px solid var(--border-light)',
              marginTop: 4,
              paddingTop: 10,
              opacity: 0.6,
              fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
            }}
          >
            Lumina Life v1.0.0
          </div>
        </div>

        {/* ═══ 右侧内容区 ═══ */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {/* 顶部栏：标题 + 关闭按钮 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 20px 12px',
              borderBottom: '1px solid var(--border-light)',
              flexShrink: 0,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {SIDEBAR_ITEMS.find((i) => i.id === activeSection)?.icon}{' '}
              {SIDEBAR_ITEMS.find((i) => i.id === activeSection)?.label}
            </div>
            <button
              onClick={onClose}
              aria-label="关闭设置弹窗"
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'var(--text-secondary)',
                fontSize: 18,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.12s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--surface-100)'
                e.currentTarget.style.color = 'var(--text-primary)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--text-secondary)'
              }}
              title="关闭"
            >
              ✕
            </button>
          </div>

          {/* 内容主体（可滚动） */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 20px' }}>
            {activeSection === 'agent'       && <AgentPanel embedded />}
            {activeSection === 'customAgent' && <CustomAgentPanel embedded />}
            {activeSection === 'skills'      && <SkillsPanel embedded />}
            {activeSection === 'usage'       && <UsagePanel embedded />}
            {activeSection === 'diagnostics' && <DiagnosticsPanel />}
            {activeSection === 'test'        && <TestCoveragePanel />}
            {activeSection === 'skilldev'    && <SkillDevPanel />}
  {activeSection === 'swimlane'    && <SwimlaneCanvas />}
  {activeSection === 'memorytrial' && <MemoryTrialBenchPanel />}
  {activeSection === 'emotionsdash' && <EmotionDashboardPanel />}
  {activeSection === 'proactive' && <ProactiveSettingsPanel />}
            {activeSection === 'modelStore'  && <ModelStorePanel />}
            {activeSection === 'plugins'    && <PluginPanelContainer />}
            {activeSection === 'appearance' && <AppearancePanel />}
            {activeSection === 'a11y'        && <SettingsA11y />}
            {activeSection === 'theater'    && <TheaterPanel />}
      {activeSection === 'browser'     && <BrowserLinksPanel />}
{activeSection === 'federation' && <MemoryFederationPanel embedded />}
{activeSection === 'webdav'      && <WebDavSyncPanel embedded />}
            {(activeSection === 'agentPool' || activeSection === 'routing' || activeSection === 'access' || activeSection === 'modes' || activeSection === 'workflow') && (
              <SettingsPanel embedded activeTab={activeSection} onNotice={null} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
