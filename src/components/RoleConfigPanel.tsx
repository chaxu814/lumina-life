// ============================================================
// components/RoleConfigPanel.tsx — 专攻 Agent 创建向导
//
// 对标智谱清言「创建 Agent」流程（四步法）：
//   Step 1: 选择角色类型
//   Step 2: LLM 自动生成配置（systemPrompt + 技能 + Loop 预设）
//   Step 3: 用户微调（名称、图标、提示词）
//   Step 4: 确认创建 → 注入当前对话 + 添加到人格列表
// ============================================================

import React, { useState, useCallback } from 'react'
import { useStore } from '../stores/appStore'
import { useLoopStore } from '../stores/loopStore'
import { AGENT_ROLES, ALL_SKILL_IDS, type AgentRole } from '../data/agentRoles'
import type { LoopPreset } from '../data/agentRoles'
import { IconCheck, IconPlus, IconX } from './Icons'

type Step = 1 | 2 | 3 | 4

interface RoleConfigState {
  role: AgentRole | null
  name: string
  icon: string
  desc: string
  systemPrompt: string
  skills: string[]
  loopPresets: LoopPreset[]
}

const INITIAL: RoleConfigState = {
  role: null, name: '', icon: '🤖', desc: '',
  systemPrompt: '', skills: [], loopPresets: [],
}

export default function RoleConfigPanel({ onClose }: { onClose?: () => void }) {
  const [step, setStep] = useState<Step>(1)
  const [cfg, setCfg] = useState<RoleConfigState>(INITIAL)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const llmConfig = useStore(s => s.llmConfig)
  const llmOnline = useStore(s => s.llmOnline)
  const addCustomPersona = useStore(s => s.addCustomPersona)
  const setAgentConfig = useStore(s => s.setAgentConfig)
  const activePersona = useStore(s => s.agentConfig.persona)
  const { engine } = useLoopStore()

  // ── Step 1: 选择角色 ──────────────────────────────
  const selectRole = (role: AgentRole) => {
    setCfg({
      role,
      name: role.name,
      icon: role.icon,
      desc: role.desc,
      systemPrompt: role.systemPrompt,
      skills: [...role.defaultSkills],
      loopPresets: role.loopPresets ? role.loopPresets.map(p => ({ ...p })) : [],
    })
    setStep(2)
  }

  // ── Step 2: LLM 自动生成 ──────────────────────────
  const generateConfig = useCallback(async () => {
    if (!cfg.role) {return}
    const role = cfg.role

    // 检查 LLM 是否可用
    if (!llmOnline || !llmConfig?.baseUrl || !llmConfig?.model) {
      // LLM 不可用 → 使用角色默认配置（不自动生成，直接进入微调）
      setStep(3)
      return
    }

    setGenerating(true)
    setError(null)

    try {
      const prompt = `你是 Lumina 的 Agent 配置生成器。请根据以下角色定位，生成一份完整的 Agent 配置。

角色：${role.name}
角色定位：${role.desc}

请输出严格 JSON（不要 markdown 围栏），结构如下：
{
  "systemPrompt": "完整的系统提示词，包含角色定位、回复风格、工具使用策略、安全规则",
  "skills": ["skill-id-1", "skill-id-2"],
  "loopPresets": [
    {
      "name": "预设名称",
      "goal": "Loop 目标描述",
      "triggerType": "interval|cron",
      "triggerConfig": { "intervalMs": 86400000 }
    }
  ]
}

要求：
- systemPrompt 要具体、可执行，包含工具使用策略；
- skills 从以下列表中选择该角色真正需要的：${AGENT_ROLES[0].defaultSkills.join(', ')}、search、browser、memory、code、files、desktop、audio、notify、timer、image、news、proactive；
- loopPresets 可为空数组；没有预设则给空数组；
- 全部用简体中文。`

      const res = await window.luminaAPI?.llmChat?.({
        apiKey: llmConfig.apiKey || '',
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 1500,
        systemPrompt: '你是 Agent 配置生成器。只输出严格 JSON。',
      })

      const raw = res?.content
      if (!raw) {throw new Error('LLM 未返回内容')}

      // 提取 JSON
      const jsonStr = raw.replace(/```json\s*|\s*```/g, '').trim()
      const parsed = JSON.parse(jsonStr)

      setCfg(prev => ({
        ...prev,
        systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : prev.systemPrompt,
        skills: Array.isArray(parsed.skills) ? parsed.skills.filter((s: string) => typeof s === 'string') : prev.skills,
        loopPresets: Array.isArray(parsed.loopPresets)
          ? parsed.loopPresets.map((p: any) => ({
              id: `lp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              name: String(p.name || '未命名预设'),
              goal: String(p.goal || ''),
              trigger: {
                id: `trg-${Date.now()}`,
                type: (p.triggerType === 'cron' ? 'cron' : 'interval') as 'cron' | 'interval',
                config: p.triggerConfig || { intervalMs: 24 * 3600 * 1000 },
                enabled: true,
              },
              description: String(p.description || ''),
            }))
          : prev.loopPresets,
      }))

      setStep(3)
    } catch (e: any) {
      setError(e?.message || '生成失败')
      // 出错也不阻塞用户，直接进入微调步骤
      setStep(3)
    } finally {
      setGenerating(false)
    }
  }, [cfg.role, llmConfig, llmOnline])

  // ── Step 3: 微调 ──────────────────────────────────
  const toggleSkill = (skillId: string) => {
    setCfg(prev => ({
      ...prev,
      skills: prev.skills.includes(skillId)
        ? prev.skills.filter(s => s !== skillId)
        : [...prev.skills, skillId],
    }))
  }

  const toggleLoopPreset = (idx: number) => {
    setCfg(prev => ({
      ...prev,
      loopPresets: prev.loopPresets.map((p, i) =>
        i === idx ? { ...p, trigger: { ...p.trigger, enabled: !p.trigger.enabled } } : p
      ),
    }))
  }

  // ── Step 4: 确认创建 ──────────────────────────────
  const confirmCreate = () => {
    if (!cfg.role) {return}

    const persona = {
      id: 'custom-' + Date.now(),
      name: cfg.name.trim() || cfg.role.name,
      desc: cfg.desc.trim() || cfg.role.desc,
      icon: cfg.icon || cfg.role.icon,
      systemPrompt: cfg.systemPrompt,
    }

    // 1. 添加到自定义人格列表
    addCustomPersona(persona)

    // 2. 激活该人格 + 更新 systemPrompt + 技能
    setAgentConfig({
      persona: persona.id,
      systemPrompt: cfg.systemPrompt,
      tools: cfg.skills,
    })

    // 3. 如果有 loop 预设，自动注册到 Loop 引擎
    for (const preset of cfg.loopPresets) {
      if (preset.trigger.enabled) {
        void engine.createLoop(preset.goal, {
          agentId: persona.id,
          suggestedTriggers: [preset.trigger],
        })
      }
    }

    setStep(4)
  }

  // ── 渲染 ──────────────────────────────────────────
  return (
    <div className="panel" style={{ position: 'relative' }}>
      {/* 关闭按钮 */}
      {onClose && (
        <button className="btn btn-ghost btn-xs" onClick={onClose}
          style={{ position: 'absolute', top: 8, right: 8 }}>
          <IconX size={14} />
        </button>
      )}

      {/* 步骤指示器 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center' }}>
        {[1, 2, 3, 4].map(s => (
          <React.Fragment key={s}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 700,
              background: step >= s ? 'var(--accent-500)' : 'var(--surface-50)',
              color: step >= s ? '#fff' : 'var(--text-tertiary)',
              border: `2px solid ${step >= s ? 'var(--accent-500)' : 'var(--border-light)'}`,
              transition: 'all var(--transition-fast)',
            }}>{s}</div>
            {s < 4 && <div style={{ flex: 1, height: 2, background: step > s ? 'var(--accent-500)' : 'var(--border-light)', borderRadius: 1 }} />}
          </React.Fragment>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 8 }}>
          {['选择角色', 'AI 生成配置', '微调配置', '创建完成'][step - 1]}
        </span>
      </div>

      {/* ── Step 1 ── */}
      {step === 1 && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>选择专攻角色</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {AGENT_ROLES.map(role => (
              <button key={role.id}
                onClick={() => selectRole(role)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                  borderRadius: 'var(--radius-lg)', textAlign: 'left', width: '100%',
                  border: `2px solid ${cfg.role?.id === role.id ? 'var(--accent-500)' : 'var(--border-light)'}`,
                  background: cfg.role?.id === role.id ? 'var(--accent-50)' : 'var(--surface-0)',
                  cursor: 'pointer', transition: 'all var(--transition-fast)',
                }}>
                <span style={{ fontSize: 28 }}>{role.icon}</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{role.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{role.desc}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    技能：{role.defaultSkills.length} · {role.loopPresets?.length ? `Loop 预设：${role.loopPresets.length}` : '无预设 Loop'}
                  </div>
                </div>
                <span style={{ marginLeft: 'auto', color: 'var(--text-tertiary)' }}>
                  <IconPlus size={16} />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 2 ── */}
      {step === 2 && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>
            {generating ? '🤖 AI 正在生成配置…' : 'AI 生成的配置'}
          </div>
          {generating && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)' }}>
              正在为「{cfg.role?.name}」生成 systemPrompt、技能配置和 Loop 预设…
            </div>
          )}
          {error && (
            <div style={{ padding: 12, background: 'var(--surface-50)', borderRadius: 'var(--radius)', color: 'var(--danger)', marginBottom: 12 }}>
              ⚠️ {error}（已使用默认配置继续）
            </div>
          )}
          {!generating && !error && (
            <>
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="form-label">系统提示词</label>
                <textarea className="form-input" rows={8} value={cfg.systemPrompt}
                  onChange={e => setCfg(p => ({ ...p, systemPrompt: e.target.value }))}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn-primary" onClick={() => setStep(3)}>下一步：微调</button>
                <button className="btn btn-ghost" onClick={() => setStep(1)}>返回选择</button>
              </div>
            </>
          )}
          {!generating && !error && cfg.role && (
            <button className="btn btn-primary" onClick={generateConfig}
              style={{ marginTop: 12 }} disabled={generating}>
              {llmOnline ? '🔄 重新生成' : '⏳ LLM 离线，使用默认配置'}
            </button>
          )}
        </div>
      )}

      {/* ── Step 3: 微调 ── */}
      {step === 3 && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>微调配置</div>

          {/* 名称 / 图标 / 描述 */}
          <div className="form-row" style={{ marginBottom: 12 }}>
            <div className="form-group">
              <label className="form-label">名称</label>
              <input className="form-input" value={cfg.name}
                onChange={e => setCfg(p => ({ ...p, name: e.target.value }))} placeholder="人格名称" />
            </div>
            <div className="form-group">
              <label className="form-label">图标</label>
              <input className="form-input" value={cfg.icon}
                onChange={e => setCfg(p => ({ ...p, icon: e.target.value }))} placeholder="🤖" style={{ width: 60 }} />
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="form-label">描述</label>
            <input className="form-input" value={cfg.desc}
              onChange={e => setCfg(p => ({ ...p, desc: e.target.value }))} placeholder="简要描述…" />
          </div>

          {/* 技能开关 */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>🔧 技能配置</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ALL_SKILL_IDS.map(skillId => (
                <button key={skillId}
                  onClick={() => toggleSkill(skillId)}
                  style={{
                    padding: '4px 10px', borderRadius: 'var(--radius)', fontSize: 12,
                    border: `1px solid ${cfg.skills.includes(skillId) ? 'var(--accent-500)' : 'var(--border-light)'}`,
                    background: cfg.skills.includes(skillId) ? 'var(--accent-50)' : 'var(--surface-0)',
                    cursor: 'pointer', fontWeight: cfg.skills.includes(skillId) ? 700 : 400,
                  }}>
                  {skillId}
                </button>
              ))}
            </div>
          </div>

          {/* Loop 预设开关 */}
          {cfg.loopPresets.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>🔄 Loop 预设</div>
              {cfg.loopPresets.map((preset, idx) => (
                <div key={preset.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', marginBottom: 4,
                    background: 'var(--surface-50)', borderRadius: 'var(--radius)', fontSize: 12 }}>
                  <button onClick={() => toggleLoopPreset(idx)}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 16, padding: 0 }}>
                    {preset.trigger.enabled ? '✅' : '⬜'}
                  </button>
                  <div>
                    <strong>{preset.name}</strong>
                    <div style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>{preset.description || preset.goal}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 系统提示词（可编辑） */}
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="form-label">系统提示词</label>
            <textarea className="form-input" rows={5} value={cfg.systemPrompt}
              onChange={e => setCfg(p => ({ ...p, systemPrompt: e.target.value }))}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }} />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={confirmCreate}>✅ 确认创建</button>
            <button className="btn btn-ghost" onClick={() => setStep(2)}>返回生成</button>
          </div>
        </div>
      )}

      {/* ── Step 4: 完成 ── */}
      {step === 4 && (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>专攻 Agent 已创建</div>
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, marginBottom: 16 }}>
            「{cfg.name}」已激活，{cfg.skills.length} 个技能已启用
            {cfg.loopPresets.filter(p => p.trigger.enabled).length > 0 &&
              `，${cfg.loopPresets.filter(p => p.trigger.enabled).length} 个 Loop 预设已注册`}
          </div>
          <button className="btn btn-primary" onClick={onClose}>完成</button>
        </div>
      )}
    </div>
  )
}