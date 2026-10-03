// ============================================================
// OnboardingWizard.tsx — Lumina Life 首次运行引导向导 (v1.0)
//
// 只对第一次运行的新用户展示，完成后写入 firstRun=false
// ============================================================

import React, { useState } from 'react'
import { useStore } from '../stores/appStore'
import { persistLLMConfig } from '../services/llmPersist'

type StepId = 'welcome' | 'llm' | 'personality' | 'done'

interface StepConfig {
  id: StepId
  title: string
  subtitle: string
}

const STEPS: StepConfig[] = [
  { id: 'welcome',     title: '欢迎来到 Lumina Life 🌸',      subtitle: '你的桌面不再孤单' },
  { id: 'llm',         title: '连接你的 AI 大脑 🧠',           subtitle: 'Lumina 需要一个大语言模型才能思考' },
  { id: 'personality', title: '选择 Lumina 的性格 🎭',         subtitle: '你希望她以什么风格陪伴你？' },
  { id: 'done',        title: '一切就绪！✨',                   subtitle: '准备开始你和 Lumina 的故事' },
]

// ─── 预设 LLM 配置 ─────────────────────────────────────
const PRESET_LLMS = [
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen（免费在线）',
    icon: '🎯',
    desc: '无需注册、无需 Key，点击即可开始（推荐新用户）',
    badge: '免费·开箱即用',
    config: { provider: 'opencode-zen', baseUrl: 'https://opencode.ai/zen/v1', model: 'deepseek-v4-flash-free', apiKey: 'public' },
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    icon: '🖥️',
    desc: '本地运行，完全免费，保护隐私',
    badge: '离线·免费',
    config: { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  },
  {
    id: 'ollama',
    name: 'Ollama',
    icon: '🦙',
    desc: '本地运行，完全免费，可「自动检测」已装模型',
    badge: '离线·免费',
    config: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '🌊',
    desc: '超低价，中文理解能力强，速度快',
    badge: '云端·超低价',
    config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    needApiKey: true,
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    icon: '💎',
    desc: '多模型聚合平台，送免费额度',
    badge: '云端·有免费额度',
    config: { provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    needApiKey: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '🤖',
    desc: 'GPT-4o 最强模型，适合所有场景',
    badge: '云端·最强',
    config: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    needApiKey: true,
  },
]

// ─── 性格选项 ──────────────────────────────────────────
const PERSONALITIES = [
  {
    id: 'default',
    name: '🐱 活泼可爱',
    desc: '温暖、活泼、偶尔犯迷糊的猫娘——默认的 Lumina',
    systemPrompt: '你是 Lumina，温暖可爱、偶尔迷糊的陪伴型 AI 猫娘。活泼但不幼稚，温暖但不啰嗦。',
  },
  {
    id: 'professional',
    name: '💼 干练高效',
    desc: '专业、高效、直奔主题的工作助手',
    systemPrompt: '你是 Lumina，专业高效的 AI 工作助手。语言简洁直接，注重效率，少闲聊多做事。',
  },
  {
    id: 'casual',
    name: '☕ 温暖随和',
    desc: '像老朋友一样随和亲切，适合日常闲聊放松',
    systemPrompt: '你是 Lumina，温暖随和的聊天伙伴。像朋友一样自然交流，不给压力。',
  },
  {
    id: 'creative',
    name: '🎨 创意发散',
    desc: '脑洞大开，适合头脑风暴和创意写作',
    systemPrompt: '你是 Lumina，发散思维的创意助手。鼓励非常规思路，善于联想和类比。',
  },
]

// ═══════════════════════════════════════════════════════════
// 步骤组件
// ═══════════════════════════════════════════════════════════

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div style={{ textAlign: 'center', padding: '24px 16px' }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>🌸</div>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8, color: 'var(--text-primary)' }}>
        欢迎来到 Lumina Life
      </h2>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, maxWidth: 340, margin: '0 auto 20px' }}>
        我是 <strong>Lumina 🐱</strong>，你的 AI 桌面伙伴。<br />
        这是我的队友 <strong>热茶 🍵</strong> 和 <strong>Yak 📊</strong>。<br /><br />
        我们会一起陪你聊天、帮你做事、记着你的事。<br />
        先花 <strong>30 秒</strong>设置一下吧！
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 8, fontSize: 28 }}>
        <span>🐱</span><span>🍵</span><span>📊</span>
      </div>
      <button onClick={onNext} className="onboarding-btn-primary">
        开始设置 →
      </button>
    </div>
  )
}

function LLMStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [selected, setSelected] = useState<string>('opencode-zen')
  const [apiKey, setApiKey] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [found, setFound] = useState<any[]>([])
  const [detectMsg, setDetectMsg] = useState('')
  const setLLMConfig = useStore((s) => s.setLLMConfig)

  // 把选择写入前端 store，并尽力持久化到后端 ProviderManager（best-effort，不阻塞引导）
  const persist = async (providerId: string, baseUrl: string, model: string, key: string) => {
    setLLMConfig({ provider: providerId, baseUrl, model, apiKey: key })
    try {
      await window.luminaAPI?.providerSaveConfig?.(providerId, {
        baseUrl, apiKey: key, model, enabled: true, timeout: 600, maxContextTokens: 256000,
      })
      await window.luminaAPI?.providerSetActive?.(providerId)
    } catch { /* 后端暂不可用时忽略，用户可在设置页再配置 */ }
  }

  const handleConfirm = async () => {
    const preset = PRESET_LLMS.find(p => p.id === selected)
    if (preset) {
      const key = (preset as any).config.apiKey || (preset.needApiKey ? apiKey : '')
      await persist(preset.config.provider, preset.config.baseUrl, preset.config.model, key)
    }
    onNext()
  }

  const detectLocal = async () => {
    setDetecting(true); setDetectMsg(''); setFound([])
    try {
      const r = await window.luminaAPI?.providerDiscoverLocal?.()
      if (r?.found?.length) {
        setFound(r.found)
        setDetectMsg('检测到本地模型，点右侧「使用」即可（无需 Key）。')
      } else {
        setDetectMsg('暂未检测到本地模型。可用上面的「免费在线」，或先安装 Ollama 后重新检测。')
      }
    } catch {
      setDetectMsg('检测失败，可直接选择「免费在线」继续。')
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
        setDetectMsg('⚠️ 接入成功但保存失败：' + saved.error + '（重启后会失效）')
        return
      }
      onNext()
    } else { setDetectMsg('接入失败：' + (r?.error || '未知错误')) }
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
            <span style={{ fontSize: 24 }}>{p.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{p.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{p.desc}</div>
            </div>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
              background: 'var(--accent-100)', color: 'var(--accent-600)',
              whiteSpace: 'nowrap',
            }}>{p.badge}</span>
          </div>
        ))}
      </div>

      {/* 自动检测本地模型 */}
      <button onClick={detectLocal} disabled={detecting}
        style={{
          width: '100%', padding: '8px 12px', borderRadius: 8, marginBottom: 8,
          border: '1.5px dashed var(--accent-500)', background: 'var(--accent-50)',
          color: 'var(--accent-600)', fontSize: 12, fontWeight: 600, cursor: detecting ? 'wait' : 'pointer',
        }}>
        {detecting ? '⏳ 正在检测 Ollama / LM Studio…' : '🔎 自动检测本地模型（已安装就一键接入）'}
      </button>
      {detectMsg && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
          {detectMsg}
          {found.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
              {found.map((f) => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)' }}>
                    {f.label} · 推荐 {f.recommendedModel}（{f.models.length} 个）
                  </span>
                  <button onClick={() => useFound(f)} style={{ padding: '2px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer' }}>
                    使用
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {PRESET_LLMS.find(p => p.id === selected)?.needApiKey && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            输入 API Key（可在设置页面随时修改）
          </div>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder="sk-..."
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-medium)',
              fontSize: 13, outline: 'none', background: 'var(--surface-0)',
            }} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button onClick={onSkip} className="onboarding-btn-secondary">跳过</button>
        <button onClick={handleConfirm} className="onboarding-btn-primary" style={{ flex: 1 }}>
          {selected === 'opencode-zen' ? '免费开始（无需 Key）' : '确认并继续'}
        </button>
      </div>
    </div>
  )
}

function PersonalityStep({ onNext }: { onNext: () => void }) {
  const [selected, setSelected] = useState<string>('default')
  const setAgentConfig = useStore((s) => s.setAgentConfig)

  const handleConfirm = () => {
    const p = PERSONALITIES.find(pp => pp.id === selected)
    if (p) {
      setAgentConfig({ systemPrompt: p.systemPrompt, customPersonas: [] })
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
            <div style={{ fontSize: 28, marginBottom: 4 }}>{p.name.split(' ')[0]}</div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{p.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{p.desc}</div>
          </div>
        ))}
      </div>
      <button onClick={handleConfirm} className="onboarding-btn-primary" style={{ width: '100%' }}>
        ✨ 开始使用！
      </button>
    </div>
  )
}

function DoneStep({ onFinish }: { onFinish: () => void }) {
  return (
    <div style={{ textAlign: 'center', padding: '32px 16px' }}>
      <div style={{ fontSize: 72, marginBottom: 12, animation: 'pulse 2s ease-in-out infinite' }}>🎉</div>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>一切准备就绪！</h2>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 24 }}>
        Lumina 🐱、热茶 🍵 和 Yak 📊 已经准备好为你工作。<br />
        现在去跟她说第一句话吧！
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', fontSize: 14, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        <span>💡 试试说 "你好"</span>
        <span>·</span>
        <span>🔧 随时在设置里改配置</span>
      </div>
      <button onClick={onFinish} className="onboarding-btn-primary">
        🚀 开始和 Lumina 聊天！
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════

export default function OnboardingWizard() {
  const [stepIndex, setStepIndex] = useState(0)
  const firstRun = useStore((s) => s.firstRun)
  const completeOnboarding = useStore((s) => s.completeOnboarding)

  // 已完成引导 → 不渲染
  if (!firstRun) {return null}

  const current = STEPS[stepIndex]
  const total = STEPS.length
  const isLast = stepIndex >= total - 1

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
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{current.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{current.subtitle}</div>
          </div>
          <button onClick={skipAll} style={{
            fontSize: 12, color: 'var(--text-disabled)', cursor: 'pointer',
            padding: '4px 8px', borderRadius: 6, border: 'none', background: 'transparent',
            fontFamily: 'inherit',
          }}>跳过引导</button>
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
          {current.id === 'welcome' && <WelcomeStep onNext={goNext} />}
          {current.id === 'llm' && (
            <LLMStep onNext={goNext} onSkip={skipAll} />
          )}
          {current.id === 'personality' && <PersonalityStep onNext={handleFinish} />}
          {current.id === 'done' && <DoneStep onFinish={handleFinish} />}
        </div>

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
