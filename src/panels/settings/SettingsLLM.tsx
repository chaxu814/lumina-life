import React, { useState, useEffect } from 'react'
import { useStore } from '../../stores/appStore'
import { SettingSection, SettingRow, SettingRowLast, SettingBtn, SettingInput, ButtonGroup, StatusBadge } from '../../components/SettingsUI'
import ModelPickerModal from './ModelPickerModal'

/* ── 供应商列表 ── */
const LLM_PROVIDERS = [
  { id: 'opencode-zen', name: '🎯 OpenCode Zen (免费)', url: 'https://opencode.ai/zen/v1', model: 'deepseek-v4-flash-free', free: true },
  { id: 'lmstudio', name: 'LM Studio (本地)', url: 'http://127.0.0.1:1234/v1', model: '' },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', name: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
  { id: 'siliconflow', name: '硅基流动', url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'custom', name: '自定义', url: '', model: '' },
]

const AGENT_META = [
  { id: 'lumina', name: 'Lumina', icon: '🐱', desc: '全能助手 · 主对话' },
  { id: 'yak', name: 'Yak', icon: '📊', desc: '代码工程师 · 写代码/调试' },
  { id: 'recha', name: '热茶', icon: '🫖', desc: '审查员 · 挑错/反面论证' },
]

/* ── Provider 按钮 ── */
function ProviderBtn({ p, active, onClick }: {
  p: { id: string; name: string; free?: boolean }
  active: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '4px 12px', borderRadius: 8, fontSize: 11, fontWeight: active ? 600 : 400,
      border: `1.5px solid ${active ? '#3b82f6' : 'var(--border-light)'}`,
      background: active ? 'var(--accent-50)' : 'var(--surface-0)',
      color: active ? '#2563eb' : 'var(--text-secondary)',
      cursor: 'pointer', transition: 'all 0.15s',
    }}>
      {active ? <span style={{ color: '#3b82f6', fontSize: 11 }}>●</span>
              : <span style={{ color: '#d1d5db', fontSize: 11 }}>○</span>}
      {p.name}
      {p.free && (
        <span style={{ fontSize: 9, fontWeight: 700, background: '#22c55e', color: '#fff', borderRadius: 4, padding: '0 5px', lineHeight: '16px', marginLeft: 2 }}>
          免费
        </span>
      )}
    </button>
  )
}

/* ── 简单的 notice 提示 ── */
function NoticeBar({ notice }: { notice: string | null }) {
  if (!notice) return null
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
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [maxTokensDraft, setMaxTokensDraft] = useState<string | null>(null)
  const maxTokensDisplay = maxTokensDraft ?? String(llmConfig.maxTokens ?? 4096)
  const commitMaxTokens = () => {
    if (maxTokensDraft === null) return
    const n = parseInt(maxTokensDraft, 10)
    if (!isNaN(n) && n > 0 && n <= 1048576) setLLMConfig({ maxTokens: n })
    setMaxTokensDraft(null)
  }

  const [ctxDraft, setCtxDraft] = useState<string | null>(null)
  const ctxDisplay = ctxDraft ?? String(llmConfig.contextWindow ?? 0)
  const commitContextWindow = () => {
    if (ctxDraft === null) return
    const n = parseInt(ctxDraft, 10)
    if (!isNaN(n) && n >= 0 && n <= 1048576) setLLMConfig({ contextWindow: n })
    setCtxDraft(null)
  }

  // ── Team Agent 状态 ──
  const [agentLlmConfigs, setAgentLlmConfigs] = useState<Record<string, any>>({})
  const [teamFetchingModel, setTeamFetchingModel] = useState<string | null>(null)
  const [teamAvailableModels, setTeamAvailableModels] = useState<Record<string, Array<{ id: string; multimodal?: boolean; vision?: boolean }>>>({})
  const [teamShowModelPicker, setTeamShowModelPicker] = useState<string | null>(null)
  const [teamAdvancedOpen, setTeamAdvancedOpen] = useState<Record<string, boolean>>({})
  const [teamShowApiKey, setTeamShowApiKey] = useState<Record<string, boolean>>({})

  // ── 组件挂载时加载 Team Agent LLM 配置 ──
  useEffect(() => {
    (async () => {
      try {
        const r = await window.luminaAPI?.agentLlmGetAllConfigs?.()
        if (r?.configs) setAgentLlmConfigs(r.configs)
      } catch (e) { console.error('[SettingsLLM] ❌ 加载 Team Agent LLM 配置失败:', e) }
    })()
  }, [])

  // ── 测试连接 ──
  const testLLM = async () => {
    if (!llmConfig.model || !llmConfig.baseUrl) return
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
    if (!provider) return
    setSavingProvider(true)
    try {
      await window.luminaAPI?.providerSaveConfig?.(provider, {
        baseUrl, apiKey: apiKey || '', model, enabled: true, timeout: 600, maxContextTokens: 256000,
      })
      await window.luminaAPI?.providerSetActive?.(provider)
      setLlmOnline(true); setLlmChecked(true)
      setNotice(`✅ 供应商配置已保存 (${provider})`)
    } catch (e: any) { setNotice('❌ 保存失败: ' + (e.message || e)) }
    setSavingProvider(false)
  }

  // ── 获取模型列表 ──
  const fetchModels = async () => {
    const { provider, baseUrl, apiKey } = useStore.getState().llmConfig
    if (!baseUrl) return
    setShowModelPicker(true)
    setAvailableModels(null)
    setFetchingModels(true)
    try {
      if (window.luminaAPI?.providerFetchModels && provider) {
        const res = await window.luminaAPI.providerFetchModels(provider)
        if (res?.models && res.models.length > 0) { setAvailableModels(res.models); setFetchingModels(false); return }
      }
    } catch {}
    try {
      const res = await window.luminaAPI?.llmFetchModels?.({ baseUrl, apiKey: apiKey || '' })
      if (res?.models) setAvailableModels(res.models)
    } catch {}
    setFetchingModels(false)
  }

  // ── Team 模型获取 ──
  const fetchTeamModels = async (agentId: string) => {
    const cfg = agentLlmConfigs[agentId]
    if (!cfg?.endpoint) return
    setTeamShowModelPicker(agentId)
    setTeamAvailableModels(prev => ({ ...prev, [agentId]: null as any }))
    setTeamFetchingModel(agentId)
    try {
      const res = await window.luminaAPI?.llmFetchModels?.({ baseUrl: cfg.endpoint, apiKey: cfg.apiKey || '' })
      if (res?.models) setTeamAvailableModels(prev => ({ ...prev, [agentId]: res.models }))
    } catch {}
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
      })
      if (res && res.success === false) { setNotice('❌ 保存失败: ' + (res.error || '后端未知错误')); return }
      const r = await window.luminaAPI?.agentLlmGetAllConfigs?.()
      if (r?.configs) setAgentLlmConfigs(r.configs)
      setNotice(`✅ ${AGENT_META.find(a => a.id === agentId)?.name || agentId} 配置已保存`)
    } catch (e: any) { setNotice('❌ 保存失败: ' + (e.message || e)) }
  }

  /* ══════════════════════════════════════
     RENDER
     ══════════════════════════════════════ */
  const inputS = {
    width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 12,
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
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Agent LLM</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>普通模式使用（聊天 / AI智能体 / 快速 / 修复）</div>
            </div>
          </div>
          {llmStatus === 'ok' && (
            <StatusBadge status="ok" label={`已连接`} />
          )}
        </div>

        {/* 主体 */}
        <div style={{ padding: 16 }}>
          {/* 免费模型 */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 12 }}>🎯</span> 免费模型（无需配置，开箱即用）
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {LLM_PROVIDERS.filter(p => p.free).map(p => (
                <ProviderBtn key={p.id} p={p} active={llmConfig.provider === p.id}
                  onClick={() => { switchLLMProvider(p.id, p.url, p.model); setLlmStatus('idle'); if (p.id === 'opencode-zen') setLLMConfig({ apiKey: 'public' }) }} />
              ))}
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6, lineHeight: 1.5 }}>
              免费 API 由 OpenCode Zen 提供，无需注册即可使用。适合快速体验和轻度使用。
            </div>
          </div>

          {/* 本地模型 */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 12 }}>🖥️</span> 本地模型
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {LLM_PROVIDERS.filter(p => p.id === 'lmstudio').map(p => (
                <ProviderBtn key={p.id} p={p} active={llmConfig.provider === p.id}
                  onClick={() => { switchLLMProvider(p.id, p.url, p.model); setLlmStatus('idle') }} />
              ))}
            </div>
          </div>

          {/* 云端模型 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 12 }}>☁️</span> 云端模型
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {LLM_PROVIDERS.filter(p => p.id !== 'lmstudio' && !p.free).map(p => (
                <ProviderBtn key={p.id} p={p} active={llmConfig.provider === p.id}
                  onClick={() => { switchLLMProvider(p.id, p.url, p.model); setLlmStatus('idle') }} />
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
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>API 地址</label>
                <input style={inputS} value={llmConfig.baseUrl}
                  onChange={e => setLLMConfig({ baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1" />
              </div>
              <div style={{ flex: '0 0 200px' }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>API 密钥</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}>
                  <input style={{ ...inputS, paddingRight: 35 }}
                    type={showApiKey ? "text" : "password"} value={llmConfig.apiKey}
                    onChange={e => setLLMConfig({ apiKey: e.target.value })}
                    placeholder="sk-..." />
                  <button onClick={() => setShowApiKey(!showApiKey)}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 14, width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    title={showApiKey ? "隐藏密钥" : "显示密钥"}>
                    {showApiKey ? "👁️" : "👁️‍🗨️"}
                  </button>
                </div>
              </div>
            </div>

            {/* 第二行：模型 + 温度 */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>模型</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input style={{ flex: 1, ...inputS }} value={llmConfig.model}
                    onChange={e => setLLMConfig({ model: e.target.value })}
                    placeholder="gpt-4o" />
                  {llmConfig.baseUrl && (
                    <button onClick={fetchModels} disabled={fetchingModels}
                      style={{
                        padding: '6px 10px', borderRadius: 6, fontSize: 11,
                        cursor: fetchingModels ? 'wait' : 'pointer',
                        border: '1px solid var(--border-light)', background: 'var(--surface-0)',
                        color: 'var(--text-secondary)', whiteSpace: 'nowrap',
                        animation: fetchingModels ? 'pulse 1.5s infinite' : 'none',
                      }}>
                      {fetchingModels ? '⏳' : '📋 获取列表'}
                    </button>
                  )}
                </div>
                <ModelPickerModal
                  show={showModelPicker} models={availableModels} currentModel={llmConfig.model}
                  onSelect={(m) => setLLMConfig({ model: m })}
                  onClose={() => setShowModelPicker(false)} isFetching={fetchingModels}
                  baseUrl={llmConfig.baseUrl} apiKey={llmConfig.apiKey}
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
              <div style={{ flex: '0 0 100px' }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>温度</label>
                <input style={{ ...inputS }} type="number" min="0" max="2" step="0.1"
                  value={llmConfig.temperature ?? 0.7}
                  onChange={e => setLLMConfig({ temperature: parseFloat(e.target.value) || 0.7 })} />
              </div>
            </div>

            {/* 高级选项 */}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-light)' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>⚙️ 高级选项</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>最大输出 (tokens)</label>
                  <input style={{ ...inputS }} value={maxTokensDisplay}
                    onChange={e => setMaxTokensDraft(e.target.value)}
                    onBlur={commitMaxTokens}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, display: 'block' }}>上下文窗口 (0=自动)</label>
                  <input style={{ ...inputS }} value={ctxDisplay}
                    onChange={e => setCtxDraft(e.target.value)}
                    onBlur={commitContextWindow}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                </div>
              </div>
            </div>
          </div>

          {/* 操作栏 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <SettingBtn variant="success" onClick={saveProviderToBackend} disabled={savingProvider} loading={savingProvider}>
              💾 保存配置
            </SettingBtn>
            <SettingBtn variant="primary" onClick={testLLM} disabled={llmStatus === 'testing'} loading={llmStatus === 'testing'}>
              ⚡ 测试连接
            </SettingBtn>
            {llmMsg && (
              <span style={{ fontSize: 12, padding: '3px 10px', borderRadius: 6, background: llmStatus === 'ok' ? '#ecfdf5' : 'var(--red-100)', color: llmStatus === 'ok' ? '#065f46' : '#991b1b' }}>
                {llmMsg}
              </span>
            )}
            <button onClick={async () => {
              if (!llmConfig.model || !llmConfig.baseUrl) return
              try {
                for (const a of AGENT_META) {
                  await window.luminaAPI.agentLlmSetConfig?.(a.id, {
                    provider: llmConfig.provider, model: llmConfig.model,
                    endpoint: llmConfig.baseUrl, apiKey: llmConfig.apiKey, timeout: 600,
                  })
                }
                const r = await window.luminaAPI.agentLlmGetAllConfigs?.()
                if (r?.configs) setAgentLlmConfigs(r.configs)
                setNotice('✅ 已同步到 Team！Lumina、Yak、热茶 都使用了此配置。')
              } catch (e: any) { setNotice('❌ 同步失败: ' + (e.message || e)) }
            }}
              disabled={!llmConfig.model || !llmConfig.baseUrl}
              style={{
                marginLeft: 'auto', padding: '5px 12px', borderRadius: 6, fontSize: 11,
                cursor: (!llmConfig.model || !llmConfig.baseUrl) ? 'not-allowed' : 'pointer',
                border: '1px solid var(--border-light)', background: 'var(--surface-0)', color: 'var(--text-secondary)',
                opacity: (!llmConfig.model || !llmConfig.baseUrl) ? 0.4 : 1,
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
              🔄 同步到所有 Team Agent
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
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>团队群聊模式，每个 Agent 可独立配置不同的模型</div>
          </div>
        </div>

        <div style={{ padding: 16 }}>
          {/* 快捷提示 */}
          <div style={{
            marginBottom: 14, padding: '8px 12px', borderRadius: 6,
            background: '#ecfdf5', border: '1px solid #a7f3d0',
            fontSize: 11, color: '#166534', display: 'flex', alignItems: 'center', gap: 6,
          }}>
            💡 在上方「Agent LLM」配置好后，点击 <strong style={{ margin: '0 4px' }}>🔄 同步到所有 Team Agent</strong> 一键同步
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
                if (providerId === 'opencode-zen') next.apiKey = 'public'
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
                      {isConfigured ? '✅ 已配置' : '⚠️ 未配置'}
                    </span>
                  </div>

                  {/* 模型快速选择 */}
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 11 }}>🎯</span> 免费模型
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                    {LLM_PROVIDERS.filter(p => p.free).map(p => (
                      <button key={p.id} onClick={() => handleAgentProvider(p.id, p.url, p.model)} style={agentLabelStyle(cfg.provider === p.id)}>
                        {cfg.provider === p.id ? <span style={{ color: '#3b82f6', fontSize: 10 }}>●</span> : <span style={{ color: '#d1d5db', fontSize: 10 }}>○</span>}
                        {p.name.replace('🎯 ', '').replace('🚀 ', '')}
                        {p.free && <span style={{ fontSize: 8, fontWeight: 700, background: '#22c55e', color: '#fff', borderRadius: 3, padding: '0 4px', lineHeight: '14px' }}>免费</span>}
                      </button>
                    ))}
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
                        onTestConnection={async (modelId) => {
                          try {
                            const res = await window.luminaAPI?.llmTestConnection?.({ baseUrl: cfg.endpoint, apiKey: cfg.apiKey || '', model: modelId })
                            if (res?.success) setNotice(`🔌 ${agent.name} / ${modelId} 连接成功`)
                            else setNotice(`❌ ${agent.name} / ${modelId}: ${res?.error || '连接失败'}`)
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
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 6 }}>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 }}>最大输出 (tokens)</div>
                          <input type="number" min="1" max="524288" style={{ width: '100%', padding: '5px 8px', borderRadius: 5, fontSize: 11, border: '1.5px solid var(--border-light)', outline: 'none', background: 'var(--surface-0)', boxSizing: 'border-box' }}
                            value={cfg.maxTokens ?? 4096}
                            onChange={e => setAgentLlmConfigs(prev => ({ ...prev, [agent.id]: { ...cfg, maxTokens: Math.min(parseInt(e.target.value) || 4096, 524288) } }))} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 }}>上下文窗口</div>
                          <input type="number" min="0" max="1048576" style={{ width: '100%', padding: '5px 8px', borderRadius: 5, fontSize: 11, border: '1.5px solid var(--border-light)', outline: 'none', background: 'var(--surface-0)', boxSizing: 'border-box' }}
                            value={cfg.contextWindow ?? 0}
                            onChange={e => setAgentLlmConfigs(prev => ({ ...prev, [agent.id]: { ...cfg, contextWindow: Math.min(parseInt(e.target.value) || 0, 1048576) } }))} />
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
