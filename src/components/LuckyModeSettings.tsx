// ============================================================
// LuckyModeSettings.tsx — Lucky 模式详细设置面板
//
// 智能预设（宽松/标准/严格）+ Mission 合并入 Goal
//   - Default: 迭代限制, 死循环检测窗口/阈值/次数, 完成检查
//   - Goal: 目标描述 + 子任务拆解 + Token预算 + LLM评估可选
// ============================================================

import React, { useState } from 'react'
import type { LuckyModePreset } from './LuckyModeSelector'

export interface LuckySettingsConfig {
  preset: LuckyModePreset
  maxIterations: number
  doomLoop: {
    windowSize: number
    similarityThreshold: number
    maxRepetitions: number
    interventionAction: 'pause' | 'remind'
    reminderMessage: string
  }
  completionRubric: {
    enabled: boolean
    rePromptOnTextOnly: boolean
    rePromptMessage: string
    maxInterventionsPerTurn: number
  }
  goal: {
    maxIterations: number
    tokenBudget: number
    goalDescription: string
    completionCriteria: string
    // 🆕 合并自 Mission：子任务列表
    subTasks: string[]
    bypassIterationLimit: boolean
    trackProgress: boolean
    // 🆕 LLM 精确评估开关
    useLLMEvaluation: boolean
  }
  mission?: {
    subTasks: string[]
    bypassIterationLimit: boolean
    trackProgress: boolean
  }
}

interface LuckyModeSettingsProps {
  config: LuckySettingsConfig
  onSave: (config: LuckySettingsConfig) => void
  onClose: () => void
}

export function getDefaultSettings(): LuckySettingsConfig {
  return {
    preset: 'off',
    maxIterations: 25,
    doomLoop: {
      windowSize: 5,
      similarityThreshold: 0.85,
      maxRepetitions: 3,
      interventionAction: 'pause',
      reminderMessage: '🔄 我注意到你在重复做类似的操作，是不是遇到困难了？要不要换个思路？',
    },
    completionRubric: {
      enabled: true,
      rePromptOnTextOnly: true,
      rePromptMessage: '看起来你还没完成，能再检查一下吗？如果需要工具调用，请直接使用。',
      maxInterventionsPerTurn: 2,
    },
    goal: {
      maxIterations: 50,
      tokenBudget: 100000,
      goalDescription: '',
      completionCriteria: '',
      subTasks: [],
      bypassIterationLimit: true,
      trackProgress: true,
      useLLMEvaluation: false,
    },
    mission: {
      subTasks: [],
      bypassIterationLimit: true,
      trackProgress: true,
    },
  }
}

// ── 智能快速预设（一键应用） ──

const SMART_PRESETS = [
  {
    id: 'loose',
    label: '🟢 宽松模式',
    sublabel: '日常聊天/搜资料',
    desc: '窗口大、阈值低、不检查完成，搜网页不会被打断',
    values: {
      maxIterations: 50,
      doomLoop: { windowSize: 12, similarityThreshold: 0.60, maxRepetitions: 6, interventionAction: 'remind' as const, reminderMessage: '🔄 需要换个思路吗？' },
      completionRubric: { enabled: false, rePromptOnTextOnly: false, rePromptMessage: '', maxInterventionsPerTurn: 0 },
    },
  },
  {
    id: 'standard',
    label: '🟡 标准模式',
    sublabel: '日常平衡',
    desc: '窗口适中、完成检查温和，兼顾安全与流畅',
    values: {
      maxIterations: 30,
      doomLoop: { windowSize: 8, similarityThreshold: 0.75, maxRepetitions: 4, interventionAction: 'remind' as const, reminderMessage: '🔄 我注意到你在重复做类似的操作，要不要换个思路？' },
      completionRubric: { enabled: true, rePromptOnTextOnly: true, rePromptMessage: '看起来你还没完成，能再检查一下吗？如果需要工具调用，请直接使用。', maxInterventionsPerTurn: 1 },
    },
  },
  {
    id: 'strict',
    label: '🔴 严格模式',
    sublabel: '跑代码/自动化',
    desc: '窗口小、阈值高、严格检查，适合需要精确控制的场景',
    values: {
      maxIterations: 20,
      doomLoop: { windowSize: 5, similarityThreshold: 0.85, maxRepetitions: 3, interventionAction: 'pause' as const, reminderMessage: '🔄 我注意到你在重复做类似的操作，是不是遇到困难了？要不要换个思路？' },
      completionRubric: { enabled: true, rePromptOnTextOnly: true, rePromptMessage: '看起来你还没完成，能再检查一下吗？如果需要工具调用，请直接使用。', maxInterventionsPerTurn: 2 },
    },
  },
]

export default function LuckyModeSettings({
  config: initialConfig,
  onSave,
  onClose,
}: LuckyModeSettingsProps) {
  const [config, setConfig] = useState<LuckySettingsConfig>(initialConfig)
  const [activeTab, setActiveTab] = useState<'general' | 'doomloop' | 'rubric' | 'goal'>('general')
  const [newTask, setNewTask] = useState('')

  const update = (partial: Partial<LuckySettingsConfig>) => {
    setConfig(c => ({ ...c, ...partial }))
  }

  /** 🆕 一键应用智能预设 */
  const applySmartPreset = (preset: typeof SMART_PRESETS[number]) => {
    setConfig(c => ({
      ...c,
      maxIterations: preset.values.maxIterations,
      doomLoop: { ...c.doomLoop, ...preset.values.doomLoop },
      completionRubric: { ...c.completionRubric, ...preset.values.completionRubric },
    }))
  }

  const tabs = [
    { id: 'general' as const, label: '⚙️ 通用' },
    { id: 'doomloop' as const, label: '🔄 死循环保护' },
    { id: 'rubric' as const, label: '✅ 完成检查' },
    { id: 'goal' as const, label: '🎯 目标模式' },
  ]

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface-0)',
        borderRadius: 14,
        width: 480,
        maxWidth: '90vw',
        maxHeight: '80vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }} onClick={e => e.stopPropagation()}>
        
        {/* 标题 */}
        <div style={{
          padding: '14px 16px',
          borderBottom: '1px solid var(--border-light)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>
            🍀 Lucky 模式设置
          </span>
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: 6,
            border: 'none', background: 'transparent',
            cursor: 'pointer', fontSize: 16, color: 'var(--text-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
        </div>

        {/* Tab 导航 */}
        <div style={{
          display: 'flex', gap: 2, padding: '8px 12px',
          borderBottom: '1px solid var(--border-light)',
          background: '#fafafa', overflowX: 'auto', flexShrink: 0,
        }}>
          {tabs.map(tab => (
            <button key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '5px 12px', borderRadius: 6,
                border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: activeTab === tab.id ? 600 : 400,
                background: activeTab === tab.id ? 'var(--surface-0)' : 'transparent',
                color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                boxShadow: activeTab === tab.id ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                whiteSpace: 'nowrap',
              }}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: 16,
        }}>
          {/* ═══ 通用设置 ═══ */}
          {activeTab === 'general' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* 🆕 智能快速预设 — 一键傻瓜式设置 */}
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 6 }}>
                  ⚡ 快速预设（一键应用全部参数）
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {SMART_PRESETS.map(sp => {
                    const isActive =
                      config.doomLoop.windowSize === sp.values.doomLoop.windowSize &&
                      config.doomLoop.maxRepetitions === sp.values.doomLoop.maxRepetitions &&
                      Math.abs(config.doomLoop.similarityThreshold - sp.values.doomLoop.similarityThreshold) < 0.01 &&
                      config.doomLoop.interventionAction === sp.values.doomLoop.interventionAction &&
                      config.completionRubric.enabled === sp.values.completionRubric.enabled
                    return (
                      <button key={sp.id} onClick={() => applySmartPreset(sp)}
                        style={{
                          flex: 1, padding: '10px 6px', borderRadius: 10, cursor: 'pointer',
                          border: isActive ? '2px solid #6366f1' : '1.5px solid var(--border-light)',
                          background: isActive ? '#eef2ff' : 'var(--surface-100)',
                          textAlign: 'center', transition: 'all 0.15s',
                        }}>
                        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 1 }}>{sp.label}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 3 }}>{sp.sublabel}</div>
                        <div style={{ fontSize: 10, color: isActive ? '#4338ca' : '#64748b', lineHeight: 1.3, opacity: 0.8 }}>{sp.desc}</div>
                      </button>
                    )
                  })}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
                  💡 选了之后还可以在下方各标签页微调
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border-light)', marginTop: 4 }} />

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  🎯 当前预设
                </label>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['off', 'default', 'goal', 'mission'] as LuckyModePreset[]).map(p => {
                    const labels: Record<LuckyModePreset, string> = { off: '⏹️ 关闭', default: '🔄 标准循环', goal: '🎯 目标驱动', mission: '🚀 任务模式' }
                    return (
                      <button key={p}
                        onClick={() => update({ preset: p })}
                        style={{
                          flex: 1, padding: '8px 6px', borderRadius: 8, cursor: 'pointer',
                          border: config.preset === p ? '2px solid var(--accent, #6366f1)' : '1px solid var(--border-light)',
                          background: config.preset === p ? 'var(--accent-50, #eef2ff)' : 'var(--surface-100)',
                          fontSize: 11, fontWeight: config.preset === p ? 600 : 400, textAlign: 'center',
                        }}>
                        {labels[p]}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  最大迭代次数
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="range" min={5} max={200} step={5}
                    value={config.maxIterations}
                    onChange={e => update({ maxIterations: parseInt(e.target.value) })}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 13, fontWeight: 600, minWidth: 30, textAlign: 'right' }}>
                    {config.maxIterations}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                  超过该次数后自动停止 AI 循环
                </div>
              </div>

              <div style={{
                padding: 10, borderRadius: 8, background: 'var(--accent-50, #eef2ff)',
                border: '1px solid #c7d2fe', fontSize: 11, color: '#4338ca', lineHeight: 1.5,
              }}>
                💡 <b>提示：</b>「标准循环」适合日常对话，「目标驱动」适合代码编写等需要反复试错的场景，
                里面还集成了子任务拆解功能。先选一个快速预设，再去各标签页微调细节。
              </div>
            </div>
          )}

          {/* ═══ 死循环保护 ═══ */}
          {activeTab === 'doomloop' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  检测窗口大小
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="range" min={2} max={20} step={1}
                    value={config.doomLoop.windowSize}
                    onChange={e => update({ doomLoop: { ...config.doomLoop, windowSize: parseInt(e.target.value) } })}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 13, fontWeight: 600, minWidth: 20, textAlign: 'right' }}>
                    {config.doomLoop.windowSize}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                  检查最近多少次工具调用中是否有重复
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  相似度阈值 ({config.doomLoop.similarityThreshold})
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="range" min={0.5} max={1} step={0.05}
                    value={config.doomLoop.similarityThreshold}
                    onChange={e => update({ doomLoop: { ...config.doomLoop, similarityThreshold: parseFloat(e.target.value) } })}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 13, fontWeight: 600, minWidth: 30, textAlign: 'right' }}>
                    {(config.doomLoop.similarityThreshold * 100).toFixed(0)}%
                  </span>
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  连续重复次数
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="range" min={2} max={10} step={1}
                    value={config.doomLoop.maxRepetitions}
                    onChange={e => update({ doomLoop: { ...config.doomLoop, maxRepetitions: parseInt(e.target.value) } })}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 13, fontWeight: 600, minWidth: 20, textAlign: 'right' }}>
                    {config.doomLoop.maxRepetitions}
                  </span>
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  干预方式
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => update({ doomLoop: { ...config.doomLoop, interventionAction: 'pause' } })}
                    style={{
                      flex: 1, padding: '8px', borderRadius: 8, cursor: 'pointer',
                      border: config.doomLoop.interventionAction === 'pause' ? '2px solid #ef4444' : '1px solid var(--border-light)',
                      background: config.doomLoop.interventionAction === 'pause' ? '#fef2f2' : 'var(--surface-100)',
                      fontSize: 12, fontWeight: config.doomLoop.interventionAction === 'pause' ? 600 : 400,
                    }}>
                    ⏸️ 暂停等用户
                  </button>
                  <button
                    onClick={() => update({ doomLoop: { ...config.doomLoop, interventionAction: 'remind' } })}
                    style={{
                      flex: 1, padding: '8px', borderRadius: 8, cursor: 'pointer',
                      border: config.doomLoop.interventionAction === 'remind' ? '2px solid #f59e0b' : '1px solid var(--border-light)',
                      background: config.doomLoop.interventionAction === 'remind' ? '#fffbeb' : 'var(--surface-100)',
                      fontSize: 12, fontWeight: config.doomLoop.interventionAction === 'remind' ? 600 : 400,
                    }}>
                    💬 发提醒继续
                  </button>
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  提醒文案
                </label>
                <textarea
                  value={config.doomLoop.reminderMessage}
                  onChange={e => update({ doomLoop: { ...config.doomLoop, reminderMessage: e.target.value } })}
                  rows={2}
                  style={{
                    width: '100%', padding: '6px 8px', borderRadius: 6,
                    border: '1px solid var(--border-light)', fontSize: 11,
                    resize: 'vertical', fontFamily: 'inherit',
                  }}
                />
              </div>
            </div>
          )}

          {/* ═══ 完成检查 ═══ */}
          {activeTab === 'rubric' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox"
                  checked={config.completionRubric.enabled}
                  onChange={e => update({ completionRubric: { ...config.completionRubric, enabled: e.target.checked } })} />
                启用完成检查
              </label>

              {config.completionRubric.enabled && (<>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox"
                    checked={config.completionRubric.rePromptOnTextOnly}
                    onChange={e => update({ completionRubric: { ...config.completionRubric, rePromptOnTextOnly: e.target.checked } })} />
                  纯文本未调工具时重新提示
                </label>

                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                    每轮最多重提示次数
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="range" min={0} max={5} step={1}
                      value={config.completionRubric.maxInterventionsPerTurn}
                      onChange={e => update({ completionRubric: { ...config.completionRubric, maxInterventionsPerTurn: parseInt(e.target.value) } })}
                      style={{ flex: 1 }} />
                    <span style={{ fontSize: 13, fontWeight: 600, minWidth: 20, textAlign: 'right' }}>
                      {config.completionRubric.maxInterventionsPerTurn}
                    </span>
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                    重新提示文案
                  </label>
                  <textarea
                    value={config.completionRubric.rePromptMessage}
                    onChange={e => update({ completionRubric: { ...config.completionRubric, rePromptMessage: e.target.value } })}
                    rows={2}
                    style={{
                      width: '100%', padding: '6px 8px', borderRadius: 6,
                      border: '1px solid var(--border-light)', fontSize: 12,
                      resize: 'vertical', fontFamily: 'inherit',
                    }}
                  />
                </div>
              </>)}
            </div>
          )}

          {/* ═══ 目标模式（合并原 Mission 子任务） ═══ */}
          {activeTab === 'goal' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  目标描述
                </label>
                <textarea
                  value={config.goal.goalDescription}
                  onChange={e => update({ goal: { ...config.goal, goalDescription: e.target.value } })}
                  rows={2}
                  placeholder="例如：帮我写一个 todo list 网页应用..."
                  style={{
                    width: '100%', padding: '6px 8px', borderRadius: 6,
                    border: '1px solid var(--border-light)', fontSize: 12,
                    resize: 'vertical', fontFamily: 'inherit',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  完成标准
                </label>
                <textarea
                  value={config.goal.completionCriteria}
                  onChange={e => update({ goal: { ...config.goal, completionCriteria: e.target.value } })}
                  rows={2}
                  placeholder="例如：网页能够正常添加、删除、标记完成待办事项，界面美观"
                  style={{
                    width: '100%', padding: '6px 8px', borderRadius: 6,
                    border: '1px solid var(--border-light)', fontSize: 12,
                    resize: 'vertical', fontFamily: 'inherit',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                    目标迭代上限
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="range" min={5} max={200} step={5}
                      value={config.goal.maxIterations}
                      onChange={e => update({ goal: { ...config.goal, maxIterations: parseInt(e.target.value) } })}
                      style={{ flex: 1 }} />
                    <span style={{ fontSize: 13, fontWeight: 600, minWidth: 30, textAlign: 'right' }}>
                      {config.goal.maxIterations}
                    </span>
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                    Token 预算
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="range" min={10000} max={500000} step={10000}
                      value={config.goal.tokenBudget}
                      onChange={e => update({ goal: { ...config.goal, tokenBudget: parseInt(e.target.value) } })}
                      style={{ flex: 1 }} />
                    <span style={{ fontSize: 12, fontWeight: 600, minWidth: 50, textAlign: 'right' }}>
                      {(config.goal.tokenBudget / 1000).toFixed(0)}K
                    </span>
                  </div>
                </div>
              </div>

              {/* 🆕 合并自 Mission：子任务列表 */}
              <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 8 }}>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: 6 }}>
                  📋 子任务列表（选填 — 添加后 AI 按顺序执行）
                </label>
                <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                  <input
                    value={newTask}
                    onChange={e => setNewTask(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newTask.trim()) {
                        update({ goal: { ...config.goal, subTasks: [...config.goal.subTasks, newTask.trim()] } })
                        setNewTask('')
                      }
                    }}
                    placeholder="输入子任务，按回车添加"
                    style={{
                      flex: 1, padding: '6px 8px', borderRadius: 6,
                      border: '1px solid var(--border-light)', fontSize: 11,
                    }}
                  />
                  <button
                    onClick={() => {
                      if (newTask.trim()) {
                        update({ goal: { ...config.goal, subTasks: [...config.goal.subTasks, newTask.trim()] } })
                        setNewTask('')
                      }
                    }}
                    style={{
                      padding: '6px 12px', borderRadius: 6,
                      border: 'none', background: 'var(--accent, #6366f1)',
                      color: '#fff', cursor: 'pointer', fontSize: 11,
                    }}>
                    + 添加
                  </button>
                </div>

                {config.goal.subTasks.length === 0 ? (
                  <div style={{
                    padding: 10, textAlign: 'center', fontSize: 11,
                    color: 'var(--text-secondary)', background: 'var(--surface-100)',
                    borderRadius: 8,
                  }}>
                    暂无子任务。添加后 AI 会自动按顺序完成
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {config.goal.subTasks.map((task, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '6px 8px', borderRadius: 6,
                        background: 'var(--surface-100)',
                        fontSize: 11,
                      }}>
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>#{i + 1}</span>
                        <span style={{ flex: 1 }}>{task}</span>
                        <button
                          onClick={() => {
                            const updated = config.goal.subTasks.filter((_, j) => j !== i)
                            update({ goal: { ...config.goal, subTasks: updated } })
                          }}
                          style={{
                            border: 'none', background: 'transparent',
                            cursor: 'pointer', fontSize: 13,
                            color: '#ef4444', padding: '2px 4px',
                          }}>
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                    <input type="checkbox"
                      checked={config.goal.bypassIterationLimit}
                      onChange={e => update({ goal: { ...config.goal, bypassIterationLimit: e.target.checked } })} />
                    解除迭代限制
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                    <input type="checkbox"
                      checked={config.goal.trackProgress}
                      onChange={e => update({ goal: { ...config.goal, trackProgress: e.target.checked } })} />
                    启用进度追踪
                  </label>
                </div>
              </div>

              {/* 🆕 LLM 精确评估开关 */}
              <div style={{
                padding: 10, borderRadius: 8, background: '#f5f3ff',
                border: '1px solid #ddd6fe', fontSize: 11, lineHeight: 1.5,
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: '#6d28d9' }}>
                  <input type="checkbox"
                    checked={config.goal.useLLMEvaluation}
                    onChange={e => update({ goal: { ...config.goal, useLLMEvaluation: e.target.checked } })} />
                  🧠 <b>LLM 精确评估</b>（使用 AI 自己判断完成度，而非关键词匹配）
                </label>
                <div style={{ color: '#7c3aed', marginTop: 4, fontSize: 10 }}>
                  ⚡ 会多消耗一次 LLM 调用，默认关闭。建议大项目开，日常对话关。
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--border-light)',
          display: 'flex', gap: 8, justifyContent: 'flex-end',
        }}>
          <button onClick={onClose} style={{
            padding: '8px 16px', borderRadius: 8,
            border: '1px solid var(--border-light)',
            background: 'transparent', cursor: 'pointer',
            fontSize: 12, color: 'var(--text-secondary)',
          }}>
            取消
          </button>
          <button
            onClick={() => {
              onSave(config)
              onClose()
            }}
            style={{
              padding: '8px 16px', borderRadius: 8,
              border: 'none',
              background: 'linear-gradient(135deg, #8b5cf6, #6366f1)',
              color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              boxShadow: '0 2px 8px rgba(99,102,241,0.3)',
            }}>
            💾 保存设置
          </button>
        </div>
      </div>
    </div>
  )
}
