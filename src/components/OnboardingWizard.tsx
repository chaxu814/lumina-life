// ============================================================
// OnboardingWizard.tsx — Lumina Life 首次运行引导向导 (v1.0)
//
// 只对第一次运行的新用户展示，完成后写入 firstRun=false
// ============================================================

import React, { useState } from 'react'
import { useStore } from '../stores/appStore'
import type { LLMConfig } from '../stores/appStore'
import { persistLLMConfig } from '../services/llmPersist'

type StepId = 'welcome' | 'llm' | 'personality' | 'team' | 'done'

interface StepConfig {
  id: StepId
  title: string
  subtitle: string
}

const STEPS: StepConfig[] = [
  { id: 'welcome',     title: '欢迎来到 Lumina Life 🌸',      subtitle: '你的桌面不再孤单' },
  { id: 'llm',         title: '连接你的 AI 大脑 🧠',           subtitle: 'Lumina 需要一个大语言模型才能思考' },
  { id: 'personality', title: '选择 Lumina 的性格 🎭',         subtitle: '你希望她以什么风格陪伴你？' },
  { id: 'team',        title: 'Lumina 背后的团队 👥',           subtitle: '她不是一个人 —— 还有两位你看不见的同事' },
  { id: 'done',        title: '一切就绪！✨',                   subtitle: '准备开始你和 Lumina 的故事' },
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
    name: 'Yak',
    icon: '🐍',
    role: '代码工程师',
    duties: ['写代码', '调试 bug', '重构', '跑测试验证'],
    note: '可写文件、可跑命令、能提交 git',
  },
  {
    id: 'recha',
    name: '热茶',
    icon: '🍵',
    role: '审查员 / 反面论证',
    duties: ['审阅代码', '挑逻辑漏洞', '风险评估'],
    note: '只读：不能改文件、不能跑命令、不能提交',
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
    desc: '本地运行，完全免费，保护隐私',
    badge: '离线·免费',
    config: { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  },
  {
    id: 'ollama',
    name: 'Ollama',
    icon: '🦙',
    logo: 'providers/ollama.svg',
    desc: '本地运行，完全免费，可「自动检测」已装模型',
    badge: '离线·免费',
    config: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '🌊',
    logo: 'providers/deepseek.svg',
    desc: '超低价，中文理解能力强，速度快',
    badge: '云端·超低价',
    config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    needApiKey: true,
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    icon: '💎',
    logo: 'providers/siliconflow.ico',
    desc: '多模型聚合平台，送免费额度',
    badge: '云端·有免费额度',
    config: { provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    needApiKey: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '🤖',
    logo: 'providers/openai.svg',
    desc: 'OpenAI 最强模型，适合所有场景',
    badge: '云端·最强',
    config: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    needApiKey: true,
  },
  {
    id: 'custom',
    name: '自定义',
    icon: '⚙️',
    desc: '自填服务地址、模型名（兼容 OpenAI /chat/completions 协议）',
    badge: '自定义',
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

function LLMStep({ onNext, onSkip, onBack }: { onNext: () => void; onSkip: () => void; onBack: () => void }) {
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
          setDetectMsg('⚠️ 请填写「服务地址」和「模型名」后再继续。')
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
            <PresetLogo logo={(p as any).logo} icon={p.icon} />
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

      {selected === 'custom' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            服务地址（Base URL）
          </div>
          <input value={customBaseUrl} onChange={e => setCustomBaseUrl(e.target.value)}
            placeholder="https://your-endpoint.com/v1"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-medium)',
              fontSize: 13, outline: 'none', background: 'var(--surface-0)',
            }} />
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, marginTop: 8 }}>
            模型名
          </div>
          <input value={customModel} onChange={e => setCustomModel(e.target.value)}
            placeholder="your-model-name"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-medium)',
              fontSize: 13, outline: 'none', background: 'var(--surface-0)',
            }} />
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 }}>
            需兼容 OpenAI /chat/completions 协议。填写后可在设置页继续微调。
          </div>
        </div>
      )}

      {PRESET_LLMS.find(p => p.id === selected)?.needApiKey && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            输入 API Key（可在设置页面随时修改）
          </div>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder={selected === 'custom' ? '可留空（部分自建端点无需 Key）' : 'sk-...'}
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-medium)',
              fontSize: 13, outline: 'none', background: 'var(--surface-0)',
            }} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button onClick={onBack} className="onboarding-btn-secondary">← 上一步</button>
        <button onClick={onSkip} className="onboarding-btn-secondary">跳过</button>
        <button onClick={handleConfirm} className="onboarding-btn-primary" style={{ flex: 1 }}>
          {PRESET_LLMS.find(p => p.id === selected)?.needApiKey ? '确认并继续' : '免费开始（无需 Key）'}
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

function TeamStep({ onNext }: { onNext: () => void }) {
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
          results.push(`${m.name}：${res.error || '未知错误'}`)
        }
      }
      setNotice(results.length > 0
        ? `⚠️ 部分成员未能配置：${results.join('；')}。你可以在设置 → LLM 模型配置里单独调整。`
        : `✅ 团队已就绪，${targets.length} 位成员跟随主模型（${llmConfig.model}）`)
    } catch (e: any) {
      setNotice(`⚠️ 配置未保存：${e?.message || e}。不影响使用，随时可在设置里补。`)
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
        你只会跟 <b>Lumina 🐱</b> 说话。她负责判断任务该谁做、派活、然后用人话把结果给你。
        下面这两位<b>不会直接跟你对话</b>，但你能在桌宠上看到他们干活时的状态。
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
              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{m.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{m.role}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {m.duties.join(' · ')}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3 }}>🔒 {m.note}</div>
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
            {enabled[m.id] ? '已启用' : '已关闭'}
          </button>
        </div>
      ))}

      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', margin: '8px 0 12px', lineHeight: 1.6 }}>
        默认使用与你相同的大模型。如果你想让 Yak 用更强的模型、热茶用更稳的，
        随时可以在 <b>设置 → LLM 模型配置</b> 里分别指定。
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
        {busy ? '正在配置团队…' : '确认并继续'}
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
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>还差一步：Lumina 需要一个模型才能思考</h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: 18 }}>
          她还没有可以对话的大脑。<br />
          随便挑一个就行 —— <b>免费在线</b>最快，<b>本地模型</b>不花钱也不外传。
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 20 }}>
          <button onClick={onBack} className="onboarding-btn-secondary">← 回去选模型</button>
          <button onClick={onFinish} className="onboarding-btn-primary">先跳过，稍后再说</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ textAlign: 'center', padding: '32px 16px' }}>
      <div style={{ fontSize: 72, marginBottom: 12, animation: 'pulse 2s ease-in-out infinite' }}>🎉</div>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>一切准备就绪！</h2>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 24 }}>
        Lumina 🐱 已经准备好为你工作（{llmConfig.model}），背后的团队也已就位。<br />
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
