// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// OnboardingWizard.tsx — Lumina Life 首次运行引导向导 (v1.0)
//
// 只对第一次运行的新用户展示，完成后写入 firstRun=false
//
// 🌐 2026-10-16：语言选择提升为「第一步」。
//    理由：向导本身有 6 屏文案，如果用户是英文用户，
//    却要先读完 5 屏中文才知道哪里能改语言 —— 这是最典型的
//    引导设计失误。先选语言，后面每一屏（以及整个界面）
//    立刻用所选语言渲染。
//    全部文案走 i18n（onboarding.* 命名空间），默认简体中文。
// ============================================================

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../stores/appStore'
import type { LLMConfig } from '../stores/appStore'
import { persistLLMConfig } from '../services/llmPersist'

/** onboarding 阶段 Python 缺失提示卡的「不再提醒」开关持久化 key */
const PYTHON_HINT_DISMISS_KEY = 'lumina_python_hint_dismissed'

interface OnboardingPythonStatus {
  healthy: boolean
  pythonPresent: boolean
  tts: boolean
  stt: boolean
  embedding: boolean
  message?: string
  docUrl?: string
}

type StepId = 'language' | 'welcome' | 'llm' | 'personality' | 'team' | 'done'

interface StepConfig {
  id: StepId
  titleKey: string
  subtitleKey: string
}

const STEPS: StepConfig[] = [
  { id: 'language',    titleKey: 'onboarding.step_language_title',    subtitleKey: 'onboarding.step_language_subtitle' },
  { id: 'welcome',     titleKey: 'onboarding.step_welcome_title',     subtitleKey: 'onboarding.step_welcome_subtitle' },
  { id: 'llm',         titleKey: 'onboarding.step_llm_title',         subtitleKey: 'onboarding.step_llm_subtitle' },
  { id: 'personality', titleKey: 'onboarding.step_personality_title', subtitleKey: 'onboarding.step_personality_subtitle' },
  { id: 'team',        titleKey: 'onboarding.step_team_title',        subtitleKey: 'onboarding.step_team_subtitle' },
  { id: 'done',        titleKey: 'onboarding.step_done_title',        subtitleKey: 'onboarding.step_done_subtitle' },
]

// ─── 团队成员元数据 ──────────────────────────────────────
/**
 * 【为什么要专门有这一步】
 *
 * 2026-10-04 发布前评测查到一个 P1 缺陷：引导只有 4 步（welcome/llm/personality/done），
 * **全程不提及三 Agent 团队**，而 `agents/yak/agent.json` / `agents/recha/agent.json`
 * 里的模型名还是占位符 `your-model-name`。
 *
 * 后果很具体：`getConfiguredMembers()` 判定「已配置」的依据就是那份 agent.json，
 * 所以新用户走完引导后，系统提示词里注入的团队状态表是
 * 「❌ 未配置 LLM，调用会失败」——
 * **他体验到的根本不是三 Agent 产品，而是一个普通助手。**
 *
 * 招牌能力默认不可见，等于没有招牌能力。
 * 这一步的作用不是配置，是**告知**：让用户知道背后有人，以及他们默认会用同一个模型。
 */
const TEAM_MEMBERS = [
  {
    id: 'yak',
    nameKey: 'onboarding.agent_yak',
    icon: '🐍',
    roleKey: 'onboarding.team_yak_role',
    dutiesKey: 'onboarding.team_yak_duties',
    noteKey: 'onboarding.team_yak_note',
  },
  {
    id: 'recha',
    nameKey: 'onboarding.agent_recha',
    icon: '🍵',
    roleKey: 'onboarding.team_recha_role',
    dutiesKey: 'onboarding.team_recha_duties',
    noteKey: 'onboarding.team_recha_note',
  },
]

// ─── 预设 LLM 配置 ─────────────────────────────────────
// logo：复用 public/providers/ 下已打包的厂商 logo（与设置页 SettingsLLM 同一套资源）。
//   没有 logo 的退回 icon 里的 emoji。
const PRESET_LLMS = [
  {
    id: 'lmstudio',
    name: 'LM Studio',
    icon: '🖥️',
    logo: 'providers/lmstudio.ico',
    descKey: 'onboarding.llm_lmstudio_desc',
    badgeKey: 'onboarding.llm_badge_offline',
    config: { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  },
  {
    id: 'ollama',
    name: 'Ollama',
    icon: '🦙',
    logo: 'providers/ollama.svg',
    descKey: 'onboarding.llm_ollama_desc',
    badgeKey: 'onboarding.llm_badge_offline',
    config: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '🌊',
    logo: 'providers/deepseek.svg',
    descKey: 'onboarding.llm_deepseek_desc',
    badgeKey: 'onboarding.llm_badge_cheap',
    config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    needApiKey: true,
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    icon: '💎',
    logo: 'providers/siliconflow.ico',
    descKey: 'onboarding.llm_siliconflow_desc',
    badgeKey: 'onboarding.llm_badge_free_tier',
    config: { provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    needApiKey: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '🤖',
    logo: 'providers/openai.svg',
    descKey: 'onboarding.llm_openai_desc',
    badgeKey: 'onboarding.llm_badge_strongest',
    config: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    needApiKey: true,
  },
  {
    id: 'custom',
    name: '自定义',
    icon: '⚙️',
    descKey: 'onboarding.llm_custom_desc',
    badgeKey: 'onboarding.llm_badge_custom',
    config: { provider: 'custom', baseUrl: '', model: '' },
    needApiKey: true,
  },
]

/* ── 厂商 logo 缩略图 ──
 * 与设置页 SettingsLLM.ProviderLogo 同一套做法：logo 多为黑色单色图形，
 * 放白底小方块里，浅色/深色主题下都清晰；图裂了（缺文件/格式不支持）
 * 自动退回 emoji，不留破图。
 */
function PresetLogo({ logo, icon, size = 26 }: { logo?: string; icon: string; size?: number }) {
  const [broken, setBroken] = useState(false)
  if (logo && !broken) {
    return (
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setBroken(true)}
        style={{
          width: size, height: size, objectFit: 'contain', flexShrink: 0,
          background: '#fff', borderRadius: 6, padding: 2,
          border: '1px solid var(--border-light)',
        }}
      />
    )
  }
  return <span style={{ fontSize: 24, lineHeight: 1 }} aria-hidden>{icon}</span>
}

// ─── 性格选项 ──────────────────────────────────────────
const PERSONALITIES = [
  { id: 'default',      emoji: '🐱', nameKey: 'onboarding.personality_default_name',      descKey: 'onboarding.personality_default_desc',      spKey: 'onboarding.personality_default_sp' },
  { id: 'professional', emoji: '💼', nameKey: 'onboarding.personality_professional_name', descKey: 'onboarding.personality_professional_desc', spKey: 'onboarding.personality_professional_sp' },
  { id: 'casual',       emoji: '☕', nameKey: 'onboarding.personality_casual_name',       descKey: 'onboarding.personality_casual_desc',       spKey: 'onboarding.personality_casual_sp' },
  { id: 'creative',     emoji: '🎨', nameKey: 'onboarding.personality_creative_name',     descKey: 'onboarding.personality_creative_desc',     spKey: 'onboarding.personality_creative_sp' },
]

// ═══════════════════════════════════════════════════════════
// 步骤组件
// ═══════════════════════════════════════════════════════════

/**
 * 🌐 第 1 步：语言选择
 *
 * 卡片式双选（CN / US），与「设置 → 语言」保持同一套视觉语言，
 * 但这里必须**中英双语同时标注**：此刻用户还没选语言，
 * 用单语写等于用他可能看不懂的语言去问他「你看得懂哪种语言」。
 */
function LanguageStep({ onNext }: { onNext: () => void }) {
  const { t, i18n } = useTranslation()
  const current = (i18n.language || 'zh-CN').startsWith('zh') ? 'zh-CN' : 'en-US'

  const options = [
    {
      id: 'zh-CN' as const,
      code: 'CN',
      nameKey: 'onboarding.lang_zh_name',
      subKey: 'onboarding.lang_zh_sub',
      descKey: 'onboarding.lang_zh_desc',
    },
    {
      id: 'en-US' as const,
      code: 'US',
      nameKey: 'onboarding.lang_en_name',
      subKey: 'onboarding.lang_en_sub',
      descKey: 'onboarding.lang_en_desc',
    },
  ]

  return (
    <div style={{ padding: '16px 12px' }}>
      <div style={{ display: 'flex', gap: 10 }}>
        {options.map(opt => {
          const active = current === opt.id
          return (
            <button
              key={opt.id}
              onClick={() => i18n.changeLanguage(opt.id)}
              aria-pressed={active}
              style={{
                flex: 1, padding: '16px 10px', borderRadius: 10, cursor: 'pointer',
                border: `2px solid ${active ? 'var(--accent-500)' : 'var(--border-light)'}`,
                background: active ? 'var(--accent-50)' : 'var(--surface-0)',
                transition: 'all 0.2s', textAlign: 'center', fontFamily: 'inherit',
              }}
            >
              <div style={{
                fontSize: 22, fontWeight: 800, letterSpacing: 1, lineHeight: 1.2,
                color: active ? 'var(--accent-600)' : 'var(--text-tertiary)',
              }}>{opt.code}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginTop: 4 }}>
                {t(opt.nameKey)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>
                {t(opt.subKey)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3 }}>
                {t(opt.descKey)}
              </div>
              {active && (
                <div style={{ marginTop: 8, fontSize: 10, fontWeight: 600, color: 'var(--accent-600)' }}>
                  {t('onboarding.lang_active')}
                </div>
              )}
            </button>
          )
        })}
      </div>

      <div style={{
        marginTop: 14, padding: 10, borderRadius: 8,
        background: 'var(--accent-50)', border: '1px solid var(--accent-100)',
        fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.6,
      }}>
        {t('onboarding.lang_note')}
      </div>

      <button onClick={onNext} className="onboarding-btn-primary" style={{ width: '100%', marginTop: 16 }}>
        {t('onboarding.continue')} →
      </button>
    </div>
  )
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation()
  return (
    <div style={{ textAlign: 'center', padding: '24px 16px' }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>🌸</div>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8, color: 'var(--text-primary)' }}>
        {t('onboarding.welcome_heading')}
      </h2>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, maxWidth: 340, margin: '0 auto 20px' }}>
        {t('onboarding.welcome_line1_pre')}<strong>{t('onboarding.agent_lumina')} 🐱</strong>{t('onboarding.welcome_line1_post')}<br />
        {t('onboarding.welcome_line2_pre')}<strong>{t('onboarding.agent_recha')} 🍵</strong>{t('onboarding.welcome_line2_mid')}<strong>{t('onboarding.agent_yak')} 📊</strong>{t('onboarding.welcome_line2_post')}<br /><br />
        {t('onboarding.welcome_line3')}<br />
        {t('onboarding.welcome_line4_pre')}<strong>{t('onboarding.welcome_line4_strong')}</strong>{t('onboarding.welcome_line4_post')}
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 8, fontSize: 28 }}>
        <span>🐱</span><span>🍵</span><span>📊</span>
      </div>
      <button onClick={onNext} className="onboarding-btn-primary">
        {t('onboarding.welcome_cta')}
      </button>
    </div>
  )
}

function LLMStep({ onNext, onSkip, onBack }: { onNext: () => void; onSkip: () => void; onBack: () => void }) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string>('lmstudio')
  const [apiKey, setApiKey] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [found, setFound] = useState<any[]>([])
  const [detectMsg, setDetectMsg] = useState('')
  const setLLMConfig = useStore((s) => s.setLLMConfig)

  // 把选择写入前端 store，并尽力持久化到后端 ProviderManager（best-effort，不阻塞引导）
  const persist = async (providerId: string, baseUrl: string, model: string, key: string) => {
    setLLMConfig({ provider: providerId, baseUrl, model, apiKey: key })
    try {
      await window.luminaAPI?.providerSaveConfig?.(providerId, {
        baseUrl, apiKey: key, model, enabled: true, timeout: 600,
        // 🔧 2026-10-07：填 0（自动检测）而不是硬编码 256000。
        //   引导流程对**本地模型**同样会走到这里，256K 会让小模型被当成大窗口用
        //   → 不裁剪历史 → 首字从秒级变分钟级。0 交给 runner 走服务端真相。
        maxContextTokens: 0,
      })
      await window.luminaAPI?.providerSetActive?.(providerId)
    } catch { /* 后端暂不可用时忽略，用户可在设置页再配置 */ }
  }

  const handleConfirm = async () => {
    const preset = PRESET_LLMS.find(p => p.id === selected)
    if (preset) {
      let baseUrl = preset.config.baseUrl
      let model = preset.config.model
      if (selected === 'custom') {
        const trimmedUrl = customBaseUrl.trim()
        const trimmedModel = customModel.trim()
        if (!trimmedUrl || !trimmedModel) {
          setDetectMsg(t('onboarding.llm_custom_need_fields'))
          return
        }
        baseUrl = trimmedUrl
        model = trimmedModel
      }
      const key = (preset as any).config.apiKey || (preset.needApiKey ? apiKey : '')
      await persist(preset.config.provider, baseUrl, model, key)
    }
    onNext()
  }

  const detectLocal = async () => {
    setDetecting(true); setDetectMsg(''); setFound([])
    try {
      const r = await window.luminaAPI?.providerDiscoverLocal?.()
      if (r?.found?.length) {
        setFound(r.found)
        setDetectMsg(t('onboarding.llm_detect_found'))
      } else {
        setDetectMsg(t('onboarding.llm_detect_none'))
      }
    } catch {
      setDetectMsg(t('onboarding.llm_detect_failed'))
    } finally { setDetecting(false) }
  }

  const useFound = async (f: any) => {
    const r = await window.luminaAPI?.providerApplyLocal?.({ id: f.id, baseUrl: f.baseUrl, model: f.recommendedModel })
    if (r?.success) {
      // 🔧 修复（新手最关键的路径）：原先只 setLLMConfig（纯内存）就 onNext()，
      // 新用户第一次配置「看起来成功」但**重启即丢**，
      // 之后会表现为「配置不生效 / 老是有个固定的东西」。
      // 这里必须落盘，才能真正写进 lumina-providers.json。
      const pid = r.id === 'ollama' ? 'ollama' : 'lmstudio'
      setLLMConfig({ provider: pid, baseUrl: r.baseUrl || '', model: r.model || '', apiKey: 'local' })
      const saved = await persistLLMConfig(pid, {
        baseUrl: r.baseUrl || '',
        model: r.model || '',
        apiKey: 'local',
      })
      if (!saved.ok) {
        // 落盘失败必须拦下来告知，否则用户会带着「假成功」走完引导
        setDetectMsg(t('onboarding.llm_save_failed', { error: saved.error }))
        return
      }
      onNext()
    } else { setDetectMsg(t('onboarding.llm_apply_failed', { error: r?.error || t('common.unknown_error') })) }
  }

  return (
    <div style={{ padding: '16px 12px' }}>
      <div style={{ marginBottom: 12 }}>
        {PRESET_LLMS.map(p => (
          <div key={p.id} onClick={() => setSelected(p.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px', borderRadius: 10, marginBottom: 8, cursor: 'pointer',
              border: selected === p.id ? '2px solid var(--accent-500)' : '1px solid var(--border-medium)',
              background: selected === p.id ? 'var(--accent-50)' : 'var(--surface-0)',
              transition: 'all 0.15s',
            }}>
            <PresetLogo logo={(p as any).logo} icon={p.icon} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{p.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t(p.descKey)}</div>
            </div>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
              background: 'var(--accent-100)', color: 'var(--accent-600)',
              whiteSpace: 'nowrap',
            }}>{t(p.badgeKey)}</span>
          </div>
        ))}
      </div>

      {/* 自动检测本地模型 */}
      <button onClick={detectLocal} disabled={detecting}
        style={{
          width: '100%', padding: '8px 12px', borderRadius: 8, marginBottom: 8,
          border: '1.5px dashed var(--accent-500)', background: 'var(--accent-50)',
          color: 'var(--accent-600)', fontSize: 12, fontWeight: 600, cursor: detecting ? 'wait' : 'pointer',
          fontFamily: 'inherit',
        }}>
        {detecting ? t('onboarding.llm_detecting') : t('onboarding.llm_detect_btn')}
      </button>
      {detectMsg && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
          {detectMsg}
          {found.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
              {found.map((f) => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)' }}>
                    {t('onboarding.llm_found_item', { label: f.label, model: f.recommendedModel, count: f.models.length })}
                  </span>
                  <button onClick={() => useFound(f)} style={{ padding: '2px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
                    {t('onboarding.llm_use')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selected === 'custom' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {t('onboarding.llm_base_url_label')}
          </div>
          <input value={customBaseUrl} onChange={e => setCustomBaseUrl(e.target.value)}
            placeholder="https://your-endpoint.com/v1"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-medium)',
              fontSize: 13, outline: 'none', background: 'var(--surface-0)',
            }} />
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, marginTop: 8 }}>
            {t('onboarding.llm_model_label')}
          </div>
          <input value={customModel} onChange={e => setCustomModel(e.target.value)}
            placeholder="your-model-name"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-medium)',
              fontSize: 13, outline: 'none', background: 'var(--surface-0)',
            }} />
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 }}>
            {t('onboarding.llm_custom_hint')}
          </div>
        </div>
      )}

      {PRESET_LLMS.find(p => p.id === selected)?.needApiKey && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {t('onboarding.llm_api_key_label')}
          </div>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder={selected === 'custom' ? t('onboarding.llm_api_key_placeholder_custom') : 'sk-...'}
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-medium)',
              fontSize: 13, outline: 'none', background: 'var(--surface-0)',
            }} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button onClick={onBack} className="onboarding-btn-secondary">{t('onboarding.back')}</button>
        <button onClick={onSkip} className="onboarding-btn-secondary">{t('onboarding.skip_step')}</button>
        <button onClick={handleConfirm} className="onboarding-btn-primary" style={{ flex: 1 }}>
          {PRESET_LLMS.find(p => p.id === selected)?.needApiKey ? t('onboarding.confirm_continue') : t('onboarding.llm_start_free')}
        </button>
      </div>
    </div>
  )
}

function PersonalityStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string>('default')
  const setAgentConfig = useStore((s) => s.setAgentConfig)

  const handleConfirm = () => {
    const p = PERSONALITIES.find(pp => pp.id === selected)
    if (p) {
      setAgentConfig({ systemPrompt: t(p.spKey), customPersonas: [] })
    }
    onNext()
  }

  return (
    <div style={{ padding: '12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        {PERSONALITIES.map(p => (
          <div key={p.id} onClick={() => setSelected(p.id)}
            style={{
              padding: '12px', borderRadius: 10, cursor: 'pointer',
              border: selected === p.id ? '2px solid var(--accent-500)' : '1px solid var(--border-medium)',
              background: selected === p.id ? 'var(--accent-50)' : 'var(--surface-0)',
              textAlign: 'center', transition: 'all 0.15s',
            }}>
            <div style={{ fontSize: 28, marginBottom: 4 }}>{p.emoji}</div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{t(p.nameKey)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{t(p.descKey)}</div>
          </div>
        ))}
      </div>
      <button onClick={handleConfirm} className="onboarding-btn-primary" style={{ width: '100%' }}>
        {t('onboarding.personality_cta')}
      </button>
    </div>
  )
}

function TeamStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation()
  const llmConfig = useStore((s) => s.llmConfig)
  // 默认全开：让成员跟随主模型。这样开箱即用时团队就是活的。
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(TEAM_MEMBERS.map(m => [m.id, true])))
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>('')

  /**
   * 【为什么默认「跟随主模型」而不是让用户自己填】
   *
   * 新用户根本不知道该给三个 Agent 分别配什么模型，
   * 而且多填一次 Key 就多一次放弃的机会。
   * 现状是：主模型配好了，但两个 worker 还是占位符 → 团队是死的。
   * 所以这里直接把主模型配置复制给两个 worker —— 一行代码换回整个招牌能力。
   *
   * 失败不阻断引导：设置面板里随时能单独配，用户不该被一个配置卡死在向导里。
   */
  const handleConfirm = async () => {
    setBusy(true)
    setNotice('')
    const targets = TEAM_MEMBERS.filter(m => enabled[m.id])
    if (targets.length === 0) {
      setBusy(false)
      onNext()
      return
    }
    try {
      const results: string[] = []
      for (const m of targets) {
        const res: any = await window.luminaAPI?.agentLlmSetConfig?.(m.id, {
          provider: llmConfig.provider,
          model: llmConfig.model,
          endpoint: llmConfig.baseUrl,
          apiKey: llmConfig.apiKey,
          timeout: 600,
        })
        if (res && res.success === false) {
          results.push(`${t(m.nameKey)}：${res.error || t('common.unknown_error')}`)
        }
      }
      setNotice(results.length > 0
        ? t('onboarding.team_notice_partial', { list: results.join('；') })
        : t('onboarding.team_notice_ok', { count: targets.length, model: llmConfig.model }))
    } catch (e: any) {
      setNotice(t('onboarding.team_notice_error', { error: e?.message || e }))
    } finally {
      setBusy(false)
    }
    onNext()
  }

  return (
    <div style={{ padding: '12px' }}>
      <div style={{
        fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)',
        background: 'var(--surface-1)', borderRadius: 8, padding: '10px 12px', marginBottom: 12,
      }}>
        {t('onboarding.team_intro_pre')}<b>{t('onboarding.agent_lumina')} 🐱</b>{t('onboarding.team_intro_post')}
      </div>

      {TEAM_MEMBERS.map(m => (
        <div key={m.id} style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '10px 12px', marginBottom: 8, borderRadius: 10,
          border: '1px solid var(--border-medium)',
          background: enabled[m.id] ? 'var(--accent-50)' : 'var(--surface-0)',
          opacity: enabled[m.id] ? 1 : 0.55,
          transition: 'all 0.15s',
        }}>
          <div style={{ fontSize: 24, lineHeight: 1.2 }}>{m.icon}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{t(m.nameKey)}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t(m.roleKey)}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {t(m.dutiesKey)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3 }}>🔒 {t(m.noteKey)}</div>
          </div>
          <button
            onClick={() => setEnabled(e => ({ ...e, [m.id]: !e[m.id] }))}
            style={{
              flexShrink: 0, alignSelf: 'center',
              padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              fontSize: 11, fontFamily: 'inherit', fontWeight: 500,
              border: '1px solid var(--border-medium)',
              background: enabled[m.id] ? 'var(--accent-500)' : 'var(--surface-1)',
              color: enabled[m.id] ? '#fff' : 'var(--text-secondary)',
            }}>
            {enabled[m.id] ? t('onboarding.team_on') : t('onboarding.team_off')}
          </button>
        </div>
      ))}

      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', margin: '8px 0 12px', lineHeight: 1.6 }}>
        {t('onboarding.team_footnote')}
      </div>

      {notice && (
        <div style={{
          fontSize: 11, lineHeight: 1.6, marginBottom: 10, padding: '7px 10px', borderRadius: 6,
          // 用项目实际定义的调色板（--green-100/--yellow-100）而不是自造变量名。
          // 自造变量在 tsc 与 eslint 里都不会报错，只会在界面上静默失效 —— 这类 bug 很难查。
          background: notice.startsWith('✅') ? 'var(--green-100)' : 'var(--yellow-100)',
          color: 'var(--text-primary)',
        }}>{notice}</div>
      )}

      <button onClick={handleConfirm} disabled={busy} className="onboarding-btn-primary" style={{ width: '100%' }}>
        {busy ? t('onboarding.team_busy') : t('onboarding.confirm_continue')}
      </button>
    </div>
  )
}

/** 判定当前是否真的有一个「能用的模型」 */
function hasUsableModel(c: LLMConfig): boolean {
  // 占位符不算 —— 它是 ships-with 里的模板值，填了它但没真配的情况很常见
  if (!c?.model) {return false}
  if (/your-model-name|placeholder|^local-model$/i.test(c.model)) {return false}
  return true
}

function DoneStep({ onFinish, onBack }: { onFinish: () => void; onBack: () => void }) {
  const { t } = useTranslation()
  const llmConfig = useStore((s) => s.llmConfig)
  const ready = hasUsableModel(llmConfig)

  // 【为什么要在这里拦住】
  // 引导的最后一屏原本无条件显示「一切准备就绪」，但**它从不校验是否真有模型**。
  // 于是一个没配 Key、也没装本地模型的用户可以走完全部 5 步，
  // 看到 🎉 和「开始和 Lumina 聊天」，然后对着一个永远不会回话的应用。
  //
  // 这是最糟糕的一类 onboarding 失败：用户以为是自己配错了，
  // 于是反复重装、反复配 Key，而真实原因（压根没模型）没人告诉他。
  //
  // 注意：这里**不阻断**，只说清真相并给一条回路 ——
  // 硬拦住不让继续反而会让人以为软件坏了。
  if (!ready) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 16px' }}>
        <div style={{ fontSize: 48, marginBottom: 10 }}>🤔</div>
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>{t('onboarding.done_need_model_title')}</h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: 18 }}>
          {t('onboarding.done_need_model_body_1')}<br />
          {t('onboarding.done_need_model_body_2_pre')}<b>{t('onboarding.done_need_model_body_2_free')}</b>{t('onboarding.done_need_model_body_2_mid')}<b>{t('onboarding.done_need_model_body_2_local')}</b>{t('onboarding.done_need_model_body_2_post')}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 20 }}>
          <button onClick={onBack} className="onboarding-btn-secondary">{t('onboarding.done_back_to_llm')}</button>
          <button onClick={onFinish} className="onboarding-btn-primary">{t('onboarding.done_skip_later')}</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ textAlign: 'center', padding: '32px 16px' }}>
      <div style={{ fontSize: 72, marginBottom: 12, animation: 'pulse 2s ease-in-out infinite' }}>🎉</div>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>{t('onboarding.done_ready_title')}</h2>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 24 }}>
        {t('onboarding.done_ready_body_pre')}{llmConfig.model}{t('onboarding.done_ready_body_post')}
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', fontSize: 14, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        <span>{t('onboarding.done_tip_try')}</span>
        <span>·</span>
        <span>{t('onboarding.done_tip_settings')}</span>
      </div>
      <button onClick={onFinish} className="onboarding-btn-primary">
        {t('onboarding.done_cta')}
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════

export default function OnboardingWizard() {
  const { t } = useTranslation()
  const [stepIndex, setStepIndex] = useState(0)
  const firstRun = useStore((s) => s.firstRun)
  const completeOnboarding = useStore((s) => s.completeOnboarding)

  // 🐍 v0.1: 首次启动检测 Python 是否存在 —— 缺失时提示「语音/本地向量不可用」。
  //   只在 onboarding 期间查一次，不阻断引导。
  const [pyStatus, setPyStatus] = useState<OnboardingPythonStatus | null>(null)
  const [pyDismissed, setPyDismissed] = useState<boolean>(() => {
    try {return localStorage.getItem(PYTHON_HINT_DISMISS_KEY) === '1'} catch {return false}
  })

  useEffect(() => {
    if (!firstRun) {return}
    const api = window.luminaAPI as any
    if (!api?.pythonGetStatus) {return}
    let cancelled = false
    api.pythonGetStatus().then((s: OnboardingPythonStatus) => {
      if (!cancelled) {setPyStatus(s)}
    }).catch(() => { /* 主进程未就绪时静默 */ })
    return () => {cancelled = true}
  }, [firstRun])

  const togglePyDismissed = () => {
    const next = !pyDismissed
    setPyDismissed(next)
    try {localStorage.setItem(PYTHON_HINT_DISMISS_KEY, next ? '1' : '0')} catch { /* 忽略 */ }
  }

  // 已完成引导 → 不渲染
  if (!firstRun) {return null}

  const current = STEPS[stepIndex]
  const total = STEPS.length

  const goNext = () => {
    if (stepIndex < total - 1) {
      setStepIndex(i => i + 1)
    }
  }

  const skipAll = () => {
    completeOnboarding()
  }

  const handleFinish = () => {
    completeOnboarding()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.4)',
      backdropFilter: 'blur(4px)',
    }}>
      {/* 引导卡片 */}
      <div style={{
        background: 'var(--surface-0)',
        borderRadius: 16,
        boxShadow: '0 24px 48px rgba(0,0,0,0.2)',
        width: 420, maxWidth: '90vw',
        overflow: 'hidden',
        animation: 'fadeInUp 0.3s ease',
      }}>
        {/* 标题栏 */}
        <div style={{
          padding: '16px 20px 0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{t(current.titleKey)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{t(current.subtitleKey)}</div>
          </div>
          <button onClick={skipAll} style={{
            fontSize: 12, color: 'var(--text-disabled)', cursor: 'pointer',
            padding: '4px 8px', borderRadius: 6, border: 'none', background: 'transparent',
            fontFamily: 'inherit',
          }}>{t('onboarding.skip')}</button>
        </div>

        {/* 进度条 */}
        <div style={{ padding: '12px 20px 0' }}>
          <div style={{ height: 3, borderRadius: 2, background: 'var(--surface-200)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 2,
              background: 'linear-gradient(90deg, var(--accent-400), var(--accent-600))',
              width: `${((stepIndex + 1) / total) * 100}%`,
              transition: 'width 0.4s ease',
            }} />
          </div>
        </div>

        {/* 内容区 — key 随 step 变化触发重新挂载 + 淡入动画 */}
        <div key={stepIndex} style={{
          minHeight: 220,
          animation: 'fadeInUp 0.35s ease',
        }}>
          {current.id === 'language' && <LanguageStep onNext={goNext} />}
          {current.id === 'welcome' && <WelcomeStep onNext={goNext} />}
          {current.id === 'llm' && (
            <LLMStep
              onNext={goNext}
              onSkip={skipAll}
              onBack={() => setStepIndex(i => Math.max(0, i - 1))}
            />
          )}
          {current.id === 'personality' && <PersonalityStep onNext={goNext} />}
          {current.id === 'team' && <TeamStep onNext={goNext} />}
          {current.id === 'done' && (
            <DoneStep
              onFinish={handleFinish}
              onBack={() => setStepIndex(i => Math.max(0, i - 3))}
            />
          )}
        </div>

        {/* 🐍 v0.1: Python 缺失提示卡 —— 仅在 pythonPresent=false 且未勾选不再提醒时显示 */}
        {pyStatus && !pyStatus.pythonPresent && !pyDismissed && (
          <div style={{
            margin: '0 20px', padding: '10px 12px', borderRadius: 10,
            background: 'var(--yellow-100)', border: '1px solid var(--yellow-300)',
            fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-primary)',
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              ⚠️ {t('onboarding.python_hint_title')}
            </div>
            <div style={{ marginBottom: 6 }}>
              {t('onboarding.python_hint_body')}
            </div>
            {pyStatus.docUrl && (
              <button
                onClick={() => window.luminaAPI?.openExternal?.(pyStatus.docUrl as string)}
                style={{
                  padding: '3px 10px', borderRadius: 6, cursor: 'pointer', marginBottom: 6,
                  border: '1px solid var(--border-medium)', background: 'var(--surface-0)',
                  color: 'var(--accent-600)', fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                }}
              >
                {t('onboarding.python_hint_doc')} ↗
              </button>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, userSelect: 'none' }}>
              <input type="checkbox" checked={pyDismissed} onChange={togglePyDismissed} />
              {t('onboarding.python_hint_dismiss')}
            </label>
          </div>
        )}

        {/* 底部页码 */}
        <div style={{
          padding: '12px 20px',
          display: 'flex', justifyContent: 'center', gap: 6,
        }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{
              width: 6, height: 6, borderRadius: 3,
              background: i === stepIndex ? 'var(--accent-500)' : 'var(--border-light)',
              transition: 'all 0.2s',
            }} />
          ))}
        </div>
      </div>
    </div>
  )
}
