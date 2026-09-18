// ============================================================
// components/TeamCommunityModal.tsx — Lumina团队社区弹窗
//
// 将社区、真人秀、家谱三个面板整合到一个弹窗中，
// 类似 SettingsModal 的局内 UI 弹窗模式。
// ============================================================

import React, { useState } from 'react'
import SocialPanel from '../panels/SocialPanel'
import RealityShowPanel from '../panels/RealityShowPanel'
import FamilyTreePanel from '../panels/FamilyTreePanel'
import DreamPanel from '../panels/DreamPanel'
import { useStore } from '../stores/appStore'
import { isExperimental } from '../featureManifest'

/* ── 侧边栏导航项 ── */
const SIDEBAR_ITEMS = [
  { id: 'social', icon: '🌐', label: '社区' },
  { id: 'reality', icon: '🎬', label: '真人秀🧪' },
  { id: 'familytree', icon: '🌳', label: '家谱' },
  { id: 'dream', icon: '🌙', label: '梦境🧪' },
] as const

type SidebarId = (typeof SIDEBAR_ITEMS)[number]['id']

interface TeamCommunityModalProps {
  open: boolean
  onClose: () => void
}

export default function TeamCommunityModal({ open, onClose }: TeamCommunityModalProps) {
  const [activeSection, setActiveSection] = useState<SidebarId>('social')
  const showExperimental = useStore((st) => st.showExperimental)
  const setShowExperimental = useStore((st) => st.setShowExperimental)

  // 实验功能（梦境/真人秀）可在设置里一键隐藏
  const visibleItems = SIDEBAR_ITEMS.filter((it) => showExperimental || !isExperimental(it.id))
  const effectiveSection: SidebarId = visibleItems.some((it) => it.id === activeSection)
    ? activeSection
    : (visibleItems[0]?.id ?? 'social')

  if (!open) return null

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
            👥 Lumina团队社区
          </div>

          {/* 导航项列表 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}>
            {visibleItems.map((item) => {
              const active = effectiveSection === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveSection(item.id)}
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

          {/* 实验室开关 + 版本 */}
          <div
            style={{
              padding: '8px 12px 0',
              borderTop: '1px solid var(--border-light)',
              marginTop: 4,
              paddingTop: 10,
              fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
            }}
          >
            <button
              onClick={() => setShowExperimental(!showExperimental)}
              title="显示或隐藏梦境/真人秀等实验彩蛋"
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px', borderRadius: 8, border: 'none',
                background: showExperimental ? 'var(--accent-50)' : 'transparent',
                color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer',
              }}
            >
              <span style={{
                width: 28, height: 16, borderRadius: 9, position: 'relative',
                background: showExperimental ? '#8b5cf6' : 'var(--surface-200)',
                transition: 'background 0.15s', flexShrink: 0,
              }}>
                <span style={{
                  position: 'absolute', top: 2, left: showExperimental ? 14 : 2,
                  width: 12, height: 12, borderRadius: 6, background: '#fff',
                  transition: 'left 0.15s',
                }} />
              </span>
              <span>🧪 实验室彩蛋</span>
            </button>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', opacity: 0.6, padding: '4px 8px 0' }}>
              Lumina Life v1.0.0
            </div>
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
              {SIDEBAR_ITEMS.find((i) => i.id === effectiveSection)?.icon}{' '}
              {SIDEBAR_ITEMS.find((i) => i.id === effectiveSection)?.label}
            </div>
            <button
              onClick={onClose}
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
            {effectiveSection === 'social' && <SocialPanel />}
            {effectiveSection === 'reality' && <RealityShowPanel />}
            {effectiveSection === 'familytree' && <FamilyTreePanel />}
            {effectiveSection === 'dream' && <DreamPanel />}
          </div>
        </div>
      </div>
    </div>
  )
}
