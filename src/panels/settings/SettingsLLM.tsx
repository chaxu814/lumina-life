import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../stores/appStore'
import { persistLLMConfig, switchAndPersist } from '../../services/llmPersist'
import { SettingSection, SettingRow, SettingRowLast, SettingBtn, SettingInput, ButtonGroup, StatusBadge } from '../../components/SettingsUI'
import ModelPickerModal from './ModelPickerModal'

/* ── 供应商列表 ──
 *
 * free 字段保留在类型里仅作向后兼容：老用户的 localStorage 可能仍存着旧数据，
 * 渲染时直接访问不存在的字段虽不会崩，但保留它可避免类型漂移。
 * 当前所有内置供应商均为非 free，过滤条件 !p.free 是防御性恒真判断。
 */
interface LLMProviderDef {
  id: string; name: string; url: string; model: string; free?: boolean
  /** 厂商缩略图（本地打包，离线可用；见 public/providers/LICENSE-NOTICE.md） */
  logo?: string
  /** 无图时的字标兜底：取 name 首字符 */
  mark?: string
  /** 兜底字标底色 */
  markBg?: string
}
const LLM_PROVIDERS: LLMProviderDef[] = [
  { id: 'lmstudio', name: 'LM Studio (本地)', url: 'http://127.0.0.1:1234/v1', model: '', logo: 'providers/lmstudio.ico' },
  { id: 'ollama', name: 'Ollama (本地)', url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', logo: 'providers/ollama.svg' },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o', logo: 'providers/openai.svg' },
  { id: 'claude', name: 'Anthropic Claude', url: 'https://api.anthropic.com', model: 'claude-sonnet-4-5-20250929', logo: 'providers/claude.svg' },
  { id: 'gemini', name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', logo: 'providers/gemini.svg' },
  { id: 'azure', name: 'Azure OpenAI', url: 'https://YOUR_RESOURCE.openai.azure.com', model: 'gpt-4o', logo: 'providers/azure.svg' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', logo: 'providers/deepseek.svg' },
  { id: 'qwen', name: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', logo: 'providers/qwen.svg' },
  { id: 'zhipu', name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4', logo: 'providers/zhipu.ico' },
  { id: 'siliconflow', name: '硅基流动', url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', logo: 'providers/siliconflow.ico' },
  { id: 'custom', name: '自定义', url: '', model: '', mark: '✎', markBg: '#64748b' },
]

const AGENT_META = [
  { id: 'lumina', name: 'Lumina', icon: '🐱', desc: '全能助手 · 主对话' },
  { id: 'yak', name: 'Yak', icon: '📊', desc: '代码工程师 · 写代码/调试' },
  { id: 'recha', name: '热茶', icon: '🫖', desc: '审查员 · 挑错/反面论证' },
]

/* ── 厂商缩略图 ──
 * 图形放白底小方块里：厂商 logo 多为黑色单色（simple-icons），
 * 白底在浅色/深色两套主题下都清晰，不用为每个厂商维护两套图。
 * 图裂了（文件缺失/格式不支持）自动退到字标，不留破图。
 */
function ProviderLogo({ p, size = 15 }: { p: LLMProviderDef; size?: number }) {
  const [broken, setBroken] = useState(false)
  if (p.logo && !broken) {
    return (
      <img
        src={p.logo}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setBroken(true)}
        style={{
          width: size, height: size, objectFit: 'contain', flexShrink: 0,
          background: '#fff', borderRadius: 4, padding: 1,
          border: '1px solid var(--border-light)',
        }}
      />
    )
  }
  return (
    <span style={{
      width: size, height: size, flexShrink: 0, borderRadius: 4,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.68), lineHeight: 1, color: '#fff',
      background: p.markBg || '#94a3b8', fontWeight: 700,
    }} aria-hidden>
      {p.mark || p.name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/* ── Provider 按钮 ── */
function ProviderBtn({ p, active, onClick }: {
  p: LLMProviderDef
  active: boolean; onClick: () => void
}) {
  const { t } = useTranslation()
  return (
    <button onClick={onClick} title={p.name} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '4px 12px 4px 6px', borderRadius: 8, fontSize: 11, fontWeight: active ? 600 : 400,
      border: `1.5px solid ${active ? '#3b82f6' : 'var(--border-light)'}`,
      background: active ? 'var(--accent-50)' : 'var(--surface-0)',
      color: active ? '#2563eb' : 'var(--text-secondary)',
      cursor: 'pointer', transition: 'all 0.15s',
    }}>
      <ProviderLogo p={p} />
      {p.name}
      {p.free && (
        <span style={{ fontSize: 9, fontWeight: 700, background: '#22c55e', color: '#fff', borderRadius: 4, padding: '0 5px', lineHeight: '16px', marginLeft: 2 }}>
          {t('llm.free_badge')}
        </span>
      )}
    </button>
  )
}

/* ── 简单的 notice 提示 ── */
function NoticeBar({ notice }: { notice: string | null }) {
  if (!notice) {return null}
  return (
    <div style={{
      position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
      zIndex: 9999, padding: '10px 20px', borderRadius: 8,
      background: notice.startsWith('❌') ? 'var(--red-100)' : 'var(--green-100)',
      border: notice.startsWith('❌') ? '1px solid #fecaca' : '1px solid var(--green-500)',
      color: notice.startsWith('❌') ? '#991b1b' : '#166534',
      fontSize: 13, fontWeight: 500, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      maxWidth: '80%', textAlign: 'center',
    }}>
      {notice}
    </div>
  )
}

/* ═══════════════════════════════════════════════════
   SettingsLLM — LLM 模型配置
   ═══════════════════════════════════════════════════ */
export default function SettingsLLM() {
  const { t } = useTranslation()
  const llmConfig = useStore(s => s.llmConfig)
  const setLLMConfig = useStore(s => s.setLLMConfig)
  const switchLLMProvider = useStore(s => s.switchLLMProvider)
  const setLlmOnline = useStore(s => s.setLlmOnline)
  const setLlmChecked = useStore(s => s.setLlmChecked)
  const addAuditLog = useStore(s => s.addAuditLog)

  // ── 本地状态 ──
  const [llmStatus, setLlmStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [llmMsg, setLlmMsg] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; multimodal?: boolean; vision?: boolean }> | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // ── 一键检测本地模型（Ollama / LM Studio，免 Key）──
  const [localDetecting, setLocalDetecting] = useState(false)
  const [localFound, setLocalFound] = useState<any[]>([])
  const [localGuide, setLocalGuide] = useState<any[]>([])
  const [localHint, setLocalHint] = useState('')
  const [applyingLocal, setApplyingLocal] = useState('')
  const detectLocal = async () => {
    setLocalDetecting(true); setLocalHint(''); setLocalFound([])
    try {
      const r = await window.luminaAPI?.providerDiscoverLocal?.()
      if (r?.found?.length) {
        setLocalFound(r.found)
        setLocalHint('检测到本地模型，点击「使用」即可一键接入（无需 Key）。')
      } else {
        setLocalGuide(r?.guide || [])
        setLocalHint('未检测到正在运行的本地模型。可安装 Ollama 后点「重新检测」，或使用上方免费在线模型。')
      }
    } catch (e: any) {
      setLocalHint('检测失败：' + (e?.message || e))
    } finally { setLocalDetecting(false) }
  }
  /**
   * 接入本地模型（一键检测 / 手动点「使用」）
   *
   * 🔧 P0 修复（真实故障）
   *   旧实现只调了 switchLLMProvider()——它仅改内存里的 Zustand store，
   *   **从不写盘**。于是：
   *     点「一键检测本地模型」→ 界面变了、提示「已接入」→ 重启又变回去
   *   用户看到的是「每次打开都固定显示第一次那个模型」。
   *
   *   证据：lumina-providers.json 里的 IP/模型长期停留在最初一次，
   *   而 agent-llm-configs.json 已被另一条保存路径更新——
   *   两个配置源各说各话，UI 读前者、实际调用用后者。
   *
   *   现在：接入成功后立即落盘（providers.json），
   *   并由 providerManager 同步到 agent-llm-configs.json，
   *   让两个配置源保持一致。
   */
  const applyLocal = async (f: any) => {
    setApplyingLocal(f.id); setNotice(null)
    try {
      const r = await window.luminaAPI?.providerApplyLocal?.({ id: f.id, baseUrl: f.baseUrl, model: f.recommendedModel })
      if (!r?.success) {
        setNotice('❌ 接入失败：' + (r?.error || '未知错误'))
        return
      }
      const providerId = r.id === 'ollama' ? 'ollama' : 'lmstudio'
      switchLLMProvider(providerId, r.baseUrl || '', r.model || '')

      // ── 落盘（关键：不再只改内存） ──────────────────
      // 统一走 llmPersist 单一入口，避免各处自己拼参数再次分叉。
      // 本地模型通常无需 Key，但部分部署（如远程 LM Studio）仍需，
      // 因此保留 store 里已有的 key，不强行清空。
      const st = useStore.getState()
      const saved = await persistLLMConfig(providerId, {
        baseUrl: r.baseUrl || '',
        apiKey: st.llmConfig.apiKey || '',
        model: r.model || '',
        // 🩺 2026-10-07：上下文窗口用**接入时探测到的真实值**，不再沿用旧配置。
        //   沿用旧值会把上一次的 256000/128000 带到新模型上 —— 正是「本地小模型
        //   被当成 256K 用」的根源。探测不到时用 0（自动检测）。
        contextWindow: typeof r.contextWindow === 'number' ? r.contextWindow : 0,
      })
      if (!saved.ok) {
        // 落盘失败必须告知用户：否则又会出现「界面改了但重启丢失」
        setNotice('⚠️ 已临时接入，但保存到配置失败：' + (saved.error || '未知原因') + '（重启后会失效）')
      } else {
        setNotice('✅ 已接入本地模型 ' + (r.model || '') + '（无需 Key，已保存）')
      }
      setLlmOnline(true); setLlmChecked(true)
    } catch (e: any) {
      setNotice('❌ 接入失败：' + (e?.message || e))
    } finally { setApplyingLocal('') }
  }

  const [maxTokensDraft, setMaxTokensDraft] = useState<string | null>(null)
  const maxTokensDisplay = maxTokensDraft ?? String(llmConfig.maxTokens ?? 4096)
  const commitMaxTokens = () => {
    if (maxTokensDraft === null) {return}
    const n = parseInt(maxTokensDraft, 10)
    if (!isNaN(n) && n > 0 && n <= 1048576) {setLLMConfig({ maxTokens: n })}
    setMaxTokensDraft(null)
  }

  const [ctxDraft, setCtxDraft] = useState<string | null>(null)
  const ctxDisplay = ctxDraft ?? String(llmConfig.contextWindow ?? 0)
  const commitContextWindow = () => {
    if (ctxDraft === null) {return}
    const n = parseInt(ctxDraft, 10)
    if (!isNaN(n) && n >= 0 && n <= 2_097_152) {setLLMConfig({ contextWindow: n })}
    setCtxDraft(null)
  }

  // ── Team Agent 状态 ──
  const [agentLlmConfigs, setAgentLlmConfigs] = useState<Record<string, any>>({})
  const [teamFetchingModel, setTeamFetchingModel] = useState<string | null>(null)
  const [teamAvailableModels, setTeamAvailableModels] = useState<Record<string, Array<{ id: string; multimodal?: boolean; vision?: boolean }>>>({})
  const [teamFetchError, setTeamFetchError] = useState<Record<string, string>>({})
  const [teamShowModelPicker, setTeamShowModelPicker] = useState<string | null>(null)
  const [teamAdvancedOpen, setTeamAdvancedOpen] = useState<Record<string, boolean>>({})
  const [teamShowApiKey, setTeamShowApiKey] = useState<Record<string, boolean>>({})

  // ── 组件挂载时加载 Team Agent LLM 配置 ──
  useEffect(() => {
    (async () => {
      try {
        const r = await window.luminaAPI?.agentLlmGetAllConfigs?.()
        if (r?.configs) {setAgentLlmConfigs(r.configs)}
      } catch (e) { console.error('[SettingsLLM] ❌ 加载 Team Agent LLM 配置失败:', e) }
    })()
  }, [])

  // ── 测试连接 ──
  const testLLM = async () => {
    if (!llmConfig.model || !llmConfig.baseUrl) {return}
    setLlmStatus('testing')
    setLlmMsg('')
    try {
      const res = await window.luminaAPI?.llmTestConnection?.({ baseUrl: llmConfig.baseUrl, apiKey: llmConfig.apiKey || '', model: llmConfig.model })
      if (res?.success) {
        setLlmStatus('ok')
        setLlmMsg(`✅ 连接成功 (${res.latency || 'N/A'}ms)`)
        setLlmOnline(true); setLlmChecked(true)
      } else {
        setLlmStatus('fail')
        setLlmMsg(`❌ ${res?.error || '连接失败'}`)
        setLlmOnline(false); setLlmChecked(true)
      }
    } catch (e: any) {
      setLlmStatus('fail')
      setLlmMsg(`❌ ${e.message || '未知错误'}`)
      setLlmOnline(false); setLlmChecked(true)
    }
  }

  // ── 保存到后端 ──
  const saveProviderToBackend = async () => {
    const { provider, baseUrl, apiKey, model } = useStore.getState().llmConfig
    if (!provider) {return}
    setSavingProvider(true)
    try {
      // 🔧 修复：原来硬编码 maxContextTokens: 256000，把用户设置的上下文窗口静默丢弃。
  // llmPersist.ts 里是正确写法（cfg.contextWindow || 256000），这里漏改。
  const st = useStore.getState()
  await window.luminaAPI?.providerSaveConfig?.(provider, {
    baseUrl, apiKey: apiKey || '', model, enabled: true, timeout: 600,
    maxContextTokens: st.llmConfig.contextWindow || 256000,
  })
      await window.luminaAPI?.providerSetActive?.(provider)

      // 刷新前端缓存，避免界面仍显示旧值
      try {
        const r = await window.luminaAPI?.agentLlmGetAllConfigs?.()
        if (r?.configs) {setAgentLlmConfigs(r.configs)}
        const all = await window.luminaAPI?.providerGetAll?.()
        if (all?.activeProviderId) {
          const active = all.configs[all.activeProviderId]
          if (active) {
            useStore.getState().setLLMConfig({
              provider: all.activeProviderId,
              baseUrl: active.baseUrl || '',
              apiKey: active.apiKey || '',
              model: active.model || '',
            })
          }
        }
      } catch { /* 刷新失败不影响保存成功提示 */ }

      setLlmOnline(true); setLlmChecked(true)
      setNotice(`✅ 供应商配置已保存 (${provider})`)
    } catch (e: any) { setNotice('❌ 保存失败: ' + (e.message || e)) }
    setSavingProvider(false)
  }

  // ── 获取模型列表 ──
  const fetchModels = async () => {
    const { provider, baseUrl, apiKey } = useStore.getState().llmConfig
    if (!baseUrl) {return}
    setShowModelPicker(true)
    setAvailableModels(null)
    setFetchError(null)
    setFetchingModels(true)
    let lastError = ''
    try {
      // 优先走 provider 系统；传入界面当前填写的地址/密钥（无需先保存）
      if (window.luminaAPI?.providerFetchModels && provider) {
        const res = await window.luminaAPI.providerFetchModels(provider, { baseUrl, apiKey: apiKey || '' })
        if (res?.models && res.models.length > 0) { setAvailableModels(res.models); setFetchingModels(false); return }
        if (res?.error) {lastError = res.error}
      }
    } catch (e: any) { lastError = e.message || String(e) }
    try {
      // 回退：llm:fetchModels（内置 LM Studio/Ollama 多端点识别）
      const res = await window.luminaAPI?.llmFetchModels?.({ baseUrl, apiKey: apiKey || '' })
      if (res?.models && res.models.length > 0) { setAvailableModels(res.models); setFetchingModels(false); return }
      if (res?.error) {lastError = res.error || lastError}
    } catch (e: any) { lastError = lastError || e.message || String(e) }
    setFetchError(lastError || '获取模型列表失败，请检查 API 地址和密钥')
    setFetchingModels(false)
  }

  // ── Team 模型获取 ──
  const fetchTeamModels = async (agentId: string) => {
    const cfg = agentLlmConfigs[agentId]
    if (!cfg?.endpoint) {return}
    setTeamShowModelPicker(agentId)
    setTeamAvailableModels(prev => ({ ...prev, [agentId]: null as any }))
    setTeamFetchError(prev => ({ ...prev, [agentId]: '' }))
    setTeamFetchingModel(agentId)
    try {
      const res = await window.luminaAPI?.llmFetchModels?.({ baseUrl: cfg.endpoint, apiKey: cfg.apiKey || '' })
      if (res?.models && res.models.length > 0) {
        setTeamAvailableModels(prev => ({ ...prev, [agentId]: res.models }))
      } else {
        setTeamFetchError(prev => ({ ...prev, [agentId]: res?.error || '未获取到模型' }))
      }
    } catch (e: any) {
      setTeamFetchError(prev => ({ ...prev, [agentId]: e.message || '获取模型列表失败' }))
    }
    setTeamFetchingModel(null)
  }

  // ── 保存 Agent LLM ──
  const saveAgentLlm = async (agentId: string) => {
    const cfg = agentLlmConfigs[agentId] || {
      provider: llmConfig.provider, model: llmConfig.model,
      endpoint: llmConfig.baseUrl, apiKey: llmConfig.apiKey, timeout: 600,
    }
    try {
      const res: any = await window.luminaAPI?.agentLlmSetConfig?.(agentId, {
        provider: cfg.provider || llmConfig.provider,
        model: cfg.model || llmConfig.model,
        endpoint: cfg.endpoint || llmConfig.baseUrl,
        apiKey: cfg.apiKey || llmConfig.apiKey,
        timeout: cfg.timeout || 600,
        maxContextTokens: cfg.maxContextTokens || 262144,
      })
      if (res && res.success === false) { setNotice('❌ 保存失败: ' + (res.error || '后端未知错误')); return }
      const r = await window.luminaAPI?.agentLlmGetAllConfigs?.()
      if (r?.configs) {setAgentLlmConfigs(r.configs)}
      setNotice(`✅ ${AGENT_META.find(a => a.id === agentId)?.name || agentId} 配置已保存`)
    } catch (e: any) { setNotice('❌ 保存失败: ' + (e.message || e)) }
  }

  /* ══════════════════════════════════════
     RENDER
     ══════════════════════════════════════ */
  const inputS = {
    width: '100%', height: 32, padding: '7px 10px', borderRadius: 6, fontSize: 12,
    border: '1.5px solid var(--border-light)', outline: 'none',
    background: 'var(--surface-0)', color: 'var(--text-primary)',
    boxSizing: 'border-box' as const, transition: 'border-color 0.15s',
  }

  const providerS = (active: boolean) => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '4px 12px', borderRadius: 8, fontSize: 11, fontWeight: active ? 600 : 400,
    border: `1.5px solid ${active ? '#3b82f6' : 'var(--border-light)'}`,
    background: active ? 'var(--accent-50)' : 'var(--surface-0)',
    color: active ? '#2563eb' : 'var(--text-secondary)',
    cursor: 'pointer' as const, transition: 'all 0.15s',
  })

  return (
    <>
      <NoticeBar notice={notice} />

      {/* ════════════════════════════════════
          Agent LLM — 主卡
          ════════════════════════════════════ */}
      <div style={{
        borderRadius: 10, border: '1px solid var(--border-light)',
        marginBottom: 16, background: 'var(--surface-0)', overflow: 'hidden',
      }}>
        {/* 头部 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--border-light)',
          background: 'var(--surface-0)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>🧠</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{t('llm.agent_llm_title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('llm.agent_llm_subtitle')}</div>
            </div>
          </div>
          {llmStatus === 'ok' && (
            <StatusBadge status="ok" label={t('llm.connected')} />
          )}
        </div>

        {/* 主体 */}
        <div style={{ padding: 16 }}>

          {/* 本地模型 */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 12 }}>🖥️</span> {t('llm.local_models_title')}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {LLM_PROVIDERS.filter(p => p.id === 'lmstudio' || p.id === 'ollama').map(p => (
                <ProviderBtn key={p.id} p={p} active={llmConfig.provider === p.id}
                  onClick={() => { void switchAndPersist(useStore.getState(), p.id, p.url, p.model); setLlmStatus('idle') }} />
              ))}
              <button onClick={detectLocal} disabled={localDetecting}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderRadius: 8,
                  fontSize: 11, fontWeight: 600, border: '1.5px dashed #3b82f6', background: 'var(--accent-50)',
                  color: '#2563eb', cursor: localDetecting ? 'wait' : 'pointer',
                }}>
                {localDetecting ? t('llm.detecting_local') : t('llm.detect_local')}
              </button>
            </div>
            {localHint && (
              <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--surface-100)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {localHint}
                {localFound.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                    {localFound.map((f) => (
                      <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <StatusBadge status="running" label={f.label} />
                        <span style={{ fontSize: 11, color: 'var(--text-primary)' }}>{t('llm.local_recommend')}{f.recommendedModel}{t('llm.local_models_count', { count: f.models.length })}</span>
                        <button onClick={() => applyLocal(f)} disabled={!!applyingLocal}
                          style={{ padding: '2px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer' }}>
                          {applyingLocal === f.id ? t('llm.local_applying') : t('llm.local_use')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {!localFound.length && localGuide.length > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {localGuide.map((g, i) => (
                      <div key={i}><b style={{ color: 'var(--text-primary)' }}>{g.title}：</b>{g.body}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 云端模型 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 12 }}>☁️</span> {t('llm.cloud_models_title')}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {LLM_PROVIDERS.filter(p => p.id !== 'lmstudio' && !p.free).map(p => (
                <ProviderBtn key={p.id} p={p} active={llmConfig.provider === p.id}
                  onClick={() => { void switchAndPersist(useStore.getState(), p.id, p.url, p.model); setLlmStatus('idle') }} />
              ))}
            </div>
          </div>

          {/* 配置表单 */}
          <div style={{
            borderRadius: 8, border: '1.5px solid var(--border-light)',
            padding: 14, background: 'var(--surface-0)', marginBottom: 12,
          }}>
            {/* 第一行：API 地址 + API Key */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>{t('llm.base_url')}</label>
                <input style={inputS} value={llmConfig.baseUrl}
                  onChange={e => setLLMConfig({ baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1" />
              </div>
              <div style={{ flex: '0 0 200px' }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>{t('llm.api_key')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}>
                  <input style={{ ...inputS, paddingRight: 35 }}
                    type={showApiKey ? "text" : "password"} value={llmConfig.apiKey}
                    onChange={e => setLLMConfig({ apiKey: e.target.value })}
                    placeholder="sk-..." />
                  <button onClick={() => setShowApiKey(!showApiKey)}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 14, width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    title={showApiKey ? t('llm.hide_key') : t('llm.show_key')}>
                    {showApiKey ? "👁️" : "👁️‍🗨️"}
                  </button>
                </div>
              </div>
            </div>

            {/* 第二行：模型 + 温度 */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>{t('llm.model')}</label>
                <div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
                  <input style={{ flex: 1, ...inputS }} value={llmConfig.model}
                    onChange={e => setLLMConfig({ model: e.target.value })}
                    placeholder="gpt-4o" />
                  {llmConfig.baseUrl && (
                    <button onClick={fetchModels} disabled={fetchingModels}
                      style={{
                        padding: '0 12px', height: 32, borderRadius: 6, fontSize: 12,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        cursor: fetchingModels ? 'wait' : 'pointer',
                        border: '1px solid var(--border-light)', background: 'var(--surface-0)',
                        color: 'var(--text-secondary)', whiteSpace: 'nowrap',
                        animation: fetchingModels ? 'pulse 1.5s infinite' : 'none',
                      }}>
                      {fetchingModels ? '⏳' : `📋 ${t('llm.fetch_models')}`}
                    </button>
                  )}
                </div>
                <ModelPickerModal
                  show={showModelPicker} models={availableModels} currentModel={llmConfig.model}
                  onSelect={(m) => setLLMConfig({ model: m })}
                  onClose={() => setShowModelPicker(false)} isFetching={fetchingModels}
                  baseUrl={llmConfig.baseUrl} apiKey={llmConfig.apiKey}
                  error={fetchError}
                  onTestConnection={async (modelId) => {
                    const { baseUrl, apiKey } = useStore.getState().llmConfig
                    try {
                      const res = await window.luminaAPI?.llmTestConnection?.({ baseUrl, apiKey: apiKey || '', model: modelId })
                      if (res?.success) { setNotice(`🔌 ${modelId} 连接成功 (${res.latency || ''}ms)`); setLlmOnline(true); setLlmChecked(true) }
                      else { setNotice(`❌ ${modelId}: ${res?.error || '连接失败'}`); setLlmOnline(false); setLlmChecked(true) }
                    } catch (e: any) { setNotice(`❌ ${modelId}: ${e.message || '未知错误'}`); setLlmOnline(false); setLlmChecked(true) }
                  }}
                />
              </div>
              <div style={{ flex: '0 0 110px' }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>{t('llm.temperature')}</label>
                <input style={{ ...inputS }} type="number" min="0" max="2" step="0.1"
                  value={llmConfig.temperature ?? 0.7}
                  onChange={e => setLLMConfig({ temperature: parseFloat(e.target.value) || 0.7 })} />
              </div>
            </div>

            {/* 高级选项 */}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-light)' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>{t('llm.advanced')}</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>{t('llm.max_tokens')}</label>
                  <input style={{ ...inputS }} value={maxTokensDisplay}
                    onChange={e => setMaxTokensDraft(e.target.value)}
                    onBlur={commitMaxTokens}
                    onKeyDown={e => { if (e.key === 'Enter') {(e.target as HTMLInputElement).blur()} }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>{t('llm.context_window')} (0={t('llm.context_window_auto')})</label>
                  <input style={{ ...inputS }} value={ctxDisplay}
                    onChange={e => setCtxDraft(e.target.value)}
                    onBlur={commitContextWindow}
                    onKeyDown={e => { if (e.key === 'Enter') {(e.target as HTMLInputElement).blur()} }} />
                  <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3 }}>
                    {t('llm.ctx_hint')}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 操作栏 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <SettingBtn variant="success" onClick={saveProviderToBackend} disabled={savingProvider} loading={savingProvider}>
              {t('llm.save_config')}
            </SettingBtn>
            <SettingBtn variant="primary" onClick={testLLM} disabled={llmStatus === 'testing'} loading={llmStatus === 'testing'}>
              {t('llm.test_conn')}
            </SettingBtn>
            {llmMsg && (
              <span style={{ fontSize: 12, padding: '3px 10px', borderRadius: 6, background: llmStatus === 'ok' ? '#ecfdf5' : 'var(--red-100)', color: llmStatus === 'ok' ? '#065f46' : '#991b1b' }}>
                {llmMsg}
              </span>
            )}
            <button onClick={async () => {
              if (!llmConfig.model || !llmConfig.baseUrl) {return}
              try {
                for (const a of AGENT_META) {
                  await window.luminaAPI.agentLlmSetConfig?.(a.id, {
                    provider: llmConfig.provider, model: llmConfig.model,
                    endpoint: llmConfig.baseUrl, apiKey: llmConfig.apiKey, timeout: 600,
                  })
                }
                const r = await window.luminaAPI.agentLlmGetAllConfigs?.()
                if (r?.configs) {setAgentLlmConfigs(r.configs)}
                setNotice(t('llm.sync_team_done'))
              } catch (e: any) { setNotice('❌ ' + t('common.save_failed') + ': ' + (e.message || e)) }
            }}
              disabled={!llmConfig.model || !llmConfig.baseUrl}
              style={{
                marginLeft: 'auto', padding: '5px 12px', borderRadius: 6, fontSize: 11,
                cursor: (!llmConfig.model || !llmConfig.baseUrl) ? 'not-allowed' : 'pointer',
                border: '1px solid var(--border-light)', background: 'var(--surface-0)', color: 'var(--text-secondary)',
                opacity: (!llmConfig.model || !llmConfig.baseUrl) ? 0.4 : 1,
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
              {t('llm.sync_team')}
            </button>
          </div>

          {/* LM Studio 提示 */}
          {llmConfig.provider === 'lmstudio' && (
            <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 6, background: '#fef3c7', border: '1px solid #f59e0b', fontSize: 11, color: '#92400e', lineHeight: 1.6 }}>
              <strong>💡 LM Studio 使用提示</strong><br />
              打开 LM Studio → Developer 标签 → Load Model → 确认 Server 端口为 1234 且为 Running 状态
            </div>
          )}
        </div>
      </div>

      {/* ════════════════════════════════════
          Team Agent LLM
          ════════════════════════════════════ */}
      <div style={{
        borderRadius: 10, border: '1px solid var(--border-light)',
        marginBottom: 16, background: 'var(--surface-0)', overflow: 'hidden',
      }}>
        {/* 头部 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 16px', borderBottom: '1px solid var(--border-light)',
          background: 'var(--surface-0)',
        }}>
          <span style={{ fontSize: 18 }}>🤖</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Team Agent LLM</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('llm.team_subtitle')}</div>
          </div>
        </div>

        <div style={{ padding: 16 }}>
          {/* 快捷提示 */}
          <div style={{
            marginBottom: 14, padding: '8px 12px', borderRadius: 6,
            background: '#ecfdf5', border: '1px solid #a7f3d0',
            fontSize: 11, color: '#166534', display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {t('llm.team_sync_hint')}
          </div>

          {/* Agent 卡片列表 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {AGENT_META.map((agent) => {
              const cfg = agentLlmConfigs[agent.id] || {
                provider: 'lmstudio', model: '', endpoint: 'http://localhost:1234/v1', timeout: 300, apiKey: ''
              }
              const isConfigured = !!(cfg.model && cfg.endpoint)

              const agentLabelStyle = (active: boolean) => ({
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '3px 10px', borderRadius: 6, fontSize: 10, fontWeight: active ? 600 : 400,
                border: `1px solid ${active ? '#3b82f6' : 'var(--border-light)'}`,
                background: active ? 'var(--accent-50)' : 'var(--surface-0)',
                color: active ? '#2563eb' : 'var(--text-secondary)',
                cursor: 'pointer' as const,
              })

              const handleAgentProvider = (providerId: string, endpoint: string, model: string) => {
                const next: any = { ...cfg, provider: providerId, endpoint: endpoint || cfg.endpoint, model: model || cfg.model }
                setAgentLlmConfigs(prev => ({ ...prev, [agent.id]: next }))
              }

              return (
                <div key={agent.id} style={{
                  borderRadius: 8, border: `1px solid ${isConfigured ? 'var(--border-light)' : 'var(--border-light)'}`,
                  padding: 12, background: isConfigured ? 'var(--surface-0)' : 'var(--surface-100)',
                }}>
                  {/* Agent 头部 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 18 }}>{agent.icon}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{agent.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{agent.desc}</span>
                    <span style={{
                      marginLeft: 'auto', fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 8,
                      background: isConfigured ? '#ecfdf5' : '#fef3c7',
                      color: isConfigured ? '#065f46' : '#92400e',
                    }}>
                      {isConfigured ? t('llm.configured') : t('llm.unconfigured')}
                    </span>
                  </div>


                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 11 }}>🖥️</span> 本地模型
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                    {LLM_PROVIDERS.filter(p => p.id === 'lmstudio').map(p => (
                      <button key={p.id} onClick={() => handleAgentProvider(p.id, p.url, p.model)} style={agentLabelStyle(cfg.provider === p.id)}>
                        {cfg.provider === p.id ? <span style={{ color: '#3b82f6', fontSize: 10 }}>●</span> : <span style={{ color: '#d1d5db', fontSize: 10 }}>○</span>}
                        LM Studio
                      </button>
                    ))}
                  </div>

                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 11 }}>☁️</span> 云端模型
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
                    {LLM_PROVIDERS.filter(p => p.id !== 'lmstudio' && !p.free && p.id !== 'custom').map(p => (
                      <button key={p.id} onClick={() => handleAgentProvider(p.id, p.url, p.model)} style={agentLabelStyle(cfg.provider === p.id)}>
                        {cfg.provider === p.id ? <span style={{ color: '#3b82f6', fontSize: 10 }}>●</span> : <span style={{ color: '#d1d5db', fontSize: 10 }}>○</span>}
                        {p.name}
                      </button>
                    ))}
                  </div>

                  {/* 配置表单 */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ flex: '2 1 200px' }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 }}>Endpoint</div>
                      <input style={{ width: '100%', padding: '5px 8px', borderRadius: 5, fontSize: 11, border: '1.5px solid var(--border-light)', outline: 'none', background: 'var(--surface-0)', boxSizing: 'border-box' }}
                        value={cfg.endpoint || ''}
                        onChange={e => setAgentLlmConfigs(prev => ({ ...prev, [agent.id]: { ...cfg, endpoint: e.target.value } }))}
                        placeholder="http://localhost:1234/v1" />
                    </div>
                    <div style={{ flex: '1 1 140px', position: 'relative' }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 }}>模型</div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input style={{ flex: 1, padding: '5px 8px', borderRadius: 5, fontSize: 11, border: '1.5px solid var(--border-light)', outline: 'none', background: 'var(--surface-0)', boxSizing: 'border-box' }}
                          value={cfg.model || ''}
                          onChange={e => setAgentLlmConfigs(prev => ({ ...prev, [agent.id]: { ...cfg, model: e.target.value } }))}
                          placeholder="gpt-4o" />
                        <button onClick={() => fetchTeamModels(agent.id)}
                          disabled={teamFetchingModel === agent.id}
                          style={{
                            padding: '2px 6px', borderRadius: 4, fontSize: 10,
                            cursor: teamFetchingModel === agent.id ? 'wait' : 'pointer',
                            border: '1px solid var(--border-light)', background: 'var(--surface-0)', color: 'var(--text-secondary)',
                          }}>
                          {teamFetchingModel === agent.id ? '⏳' : '📋'}
                        </button>
                      </div>
                      <ModelPickerModal
                        show={teamShowModelPicker === agent.id}
                        models={teamAvailableModels[agent.id] || null}
                        currentModel={cfg.model || ''}
                        onSelect={(m) => setAgentLlmConfigs(prev => ({ ...prev, [agent.id]: { ...cfg, model: m } }))}
                        onClose={() => setTeamShowModelPicker(null)}
                        isFetching={teamFetchingModel === agent.id}
                        baseUrl={cfg.endpoint} apiKey={cfg.apiKey}
                        error={teamFetchError[agent.id] || null}
                        onTestConnection={async (modelId) => {
                          try {
                            const res = await window.luminaAPI?.llmTestConnection?.({ baseUrl: cfg.endpoint, apiKey: cfg.apiKey || '', model: modelId })
                            if (res?.success) {setNotice(`🔌 ${agent.name} / ${modelId} 连接成功`)}
                            else {setNotice(`❌ ${agent.name} / ${modelId}: ${res?.error || '连接失败'}`)}
                          } catch (e: any) { setNotice(`❌ ${agent.name} / ${modelId}: ${e.message || '未知错误'}`) }
                        }}
                      />
                    </div>
                    <div style={{ flex: '1 1 100px' }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 }}>API Key</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}>
                        <input style={{ width: '100%', padding: '5px 8px', borderRadius: 5, fontSize: 11, border: '1.5px solid var(--border-light)', outline: 'none', background: 'var(--surface-0)', boxSizing: 'border-box', paddingRight: 30 }}
                          type={teamShowApiKey[agent.id] ? "text" : "password"} value={cfg.apiKey || ''}
                          onChange={e => setAgentLlmConfigs(prev => ({ ...prev, [agent.id]: { ...cfg, apiKey: e.target.value } }))}
                          placeholder="sk-..." />
                        <button onClick={() => setTeamShowApiKey(prev => ({ ...prev, [agent.id]: !prev[agent.id] }))}
                          style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%' }}>
                          {teamShowApiKey[agent.id] ? "👁️" : "👁️‍🗨️"}
                        </button>
                      </div>
                    </div>
                    <div style={{ flex: '0 1 70px' }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 }}>超时(s)</div>
                      <input style={{ width: '100%', padding: '5px 8px', borderRadius: 5, fontSize: 11, border: '1.5px solid var(--border-light)', outline: 'none', background: 'var(--surface-0)', boxSizing: 'border-box' }}
                        type="number" min="10" max="600" value={cfg.timeout || 300}
                        onChange={e => setAgentLlmConfigs(prev => ({ ...prev, [agent.id]: { ...cfg, timeout: parseInt(e.target.value) || 300 } }))} />
                    </div>
                  </div>

                  {/* 高级选项 */}
                  <div style={{ marginTop: 6, borderTop: '1px solid var(--border-light)', paddingTop: 6 }}>
                    <button onClick={() => setTeamAdvancedOpen(prev => ({ ...prev, [agent.id]: !prev[agent.id] }))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px' }}>
                      <span style={{ transform: teamAdvancedOpen[agent.id] ? 'rotate(90deg)' : 'none', transition: '0.2s', fontSize: 9, display: 'inline-block' }}>▶</span>
                      {teamAdvancedOpen[agent.id] ? '收起高级选项' : '⚙️ 高级选项'}
                    </button>
                    {teamAdvancedOpen[agent.id] && (
                      // 🔧 2026-10-10 修复（运行时验证发现）：
                      //   ① 原来第一栏标签写「最大输出 (tokens)」，但它绑定的
                      //      `maxContextTokens` 语义其实是**上下文窗口**（默认 262144、
                      //      _applyAgentLlmConfig 用它推导 contextWindow）—— 标签反了；
                      //   ② 原来第二栏「上下文窗口」绑定 `contextWindow`，而后端
                      //      AgentLlmConfig 里**根本没有这个字段**，保存时也没带上 →
                      //      用户填了**从来没生效过**。属于同一个概念的第二个真相源，
                      //      已删除，只保留 `maxContextTokens` 一个入口。
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 }}>上下文窗口 (tokens)</div>
                          <input type="number" min="0" max="1048576" style={{ width: '100%', padding: '5px 8px', borderRadius: 5, fontSize: 11, border: '1.5px solid var(--border-light)', outline: 'none', background: 'var(--surface-0)', boxSizing: 'border-box' }}
                            value={cfg.maxContextTokens ?? 262144}
                            onChange={e => setAgentLlmConfigs(prev => ({ ...prev, [agent.id]: { ...cfg, maxContextTokens: Math.min(parseInt(e.target.value) || 0, 1048576) } }))} />
                          <div style={{ fontSize: 9, color: 'var(--text-tertiary)', marginTop: 3, lineHeight: 1.4 }}>
                            该模型能读入的总长度。填得比模型实际能吃的大，会每轮重复预填充、首 token 变慢。
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 }}>温度</div>
                          <input type="number" min="0" max="2" step="0.1" style={{ width: '100%', padding: '5px 8px', borderRadius: 5, fontSize: 11, border: '1.5px solid var(--border-light)', outline: 'none', background: 'var(--surface-0)', boxSizing: 'border-box' }}
                            value={cfg.temperature ?? 0.7}
                            onChange={e => setAgentLlmConfigs(prev => ({ ...prev, [agent.id]: { ...cfg, temperature: parseFloat(e.target.value) || 0.7 } }))} />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 保存按钮 */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                    <button onClick={() => saveAgentLlm(agent.id)}
                      style={{ padding: '5px 12px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none', background: '#3b82f6', color: '#fff' }}>
                      保存
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}
