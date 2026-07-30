import React, { useState, useEffect } from 'react'
import { useStore } from '../stores/appStore'
import { IconCheck, IconRefresh, IconPlay, IconWifi, IconWifiOff } from '../components/Icons'
import ModeSettings from '../components/ModeSettings'
import WorkflowPanel from '../components/WorkflowPanel'
import SettingsLLM from './settings/SettingsLLM'
import SettingsTTS from './settings/SettingsTTS'
import SettingsNotifications from './settings/SettingsNotifications'
import SettingsAppearance from './settings/SettingsAppearance'
import SettingsPush from './settings/SettingsPush'
import SettingsPet from './settings/SettingsPet'
import SecurityPanel from './SecurityPanel'
import TasksPanel from './TasksPanel'
import ModelPickerModal from './settings/ModelPickerModal'

const LLM_PROVIDERS = [
  // 🆕 免费 API（无需 API Key，开箱即用）
  { id: 'opencode-zen', name: '🎯 OpenCode Zen (免费)', url: 'https://opencode.ai/zen/v1', model: 'deepseek-v4-flash-free', free: true },
  // 本地部署
  { id: 'lmstudio', name: 'LM Studio (本地)', url: 'http://127.0.0.1:1234/v1', model: '' },
  // 云端服务
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', name: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
  { id: 'siliconflow', name: '硅基流动', url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'custom', name: '自定义', url: '', model: '' },
]

const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 — 活泼女声' },
  { id: 'zh-CN-YunxiNeural', label: '云希 — 青年男声' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 — 可爱女声' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 — 新闻男声' },
  { id: 'zh-CN-YunjianNeural', label: '云健 — 运动男声' },
  { id: 'zh-CN-XiaochenNeural', label: '晓辰 — 沉稳女声' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵 — 温柔女声' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼 — 粤语女声' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 — 台湾女声' },
]

// ── Style helpers ──────────────────────────────────────
const sectionTitle: React.CSSProperties = {
  fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
  marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6,
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif'
}
const sectionDesc: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5,
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif'
}
const cardStyle: React.CSSProperties = {
  borderRadius: 10, border: '1px solid var(--border-light)', padding: 20,
  marginBottom: 16, background: 'var(--surface-0)',
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif'
}
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
  marginBottom: 4, display: 'block',
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif'
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 12,
  border: '1.5px solid var(--border-light)', outline: 'none', background: 'var(--surface-0)',
  boxSizing: 'border-box', fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
}

export default function SettingsPanel({ embedded, activeTab, onNotice: _onNotice }: {
  embedded?: boolean
  activeTab?: string
  onNotice?: ((msg: string | null) => void) | null
} = {}) {
  const llmConfig = useStore(s => s.llmConfig)
  const setLLMConfig = useStore(s => s.setLLMConfig)
  const switchLLMProvider = useStore(s => s.switchLLMProvider)
  const ttsConfig = useStore(s => s.ttsConfig)
  const setTTSConfig = useStore(s => s.setTTSConfig)
  const ttsEngine = useStore(s => s.ttsEngine)
  const setLlmOnline = useStore(s => s.setLlmOnline)
  const setLlmChecked = useStore(s => s.setLlmChecked)
  const addAuditLog = useStore(s => s.addAuditLog)
  const agentConfig = useStore(s => s.agentConfig)
  const addCustomPersona = useStore(s => s.addCustomPersona)
  const removeCustomPersona = useStore(s => s.removeCustomPersona)
  const activePersona = useStore(s => s.activePersona)
  const setActivePersona = useStore(s => s.setActivePersona)
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const syncProviderFromBackend = useStore(s => s.syncProviderFromBackend)

  // ── LLM ────────────────────────────────────────────
  const [llmStatus, setLlmStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [llmMsg, setLlmMsg] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; multimodal?: boolean; vision?: boolean }> | null>(null)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)  // v10.0

  // ── Team Agent LLM ────────────────────────────────
  const AGENT_META = [
    { id: 'lumina', name: 'Lumina', icon: '🐱', desc: '全能助手 · 主对话' },
    { id: 'yak', name: 'Yak', icon: '📊', desc: '代码工程师 · 写代码/调试' },
    { id: 'recha', name: '热茶', icon: '🫖', desc: '审查员 · 挑错/反面论证' },
  ]
  const [agentLlmConfigs, setAgentLlmConfigs] = useState<Record<string, any>>({})
  const [teamFetchingModel, setTeamFetchingModel] = useState<string | null>(null)
  const [teamAvailableModels, setTeamAvailableModels] = useState<Record<string, Array<{ id: string; multimodal?: boolean; vision?: boolean }>>>({})
  const [teamShowModelPicker, setTeamShowModelPicker] = useState<string | null>(null)

  // ── TTS ────────────────────────────────────────────
  const [ttsStatus, setTtsStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [ttsMsg, setTtsMsg] = useState('')
  const [edgeRunning, setEdgeRunning] = useState(false)

  // Plan C: 组件挂载时自动检测 Python Node TTS 状态
  // Python Node 随 Lumina 自动启动，TTS 就绪后前端自动显示「运行中」
  useEffect(() => {
    if (ttsEngine !== 'edge') return
    let cancelled = false
    const check = async () => {
      try {
        const status = await window.luminaAPI?.edgeTtsStatus?.()
        if (!cancelled && status?.running) {
          setEdgeRunning(true)
        }
      } catch {}
    }
    // 延迟一点检查，给 Node 启动留时间
    const timer = setTimeout(check, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ttsEngine])

  // ── v10.0: 组件挂载时从后端 ProviderManager 同步配置 ──
  useEffect(() => {
    syncProviderFromBackend()
  }, [])

  // ── 组件挂载时加载已保存的 Team Agent LLM 配置 ──
  useEffect(() => {
    (async () => {
      try {
        const r = await window.luminaAPI?.agentLlmGetAllConfigs?.()
        if (r?.configs) {
          console.log('[SettingsPanel] ✅ Team Agent LLM 配置已加载:', r.configs)
          setAgentLlmConfigs(r.configs)
        } else {
          console.warn('[SettingsPanel] ⚠️ agentLlmGetAllConfigs 未返回 configs:', r)
        }
      } catch (e) {
        console.error('[SettingsPanel] ❌ 加载 Team Agent LLM 配置失败:', e)
      }
    })()
  }, [])

  // ── UI ─────────────────────────────────────────────
  const [maxTokensDraft, setMaxTokensDraft] = useState<string | null>(null)
  const maxTokensDisplay = maxTokensDraft !== null ? maxTokensDraft : String(llmConfig.maxTokens)
  const [ctxDraft, setCtxDraft] = useState<string | null>(null)
  const ctxDisplay = ctxDraft !== null ? ctxDraft : String(llmConfig.contextWindow || 0)

  // 最大输出提交：校验并落盘
  const commitMaxTokens = () => {
    if (maxTokensDraft === null) return
    const n = parseInt(maxTokensDraft, 10)
    if (!isNaN(n) && n > 0 && n <= 1048576) {
      setLLMConfig({ maxTokens: n })
    }
    setMaxTokensDraft(null)
  }

  // 上下文窗口提交：校验并落盘
  const commitContextWindow = () => {
    if (ctxDraft === null) return
    const n = parseInt(ctxDraft, 10)
    if (!isNaN(n) && n >= 0 && n <= 1048576) {
      setLLMConfig({ contextWindow: n })
    }
    setCtxDraft(null)
  }
  const [proactiveNotify, setProactiveNotify] = useState(() => {
    try { return localStorage.getItem('lumina_proactive_notify') !== 'false' } catch { return true }
  })
  const [notice, setNotice] = useState<string | null>(null)
  const [settingsTab, setSettingsTab] = useState<'llm' | 'tts' | 'notifications' | 'appearance' | 'push' | 'channels' | 'agentPool' | 'pet' | 'routing' | 'access' | 'modes' | 'workflow' | 'security' | 'tasks'>(
    (activeTab as any) || 'llm'
  )
  // 当 embedded + activeTab 变化时同步内部状态
  useEffect(() => {
    if (embedded && activeTab && activeTab !== settingsTab) {
      setSettingsTab(activeTab as any)
    }
  }, [embedded, activeTab])
  const [showApiKey, setShowApiKey] = useState(false)  // API密钥可见性控制
  const [teamShowApiKey, setTeamShowApiKey] = useState<Record<string, boolean>>({})  // Team Agent API密钥可见性控制
  const [teamAdvancedOpen, setTeamAdvancedOpen] = useState<Record<string, boolean>>({})

  // ── 📱 多渠道推送 ──────────────────────
  const [pushConfig, setPushConfigState] = useState({
    serverChanKey: '', dingTalkWebhook: '', dingTalkSecret: '',
    notifyNewMail: true, notifyDream: true, notifyLevelUp: true, notifyCapsule: true, notifyTaskDone: true,
  })
  const [testingChan, setTestingChan] = useState(false)
  const [testChanResult, setTestChanResult] = useState<boolean | null>(null)
  const [testingDing, setTestingDing] = useState(false)
  const [testDingResult, setTestDingResult] = useState<boolean | null>(null)

  const setPushConfig = (cfg: typeof pushConfig) => {
    setPushConfigState(cfg)
    window.luminaAPI?.pushUpdateConfig?.(cfg)
  }

  const testServerChan = async () => {
    if (!pushConfig.serverChanKey) return
    setTestingChan(true)
    setTestChanResult(null)
    try {
      const res = await window.luminaAPI?.pushTestServerChan?.(pushConfig.serverChanKey)
      setTestChanResult(res?.ok ?? false)
    } catch { setTestChanResult(false) }
    setTestingChan(false)
  }

  const testDingTalk = async () => {
    if (!pushConfig.dingTalkWebhook) return
    setTestingDing(true)
    setTestDingResult(null)
    try {
      const res = await window.luminaAPI?.pushTestDingTalk?.(pushConfig.dingTalkWebhook, pushConfig.dingTalkSecret)
      setTestDingResult(res?.ok ?? false)
    } catch { setTestDingResult(false) }
    setTestingDing(false)
  }

  // ── 📱 推送事件列表 ──────────────────────────────
  const pushEventItems = [
    { key: 'notifyNewMail', label: '📧 新邮件通知' },
    { key: 'notifyDream', label: '🌙 新梦境通知' },
    { key: 'notifyLevelUp', label: '🎉 等级提升通知' },
    { key: 'notifyCapsule', label: '📮 时光胶囊到期' },
    { key: 'notifyTaskDone', label: '✅ 定时任务完成' },
  ]

  // ── 💻 桌宠模式 (v2.0 Plan C) ────────────────────
  const [petRunning, setPetRunning] = useState(false)
  const [petClickThrough, setPetClickThrough] = useState(false)
  const [petAutoRestart, setPetAutoRestart] = useState(true)
  const [petOpacity, setPetOpacity] = useState(1.0)

  const handlePetToggle = async () => {
    const next = !petRunning
    try {
      const res = await window.luminaAPI?.petToggle?.(next)
      if (res?.ok) setPetRunning(next)
    } catch {
      console.error('[SettingsPanel] 桌宠切换失败')
    }
  }

  const handlePetClickThroughToggle = async () => {
    const next = !petClickThrough
    try {
      const res = await window.luminaAPI?.petUpdateConfig?.({ clickThrough: next })
      if (res?.ok) setPetClickThrough(next)
    } catch {}
  }

  const handlePetAutoRestartToggle = async () => {
    const next = !petAutoRestart
    try {
      const res = await window.luminaAPI?.petUpdateConfig?.({ autoRestart: next })
      if (res?.ok) setPetAutoRestart(next)
    } catch {}
  }

  // 监听桌宠事件
  useEffect(() => {
    const unsubscribe = window.luminaAPI?.onPetEvent?.((event) => {
      if (event.type === 'double-click') {
        // 双击桌宠 → 主窗口显示
      }
      if (event.type === 'idle-long') {
        // 可触发主动问候
      }
    })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    (async () => {
      try {
        const status = await window.luminaAPI?.petStatus?.()
        if (status) {
          setPetRunning(true)
          const cfg = await window.luminaAPI?.petConfig?.()
          if (cfg) {
            setPetClickThrough(cfg.clickThrough)
            setPetAutoRestart(cfg.autoRestart)
            setPetOpacity(cfg.opacity)
          }
        }
      } catch {}
    })()
  }, [])

  // ══════════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════════

  // ── 模型选择弹窗（居中模态框）────────────────────────
  const ModelPickerModal = ({
    show,
    models,
    currentModel,
    onSelect,
    onClose,
    isFetching,
    baseUrl,
    apiKey,
    onTestConnection,
    onTestMultimodal,
  }: {
    show: boolean;
    models: Array<{ id: string; multimodal?: boolean; vision?: boolean }> | null;
    currentModel: string;
    onSelect: (model: string) => void;
    onClose: () => void;
    isFetching: boolean;
    baseUrl?: string;
    apiKey?: string;
    onTestConnection?: (modelId: string) => void;
    onTestMultimodal?: (modelId: string) => void;
  }) => {
    if (!show) return null;

    return (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          backgroundColor: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'fadeIn 0.15s ease-out',
          fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
        }}
        onClick={onClose}
      >
        <div
          style={{
            backgroundColor: 'var(--surface-0)',
            borderRadius: 16,
            boxShadow: '0 16px 48px rgba(0,0,0,0.2)',
            width: 460,
            maxHeight: '80vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            animation: 'fadeInDown 0.2s ease-out',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── 弹窗头部 ── */}
          <div style={{
            padding: '18px 22px',
            borderBottom: '1px solid var(--border-light)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#1e293b' }}>
                🧠 选择模型
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3, lineHeight: 1.4 }}>
                {baseUrl && (
                  <span style={{ wordBreak: 'break-all', fontFamily: 'monospace' }}>
                    {baseUrl}
                  </span>
                )}
                {models && models.length > 0 && (
                  <span> · 共 {models.length} 个</span>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              style={{
                border: 'none', background: 'transparent', cursor: 'pointer',
                fontSize: 16, color: '#94a3b8',
                width: 30, height: 30, borderRadius: 8,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#f1f5f9';
                e.currentTarget.style.color = '#475569';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '#94a3b8';
              }}
            >
              ✕
            </button>
          </div>

          {/* ── 弹窗主体 ── */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 140, padding: 0 }}>

            {/* 加载中（shimmer 动效） */}
            {isFetching && (
              <div style={{ padding: '36px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                <div style={{
                  width: 36, height: 36,
                  border: '3px solid #e2e8f0',
                  borderTopColor: '#3b82f6',
                  borderRadius: '50%',
                  animation: 'spin 0.7s linear infinite',
                }} />
                <div style={{ color: '#64748b', fontSize: 13 }}>正在获取模型列表…</div>
                {/* 骨架屏模拟 */}
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                  {[1,2,3,4].map(i => (
                    <div key={i} style={{
                      height: 48, borderRadius: 8,
                      background: 'linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 50%, #f1f5f9 75%)',
                      backgroundSize: '200% 100%',
                      animation: 'shimmer 1.5s infinite',
                      opacity: 1 - i * 0.15,
                    }} />
                  ))}
                </div>
              </div>
            )}

            {/* 获取失败 */}
            {!isFetching && !models && (
              <div style={{
                padding: '48px 22px', textAlign: 'center',
              }}>
                <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.5 }}>⚠️</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#475569', marginBottom: 6 }}>获取模型列表失败</div>
                <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.8, maxWidth: 280, margin: '0 auto' }}>
                  <div>请检查 API 地址和密钥是否正确</div>
                  <div style={{ marginTop: 4, fontSize: 11, fontFamily: 'monospace', background: '#f8fafc', padding: '6px 10px', borderRadius: 6, color: '#64748b', wordBreak: 'break-all' }}>
                    {baseUrl || '未设置地址'}
                  </div>
                </div>
              </div>
            )}

            {/* 空列表 */}
            {!isFetching && models && models.length === 0 && (
              <div style={{
                padding: '48px 22px', textAlign: 'center',
              }}>
                <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.5 }}>📭</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#475569', marginBottom: 6 }}>没有可用模型</div>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>
                  请先在服务端加载模型
                </div>
              </div>
            )}

            {/* 模型列表 */}
            {!isFetching && models && models.length > 0 && (
              <div style={{ padding: '6px 0' }}>
                {models.map((model, index) => {
                  const isActive = model.id === currentModel;
                  const isMultimodal = model.multimodal || model.vision;
                  return (
                    <div
                      key={model.id}
                      onClick={() => { onSelect(model.id); onClose(); }}
                      style={{
                        padding: '12px 22px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        borderLeft: '3px solid transparent',
                        borderLeftColor: isActive ? '#3b82f6' : 'transparent',
                        backgroundColor: isActive ? '#f0f7ff' : 'transparent',
                        transition: 'all 0.12s',
                        animation: 'fadeIn 0.12s ease-out ' + (index * 0.03) + 's both',
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.backgroundColor = '#f8fafc';
                          e.currentTarget.style.borderLeftColor = '#e2e8f0';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.backgroundColor = 'transparent';
                          e.currentTarget.style.borderLeftColor = 'transparent';
                        }
                      }}
                    >
                      {/* 左侧选中指示器 */}
                      <div style={{
                        width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                        border: '2px solid',
                        borderColor: isActive ? '#3b82f6' : '#d1d5db',
                        backgroundColor: isActive ? '#3b82f6' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, color: '#fff', fontWeight: 700,
                        transition: 'all 0.15s',
                      }}>
                        {isActive ? '✓' : ''}
                      </div>

                      {/* 模型信息 */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 13,
                          fontWeight: isActive ? 600 : 500,
                          color: isActive ? '#1e40af' : '#1e293b',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
                        }}>
                          {model.id}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
                          {isMultimodal && (
                            <span style={{
                              fontSize: 10,
                              background: '#dbeafe',
                              color: '#1d4ed8',
                              padding: '2px 7px',
                              borderRadius: 4,
                              fontWeight: 600,
                              letterSpacing: '0.3px',
                            }}>
                              🖼️ 多模态
                            </span>
                          )}
                          {!isMultimodal && (
                            <span style={{
                              fontSize: 10,
                              background: '#f1f5f9',
                              color: '#64748b',
                              padding: '2px 7px',
                              borderRadius: 4,
                            }}>
                              📝 文本
                            </span>
                          )}
                        </div>
                        {/* 测试按钮 */}
                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onTestConnection?.(model.id);
                            }}
                            style={{
                              padding: '3px 10px',
                              borderRadius: 4,
                              fontSize: 10,
                              border: '1px solid #e2e8f0',
                              background: '#fafafa',
                              color: '#64748b',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 3,
                              transition: 'all 0.12s',
                              fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.borderColor = '#3b82f6';
                              e.currentTarget.style.color = '#3b82f6';
                              e.currentTarget.style.background = '#eff6ff';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.borderColor = '#e2e8f0';
                              e.currentTarget.style.color = '#64748b';
                              e.currentTarget.style.background = '#fafafa';
                            }}
                          >
                            <span style={{ fontSize: 11 }}>🔌</span> 连接测试
                          </button>
                          {isMultimodal && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onTestMultimodal?.(model.id);
                              }}
                              style={{
                                padding: '3px 10px',
                                borderRadius: 4,
                                fontSize: 10,
                                border: '1px solid #e2e8f0',
                                background: '#fafafa',
                                color: '#64748b',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 3,
                                transition: 'all 0.12s',
                                fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.borderColor = '#16a34a';
                                e.currentTarget.style.color = '#16a34a';
                                e.currentTarget.style.background = '#f0fdf4';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.borderColor = '#e2e8f0';
                                e.currentTarget.style.color = '#64748b';
                                e.currentTarget.style.background = '#fafafa';
                              }}
                            >
                              <span style={{ fontSize: 11 }}>🖼️</span> 多模态测试
                            </button>
                          )}
                        </div>
                      </div>

                      {/* 右侧模型类型标签 */}
                      {isMultimodal && (
                        <span style={{
                          fontSize: 9,
                          background: '#f0fdf4',
                          color: '#16a34a',
                          padding: '2px 8px',
                          borderRadius: 10,
                          fontWeight: 600,
                          border: '1px solid #bbf7d0',
                          flexShrink: 0,
                        }}>
                          Vision
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ── Provider Button ──────────────────────────────;

  // ── Provider Button ──────────────────────────────
  // ── Provider Button ──────────────────────────────
  const ProviderBtn = ({ p, active, onClick }: {
    p: { id: string; name: string; url: string; model: string; free?: boolean };
    active: boolean;
    onClick: () => void;
  }) => (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '4px 12px', borderRadius: 8, fontSize: 11, fontWeight: active ? 600 : 400,
      border: `1.5px solid ${active ? '#3b82f6' : 'var(--border-light)'}`,
      background: active ? 'var(--accent-50)' : 'var(--surface-0)',
      color: active ? '#2563eb' : 'var(--text-secondary)',
      cursor: 'pointer', transition: 'all 0.15s',
    }}>
      {active
        ? <span style={{ color: '#3b82f6', fontSize: 11 }}>●</span>
        : <span style={{ color: '#d1d5db', fontSize: 11 }}>○</span>}
      {p.name}
      {p.free && (
        <span style={{
          fontSize: 9, fontWeight: 700, background: '#22c55e', color: '#fff',
          borderRadius: 4, padding: '0 5px', lineHeight: '16px', marginLeft: 2,
        }}>免费</span>
      )}
    </button>
  )

  // ── LLM 连接测试 ─────────────────────────────────
  const testLLM = async () => {
    if (!llmConfig.model || !llmConfig.baseUrl) return
    setLlmStatus('testing')
    setLlmMsg('')
    try {
      const res = await window.luminaAPI?.llmTestConnection?.({ baseUrl: llmConfig.baseUrl, apiKey: llmConfig.apiKey || '', model: llmConfig.model })
      if (res?.success) {
        setLlmStatus('ok')
        setLlmMsg(`✅ 连接成功 (${res.latency || 'N/A'}ms)`)
        setLlmOnline(true)
        setLlmChecked(true)
      } else {
        setLlmStatus('fail')
        setLlmMsg(`❌ ${res?.error || '连接失败'}`)
        setLlmOnline(false)
        setLlmChecked(true)
      }
    } catch (e: any) {
      setLlmStatus('fail')
      setLlmMsg(`❌ ${e.message || '未知错误'}`)
      setLlmOnline(false)
      setLlmChecked(true)
    }
  }

  // ── v10.0: 保存配置到后端 ProviderManager ──────────
  const saveProviderToBackend = async () => {
    const { provider, baseUrl, apiKey, model } = useStore.getState().llmConfig
    if (!provider) return
    setSavingProvider(true)
    try {
      // 1) 保存配置
      await window.luminaAPI?.providerSaveConfig?.(provider, {
        baseUrl, apiKey: apiKey || '', model, enabled: true, timeout: 600, maxContextTokens: 256000,
      })
      // 2) 设为激活
      await window.luminaAPI?.providerSetActive?.(provider)
      // 3) 标记为在线（TopBar 状态指示器会响应）
      setLlmOnline(true)
      setLlmChecked(true)
      setNotice(`✅ 供应商配置已保存 (${provider})`)
    } catch (e: any) {
      setNotice('❌ 保存失败: ' + (e.message || e))
    }
    setSavingProvider(false)
  }

  // ── 获取模型列表 ─────────────────────────────────
  const fetchModels = async () => {
    // 🔧 直接从 store 读取最新配置，避免闭包陈旧值
    const { provider, baseUrl, apiKey } = useStore.getState().llmConfig
    if (!baseUrl) return
    setShowModelPicker(true)
    setAvailableModels(null)
    setFetchingModels(true)

    // v10.0: 优先使用新 provider 系统
    try {
      if (window.luminaAPI?.providerFetchModels && provider) {
        const res = await window.luminaAPI.providerFetchModels(provider)
        if (res?.models && res.models.length > 0) {
          setAvailableModels(res.models)
          setFetchingModels(false)
          return
        }
      }
    } catch {}

    // 回退到旧方式
    try {
      const res = await window.luminaAPI?.llmFetchModels?.({ baseUrl, apiKey: apiKey || '' })
      if (res?.models) {
        setAvailableModels(res.models)
      }
    } catch {}
    setFetchingModels(false)
  }

  // ── Team Agent 模型获取 ────────────────────────────
  const fetchTeamModels = async (agentId: string) => {
    const cfg = agentLlmConfigs[agentId]
    if (!cfg?.endpoint) return
    setTeamShowModelPicker(agentId)   // ← 立即打开弹窗，显示加载中
    setTeamAvailableModels(prev => ({ ...prev, [agentId]: null as any }))  // ← 清空旧模型
    setTeamFetchingModel(agentId)
    try {
      const res = await window.luminaAPI?.llmFetchModels?.({ baseUrl: cfg.endpoint, apiKey: cfg.apiKey || '' })
      if (res?.models) {
        setTeamAvailableModels(prev => ({ ...prev, [agentId]: res.models }))
      }
    } catch {}
    setTeamFetchingModel(null)
  }

  // ── TTS 试听 ─────────────────────────────────────
  const testTTS = async () => {
    if (!edgeRunning) return
    setTtsStatus('testing')
    setTtsMsg('')
    try {
      const res = await window.luminaAPI?.edgeTtsSpeak?.({
        text: '你好，这是语音试听。',
        voice: ttsConfig.voice,
        speed: ttsConfig.speed,
      })
      if (res?.audio) {
        // 用浏览器 Audio 播放返回的 base64 音频
        const audio = new Audio(res.audio)
        audio.play().catch(() => {})
        setTtsStatus('ok')
        setTtsMsg('✅ 试听中...')
      } else if (res?.error) {
        setTtsStatus('fail')
        setTtsMsg(`❌ ${res.error}`)
      } else {
        setTtsStatus('fail')
        setTtsMsg('❌ 播放失败：无返回数据')
      }
    } catch (e: any) {
      setTtsStatus('fail')
      setTtsMsg(`❌ ${e.message || '未知错误'}`)
    }
  }

  // ── Edge TTS 启动/停止 ────────────────────────────
  const startEdge = async () => {
    try {
      const res = await window.luminaAPI?.edgeTtsStart?.()
      if (res?.ok) setEdgeRunning(true)
    } catch {}
  }
  const stopEdge = async () => {
    try {
      await window.luminaAPI?.edgeTtsStop?.()
      setEdgeRunning(false)
    } catch {}
  }

  // ── 保存 Agent LLM 配置 ──────────────────────────
  const saveAgentLlm = async (agentId: string) => {
    const cfg = agentLlmConfigs[agentId] || {
      provider: llmConfig.provider,
      model: llmConfig.model,
      endpoint: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey,
      timeout: 600,
    }
    try {
      const res: any = await window.luminaAPI?.agentLlmSetConfig?.(agentId, {
        provider: cfg.provider || llmConfig.provider,
        model: cfg.model || llmConfig.model,
        endpoint: cfg.endpoint || llmConfig.baseUrl,
        apiKey: cfg.apiKey || llmConfig.apiKey,
        timeout: cfg.timeout || 600,
      })
      console.log('[SettingsPanel] saveAgentLlm result:', res)
      if (res && res.success === false) {
        setNotice('❌ 保存失败: ' + (res.error || '后端未知错误'))
        return
      }
      // 保存成功后重新加载，确保 UI 与后端一致
      const r = await window.luminaAPI?.agentLlmGetAllConfigs?.()
      if (r?.configs) {
        setAgentLlmConfigs(r.configs)
      }
      setNotice(`✅ ${AGENT_META.find(a => a.id === agentId)?.name || agentId} 配置已保存`)
    } catch (e: any) { setNotice('❌ 保存失败: ' + (e.message || e)) }
  }

  return (
    <div className="panel">
      {/* Notice */}
      {notice && (
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
      )}

      {!embedded && (<>
      <div className="panel-header">
        <div className="panel-title">⚙️ 设置</div>
        <div className="panel-subtitle">配置 LLM 供应商与语音合成</div>
      </div>

      {/* ── 设置标签页导航 ── */}
      <div style={{
        display: 'flex', gap: 0, borderBottom: '2px solid var(--border-light)',
        marginBottom: 16, background: 'var(--surface-0)', flexShrink: 0,
        padding: '0 4px', overflowX: 'auto',
      }}>
        {[
          { key: 'llm' as const, label: 'LLM 模型配置', icon: '🧠' },
          { key: 'tts' as const, label: 'TTS 语音', icon: '🔊' },
          { key: 'notifications' as const, label: '主动通知', icon: '🔔' },
          { key: 'appearance' as const, label: '外观', icon: '🎨' },
          { key: 'push' as const, label: '多渠道推送', icon: '📱' },
          { key: 'channels' as const, label: '渠道接入', icon: '📡' },
          { key: 'agentPool' as const, label: '常驻 Agent', icon: '🏊' },
          { key: 'routing' as const, label: '意图路由', icon: '🧭' },
          { key: 'access' as const, label: '权限控制', icon: '🔒' },
          { key: 'modes' as const, label: '场景模式', icon: '🎯' },
          { key: 'workflow' as const, label: '工作流模板', icon: '📋' },
          { key: 'security' as const, label: '安全中心', icon: '🛡️' },
          { key: 'tasks' as const, label: '定时任务', icon: '⏰' },
          { key: 'pet' as const, label: '桌宠模式', icon: '💻' },
        ].map(tab => (
          <button key={tab.key} onClick={() => setSettingsTab(tab.key)}
            style={{
              padding: '8px 16px', border: 'none',
              borderBottom: settingsTab === tab.key ? '2px solid #3b82f6' : '2px solid transparent',
              background: 'none', cursor: 'pointer', fontSize: 12,
              fontWeight: settingsTab === tab.key ? 600 : 400,
              color: settingsTab === tab.key ? '#3b82f6' : 'var(--text-secondary)',
              marginBottom: -2, transition: 'all 0.2s',
              display: 'flex', alignItems: 'center', gap: 5,
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
      </>)}

      {settingsTab === 'llm' && <SettingsLLM />}
      {/* ════════════════════════════════════════════════
          ② TTS 语音
          ════════════════════════════════════════════════ */}
      {settingsTab === 'tts' && <SettingsTTS />}
      {/* ════════════════════════════════════════════════
          ③ 主动通知
          ════════════════════════════════════════════════ */}
      {settingsTab === 'notifications' && <SettingsNotifications />}
      {/* ════════════════════════════════════════════════
          ④ 外观主题 (v1.1)
          ════════════════════════════════════════════════ */}
      {settingsTab === 'appearance' && <SettingsAppearance />}

      {/* ════════════════════════════════════════════════
          ⑤ 多渠道推送
          ════════════════════════════════════════════════ */}
      {settingsTab === 'push' && <SettingsPush />}

      {/* ════════════════════════════════════════════════
          ⑥ 桌宠模式
          ════════════════════════════════════════════════ */}
      {settingsTab === 'pet' && <SettingsPet />}

      {/* ════════════════════════════════════════════════
         ⑥ 渠道接入 (v16.0-fix)
         ════════════════════════════════════════════════ */}
      {settingsTab === 'channels' && (<>
        <ChannelSettings />
      </>)}

      {/* ════════════════════════════════════════════════
         ⑦ Agent 常驻池 (v16.0-fix)
         ════════════════════════════════════════════════ */}
      {settingsTab === 'agentPool' && (<>
        <AgentPoolSettings />
      </>)}

      {/* ════════════════════════════════════════════════
         ⑧ 意图路由 (v16.0-fix P3)
         ════════════════════════════════════════════════ */}
      {settingsTab === 'routing' && (<>
        <IntentRouterSettings />
      </>)}

      {/* ════════════════════════════════════════════════
         ⑨ 权限控制 (v16.0-fix P4)
         ════════════════════════════════════════════════ */}
      {settingsTab === 'access' && (<>
        <AccessControlSettings />
      </>)}

      {/* ════════════════════════════════════════════════
         ⑩ 场景模式 (v8.1)
         ════════════════════════════════════════════════ */}
      {settingsTab === 'modes' && (<>
        <ModeSettings />
      </>)}

      {/* ════════════════════════════════════════════════
         ⑪ 工作流模板 (v8.1)
         ════════════════════════════════════════════════ */}
      {settingsTab === 'workflow' && (<>
        <WorkflowPanel />
      </>)}

      {/* ════════════════════════════════════════════════
         🛡️ 安全中心
         ════════════════════════════════════════════════ */}
      {settingsTab === 'security' && (<>
        <SecurityPanel embedded />
      </>)}

      {/* ════════════════════════════════════════════════
         ⏰ 定时任务
         ════════════════════════════════════════════════ */}
      {settingsTab === 'tasks' && (<>
        <TasksPanel embedded />
      </>)}

    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 渠道配置面板 (v16.0-fix)
// ═══════════════════════════════════════════════════════════

const CHANNEL_TYPES: Array<{
  id: string; label: string; icon: string; desc: string
  guide?: string
  fields: Array<{ key: string; label: string; placeholder: string; secret?: boolean }>
}> = [
  {
    id: 'dingtalk', label: '钉钉', icon: '🔵',
    desc: '钉钉开放平台应用，支持单聊和群聊',
    guide: '在钉钉开放平台创建应用 → 消息推送 → Stream 模式',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: '输入钉钉应用的 Client ID', secret: true },
      { key: 'clientSecret', label: 'Client Secret', placeholder: '输入钉钉应用的 Client Secret', secret: true },
      { key: 'robotCode', label: 'Robot Code', placeholder: '输入机器人编码（可选）' },
    ],
  },
  {
    id: 'wechat', label: '企业微信', icon: '💼',
    desc: '企业微信群 Bot，支持 Webhook 和应用消息',
    guide: '企业微信后台 → 应用管理 → 自建应用 → Webhook 或回调配置',
    fields: [
      { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...', secret: true },
      { key: 'corpId', label: 'Corp ID', placeholder: '企业 ID（可选，API 模式）', secret: true },
      { key: 'corpSecret', label: 'Corp Secret', placeholder: '应用的 Secret（可选）', secret: true },
      { key: 'agentId', label: 'Agent ID', placeholder: '应用 Agent ID（可选）' },
    ],
  },
  {
    id: 'qq', label: 'QQ 机器人', icon: '🐧',
    desc: 'QQ 官方 Bot API，支持 WebSocket 和 Webhook 两种模式',
    guide: 'QQ 开放平台 (bot.q.qq.com) → 创建机器人 → 获取 AppID、Token 和 Secret',
    fields: [
      { key: 'appId', label: 'Bot App ID', placeholder: '输入 QQ 机器人的 App ID', secret: false },
      { key: 'botToken', label: 'Bot Token', placeholder: '输入 QQ 机器人的 Token', secret: true },
      { key: 'botSecret', label: 'Bot Secret (AppSecret)', placeholder: '用于 Webhook 签名校验（可选）', secret: true },
    ],
  },
  {
    id: 'slack', label: 'Slack', icon: '💬',
    desc: 'Slack App，支持频道消息和私信',
    guide: 'Slack API (api.slack.com) → 创建 App → Bot Token',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: 'xoxb-...', secret: true },
      { key: 'signingSecret', label: 'Signing Secret', placeholder: '签名密钥（可选）', secret: true },
    ],
  },
  {
    id: 'telegram', label: 'Telegram', icon: '✈️',
    desc: 'Telegram Bot，支持单聊和群组',
    guide: '在 @BotFather 创建 Bot → 获取 Token → 配置 Webhook',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...', secret: true },
    ],
  },
]

function ChannelSettings() {
  const [configs, setConfigs] = React.useState<Record<string, any>>({})
  const [loading, setLoading] = React.useState(true)
  const [editing, setEditing] = React.useState<string | null>(null)
  const [editForm, setEditForm] = React.useState<Record<string, string>>({})
  const [editOptions, setEditOptions] = React.useState<Record<string, any>>({})
  const [editName, setEditName] = React.useState('')
  const [status, setStatus] = React.useState<Array<{key: string; type: string; name: string; online: boolean}>>([])
  const [testResult, setTestResult] = React.useState<{key: string; ok: boolean; error?: string} | null>(null)

  React.useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [c, s] = await Promise.all([
        window.luminaAPI.channelGetConfigs(),
        window.luminaAPI.channelGetStatus(),
      ])
      const configMap: Record<string, any> = {}
      c.forEach((item: any, i: number) => {
        configMap[`channel_${i}`] = item
      })
      setConfigs(configMap)
      setStatus(Array.isArray(s) ? s : [])
    } catch (err) {
      console.error('[ChannelSettings] 加载失败:', err)
    }
    setLoading(false)
  }

  const handleEdit = (key: string) => {
    const cfg = configs[key]
    if (!cfg) return
    setEditing(key)
    setEditName(cfg.name || '')
    setEditForm({ ...cfg.credentials || {} })
    setEditOptions({ ...cfg.options || {} })
    setTestResult(null)
  }

  const handleSave = async (key: string, typeId: string) => {
    await window.luminaAPI.channelUpdateConfig(key, {
      type: typeId,
      name: editName,
      enabled: true,
      credentials: editForm,
      options: editOptions,
    })
    setEditing(null)
    loadData()
  }

  const handleTest = async (key: string) => {
    setTestResult(null)
    const result = await window.luminaAPI.channelTest(key)
    setTestResult({ key, ...result })
    setTimeout(() => setTestResult(null), 3000)
  }

  const handleAdd = async (typeId: string) => {
    const template = CHANNEL_TYPES.find(t => t.id === typeId)
    if (!template) return
    const emptyCredentials: Record<string, string> = {}
    template.fields.forEach(f => { emptyCredentials[f.key] = '' })

    // 创建临时配置
    await window.luminaAPI.channelUpdateConfig(`new_${Date.now()}`, {
      type: typeId,
      name: template.label,
      enabled: false,
      credentials: emptyCredentials,
    })
    loadData()
  }

  if (loading) {
    return <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 12 }}>加载中...</div>
  }

  return (
    <div style={{ padding: '0 0 20px 0' }}>

      {/* 渠道列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {Object.entries(configs).length === 0 && (
          <div style={{
            padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13,
            background: 'var(--surface-100)', borderRadius: 10, lineHeight: 1.8,
          }}>
            📡 暂无渠道配置<br />
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>选择下方平台添加，配置凭证后 Lumina 就能接入 IM 啦</span>
          </div>
        )}
        {Object.entries(configs).map(([key, cfg]) => {
          const typeInfo = CHANNEL_TYPES.find(t => t.id === cfg.type)
          const online = status.find(s => s.key === key)?.online
          return (
            <div key={key} style={{
              padding: 14, borderRadius: 10,
              background: 'var(--surface-100)',
              border: `1px solid ${online ? '#10b98140' : 'var(--border-light)'}`,
              transition: 'all 0.2s',
            }}>
              {editing === key ? (
                // 编辑模式
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 14 }}>{typeInfo?.icon}</span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {editName || typeInfo?.label}
                    </span>
                  </div>

                  {typeInfo?.guide && (
                    <div style={{
                      fontSize: 10, color: '#6366f1', background: '#6366f110',
                      padding: '6px 10px', borderRadius: 6, marginBottom: 10,
                      lineHeight: 1.5,
                    }}>
                      📖 {typeInfo.guide}
                    </div>
                  )}

                  <div style={{
                    background: 'var(--surface-50)', borderRadius: 8, padding: 10,
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6 }}>
                      渠道名称
                    </div>
                    <input
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      placeholder="渠道名称"
                      style={inputStyle}
                    />
                    {typeInfo?.fields.map(f => (
                      <div key={f.key} style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 3 }}>
                          {f.label}
                        </div>
                        <input
                          type={f.secret ? 'password' : 'text'}
                          value={editForm[f.key] || ''}
                          onChange={e => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          style={inputStyle}
                        />
                      </div>
                    ))}
                    {/* QQ 专属：WebSocket 模式选项 */}
                    {cfg?.type === 'qq' && (
                      <div style={{ marginTop: 12, padding: '8px 10px', background: '#f0f5ff', borderRadius: 6, border: '1px solid #d6e4ff' }}>
                        <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 600 }}>⚙️ 连接方式</div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, marginBottom: 6 }}>
                          <input type="checkbox" checked={editOptions.wsMode === true}
                            onChange={e => setEditOptions(prev => ({ ...prev, wsMode: e.target.checked }))} />
                          WebSocket 模式（无需公网，推荐本地开发）
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, marginBottom: 4 }}>
                          <input type="checkbox" checked={editOptions.enableC2C === true}
                            onChange={e => setEditOptions(prev => ({ ...prev, enableC2C: e.target.checked }))} />
                          接收 QQ 消息列表私聊（需申请权限）
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11 }}>
                          <input type="checkbox" checked={editOptions.enableGroup === true}
                            onChange={e => setEditOptions(prev => ({ ...prev, enableGroup: e.target.checked }))} />
                          接收 QQ 群聊消息（需申请权限）
                        </label>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button onClick={() => handleSave(key, cfg.type)} style={{
                      ...chBtnPrimary, flex: 1, justifyContent: 'center',
                    }}>💾 保存配置</button>
                    <button onClick={() => { setEditing(null); setTestResult(null) }} style={chBtnSecondary}>取消</button>
                  </div>
                </div>
              ) : (
                // 展示模式
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 18 }}>{typeInfo?.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {cfg.name || typeInfo?.label || cfg.type}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {typeInfo?.desc}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        fontSize: 10, padding: '3px 10px', borderRadius: 12,
                        background: cfg.enabled
                          ? (online ? '#10b98120' : '#f59e0b20')
                          : '#6b728020',
                        color: cfg.enabled
                          ? (online ? '#10b981' : '#f59e0b')
                          : '#6b7280',
                        fontWeight: 500,
                      }}>
                        {cfg.enabled ? (online ? '🟢 在线' : '🟡 离线') : '⚪ 未启用'}
                      </span>
                    </div>
                  </div>

                  {typeInfo?.guide && !editing && (
                    <div style={{
                      fontSize: 10, color: 'var(--text-tertiary)', marginTop: 6,
                      padding: '4px 0',
                    }}>
                      📖 配置指引: {typeInfo.guide}
                    </div>
                  )}

                  {testResult?.key === key && (
                    <div style={{
                      marginTop: 8, fontSize: 11, padding: '4px 10px', borderRadius: 6,
                      background: testResult.ok ? '#10b98110' : '#ef444410',
                      color: testResult.ok ? '#10b981' : '#ef4444',
                    }}>
                      {testResult.ok ? '✅ 连接测试通过' : `❌ ${testResult.error || '测试失败'}`}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                    <button onClick={() => handleEdit(key)} style={{
                      ...chBtnSmall,
                      background: 'var(--surface-200)',
                    }}>✏️ 编辑</button>
                    <button onClick={() => handleTest(key)} style={{
                      ...chBtnSmall,
                      background: 'var(--surface-200)',
                    }}>🔌 测试</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 添加渠道 */}
      <div style={{ marginTop: 20 }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ fontSize: 14 }}>➕</span> 添加渠道
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8,
        }}>
          {CHANNEL_TYPES.map(t => (
            <button
              key={t.id}
              onClick={() => handleAdd(t.id)}
              style={{
                padding: '10px 14px', borderRadius: 8, border: '1px dashed var(--border-light)',
                background: 'var(--surface-0)', cursor: 'pointer',
                fontSize: 12, color: 'var(--text-primary)',
                display: 'flex', alignItems: 'center', gap: 8,
                transition: 'all 0.15s',
              }}
              onMouseOver={e => { (e.target as HTMLElement).style.borderColor = '#6366f180'; (e.target as HTMLElement).style.background = '#6366f108' }}
              onMouseOut={e => { (e.target as HTMLElement).style.borderColor = 'var(--border-light)'; (e.target as HTMLElement).style.background = 'var(--surface-0)' }}
            >
              <span style={{ fontSize: 16 }}>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{
        marginTop: 16, padding: 14, borderRadius: 10,
        background: 'var(--surface-100)', border: '1px solid var(--border-light)', fontSize: 11,
        lineHeight: 1.6,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>💡 配置流程</div>
        <ol style={{ margin: 0, paddingLeft: 16, color: 'var(--text-secondary)' }}>
          <li>在对应平台（钉钉/企微/QQ 开放平台等）创建应用/机器人</li>
          <li>获取凭证后，点击上方「添加渠道」选择平台</li>
          <li>填写凭证信息，保存后点击「测试」确认连接</li>
          <li>测试通过后，渠道消息会自动转发给 Lumina 处理</li>
        </ol>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// Agent 常驻池设置面板 (v16.0-fix)
// ═══════════════════════════════════════════════════════════

function AgentPoolSettings() {
  const [status, setStatus] = React.useState<Array<any>>([])
  const [config, setConfig] = React.useState<Record<string, any>>({})
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => { loadData() }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [s, c] = await Promise.all([
        window.luminaAPI.agentPoolGetStatus(),
        window.luminaAPI.agentPoolGetConfig(),
      ])
      setStatus(Array.isArray(s) ? s : [])
      setConfig(c || {})
    } catch (err) {
      console.error('[AgentPoolSettings] 加载失败:', err)
    }
    setLoading(false)
  }

  const handleToggleKeepalive = async () => {
    const newVal = !config.keepaliveEnabled
    const r = await window.luminaAPI.agentPoolUpdateConfig({ keepaliveEnabled: newVal })
    if (r.ok) loadData()
  }

  const handleIdleTimeoutChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = parseInt(e.target.value, 10)
    const r = await window.luminaAPI.agentPoolUpdateConfig({ idleTimeoutMs: val * 60 * 1000 })
    if (r.ok) loadData()
  }

  const handleCompress = async (id: string) => {
    await window.luminaAPI.agentPoolCompress(id)
    loadData()
  }

  if (loading) {
    return <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 12 }}>加载中...</div>
  }

  return (
    <div style={{ padding: '0 0 20px 0' }}>

      {/* 配置 */}
      <div style={cardStyle}>
        <div style={sectionTitle}>🏊 常驻池配置</div>
        <div style={sectionDesc}>
          让 Agent 在后台保持运行，避免每次对话冷启动。空闲时自动压缩上下文节约资源。
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* 心跳保活开关 */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <div onClick={handleToggleKeepalive} style={{
              width: 40, height: 22, borderRadius: 11, position: 'relative', cursor: 'pointer',
              background: config.keepaliveEnabled ? '#10b981' : '#d1d5db', transition: 'all 0.2s',
            }}>
              <div style={{
                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                position: 'absolute', top: 2, left: config.keepaliveEnabled ? 20 : 2,
                transition: 'all 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
                心跳保活
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                定期 ping 保持 Agent 进程活跃，防 GC 回收
              </div>
            </div>
          </label>

          {/* 空闲超时 */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>
              空闲压缩超时
            </div>
            <select
              value={(config.idleTimeoutMs || 900000) / 60000}
              onChange={handleIdleTimeoutChange}
              style={{
                padding: '6px 10px', borderRadius: 5, fontSize: 11,
                border: '1.5px solid var(--border-light)',
                background: 'var(--surface-0)', color: 'var(--text-primary)',
              }}
            >
              <option value={1}>1 分钟</option>
              <option value={5}>5 分钟</option>
              <option value={15}>15 分钟</option>
              <option value={30}>30 分钟</option>
              <option value={60}>1 小时</option>
            </select>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
              超过此时间未使用的 Agent 自动压缩上下文
            </div>
          </div>

          {/* 常驻 Agent 列表 */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>
              常驻 Agent
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {['lumina', 'yak', 'recha'].map(id => (
                <span key={id} style={{
                  padding: '3px 10px', borderRadius: 4, fontSize: 11,
                  background: (config.persistentAgents || []).includes(id) ? '#3b82f620' : 'var(--surface-100)',
                  color: (config.persistentAgents || []).includes(id) ? '#3b82f6' : 'var(--text-secondary)',
                  border: '1px solid var(--border-light)',
                }}>
                  {id === 'lumina' ? '🧑 Lumina' : id === 'yak' ? '🐍 Yak' : '🍵 热茶'}
                  {(config.persistentAgents || []).includes(id) ? ' ✅' : ' ⛔'}
                </span>
              ))}
            </div>
          </div>

        </div>
      </div>

      {/* 状态列表 */}
      <div style={cardStyle}>
        <div style={sectionTitle}>Agent 状态</div>

        {status.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>暂无常驻 Agent</div>
        )}

        {status.map((agent: any) => (
          <div key={agent.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px', marginBottom: 6, borderRadius: 6,
            background: 'var(--surface-100)', border: '1px solid var(--border-light)',
          }}>
            <span style={{ fontSize: 13 }}>
              {agent.personaId === 'lumina' ? '🧑' : agent.personaId === 'yak' ? '🐍' : '🍵'}
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                {agent.personaId || agent.id}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', display: 'flex', gap: 10, marginTop: 2 }}>
                <span>🔄 {agent.turnCount} 轮</span>
                <span>📊 {agent.totalTokens} tokens</span>
                <span>⏱️ {(agent.idleMs / 1000 / 60).toFixed(0)}min 空闲</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 8,
                background: agent.isIdle ? '#f59e0b20' : '#10b98120',
                color: agent.isIdle ? '#f59e0b' : '#10b981',
              }}>
                {agent.isIdle ? '空闲' : '活跃'}
              </span>
              {agent.idleCompressed && (
                <span style={{ fontSize: 9, color: '#8b5cf6' }}>🗜️ 已压缩</span>
              )}
            </div>
            <button
              onClick={() => handleCompress(agent.id)}
              style={{
                padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border-light)',
                background: 'var(--surface-0)', cursor: 'pointer', fontSize: 10,
                color: 'var(--text-secondary)',
              }}
            >
              压缩
            </button>
          </div>
        ))}
      </div>

      <div style={{
        padding: 12, borderRadius: 8,
        background: 'var(--surface-100)', border: '1px solid var(--border-light)', fontSize: 11,
      }}>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          💡 常驻 Agent 在 Lumina 启动时创建，空闲超时后自动压缩上下文以节约 token。
          压缩后的 Agent 仍保持在线，下次对话前需要解压（重新加载上下文）。
          关闭「心跳保活」可能使 Agent 被系统回收，导致下次对话冷启动。
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 🧭 意图路由设置 (v16.0-fix P3)
// ═══════════════════════════════════════════════════════════

function IntentRouterSettings() {
  const [config, setConfig] = React.useState<any>(null)
  const [rules, setRules] = React.useState<any[]>([])
  const [loading, setLoading] = React.useState(true)
  const [testMsg, setTestMsg] = React.useState('')
  const [testResult, setTestResult] = React.useState<any>(null)

  React.useEffect(() => { loadData() }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [c, r] = await Promise.all([
        window.luminaAPI.routerGetConfig(),
        window.luminaAPI.routerGetRules(),
      ])
      setConfig(c || {})
      setRules(Array.isArray(r) ? r : [])
    } catch (err) {
      console.error('[IntentRouter] 加载失败:', err)
    }
    setLoading(false)
  }

  const handleToggleAutoRoute = async () => {
    if (!config) return
    const newVal = !config.autoRoute
    await window.luminaAPI.routerUpdateConfig({ autoRoute: newVal })
    loadData()
  }

  const handleConfidenceChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = parseFloat(e.target.value)
    await window.luminaAPI.routerUpdateConfig({ minConfidence: val })
    loadData()
  }

  const handleTest = async () => {
    if (!testMsg.trim()) return
    const result = await window.luminaAPI.routerClassify(testMsg.trim())
    setTestResult(result)
  }

  if (loading) {
    return <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 12 }}>加载中...</div>
  }

  return (
    <div style={{ padding: '0 0 20px 0' }}>

      {/* 配置 */}
      <div style={cardStyle}>
        <div style={sectionTitle}>🧭 意图路由配置</div>
        <div style={sectionDesc}>
          在消息进入 Agent 前预分类意图，自动路由到合适的工作 Agent（Yak=代码 / 热茶=审查）。
          关闭后所有消息走 Lumina 处理。
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* 自动路由开关 */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <div onClick={handleToggleAutoRoute} style={{
              width: 40, height: 22, borderRadius: 11, position: 'relative', cursor: 'pointer',
              background: config?.autoRoute ? '#10b981' : '#d1d5db', transition: 'all 0.2s',
            }}>
              <div style={{
                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                position: 'absolute', top: 2, left: config?.autoRoute ? 20 : 2,
                transition: 'all 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
                自动路由 {config?.autoRoute ? '已开启' : '已关闭'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                {config?.autoRoute ? '识别到代码/审查请求时跳过 Lumina 直达目标 Agent' : '所有消息由 Lumina 统一处理'}
              </div>
            </div>
          </label>

          {/* 最低置信度 */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>
              最低置信度（{config?.minConfidence || 0.6}）
            </div>
            <select
              value={config?.minConfidence || 0.6}
              onChange={handleConfidenceChange}
              style={{
                padding: '6px 10px', borderRadius: 5, fontSize: 11,
                border: '1.5px solid var(--border-light)',
                background: 'var(--surface-0)', color: 'var(--text-primary)',
              }}
            >
              <option value={0.3}>0.3 — 宽松（更多路由，可能误判）</option>
              <option value={0.5}>0.5 — 平衡</option>
              <option value={0.6}>0.6 — 推荐</option>
              <option value={0.8}>0.8 — 严格（仅确定时路由）</option>
            </select>
          </div>

        </div>
      </div>

      {/* 路由规则 */}
      <div style={cardStyle}>
        <div style={sectionTitle}>📋 路由规则</div>
        <div style={sectionDesc}>
          匹配规则基于关键词，每条规则命中后根据匹配度决定是否路由。
        </div>

        {rules.map((rule: any, i: number) => (
          <div key={i} style={{
            padding: '10px 12px', marginBottom: 6, borderRadius: 6,
            background: 'var(--surface-100)', border: '1px solid var(--border-light)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{
                padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                background: rule.target === 'yak' ? '#3b82f620' : '#f59e0b20',
                color: rule.target === 'yak' ? '#3b82f6' : '#f59e0b',
              }}>
                {rule.target === 'yak' ? '🐍 Yak' : '🍵 热茶'}
              </span>
              <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }}>
                {rule.description}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                阈值 {rule.minScore}
              </span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.6, wordBreak: 'break-all' }}>
              触发词: {rule.triggers?.slice(0, 10).join(', ')}{rule.triggers?.length > 10 ? ` … +${rule.triggers.length - 10}` : ''}
            </div>
          </div>
        ))}
      </div>

      {/* 测试区 */}
      <div style={cardStyle}>
        <div style={sectionTitle}>🧪 测试路由</div>
        <div style={sectionDesc}>输入一段消息，看看意图路由器会如何分类。</div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            value={testMsg}
            onChange={e => setTestMsg(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleTest()}
            placeholder='例如: "写一个 Python 脚本排序文件"'
            style={{ ...inputStyle, flex: 1 }}
          />
          <button onClick={handleTest} style={chBtnPrimary}>测试</button>
        </div>

        {testResult && (
          <div style={{
            padding: 10, borderRadius: 6,
            background: 'var(--surface-100)', border: '1px solid var(--border-light)',
            fontSize: 11, lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>路由结果：</div>
            <div>🎯 目标: <strong>{testResult.target === 'lumina' ? '🧑 Lumina' : testResult.target === 'yak' ? '🐍 Yak' : '🍵 热茶'}</strong></div>
            <div>📊 置信度: {(testResult.confidence * 100).toFixed(0)}%</div>
            <div>💡 原因: {testResult.reason}</div>
            <div>🚗 自动路由: {testResult.autoRouted ? '✅ 是' : '❌ 否（仅建议）'}</div>
            {testResult.taskType && <div>🏷️ 类型: {testResult.taskType}</div>}
            {testResult.extractedContext && <div>📎 上下文: {testResult.extractedContext}</div>}
          </div>
        )}
      </div>

      <div style={{
        padding: 12, borderRadius: 8,
        background: 'var(--surface-100)', border: '1px solid var(--border-light)', fontSize: 11,
      }}>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          💡 意图路由的「自动路由」模式启用后，当置信度 ≥ 阈值时，消息会跳过 Lumina 直接发送给目标 Agent。
          关闭自动路由时，路由仅作为建议标签附加在消息上，最终由 Lumina 决定。
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 🔒 权限控制设置 (v16.0-fix P4)
// ═══════════════════════════════════════════════════════════

function AccessControlSettings() {
  const [permissions, setPermissions] = React.useState<any[]>([])
  const [violations, setViolations] = React.useState<any[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editingAgent, setEditingAgent] = React.useState<string | null>(null)
  const [editForm, setEditForm] = React.useState<any>(null)

  React.useEffect(() => { loadData() }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [p, v] = await Promise.all([
        window.luminaAPI.accessGetPermissions(),
        window.luminaAPI.accessGetViolations(),
      ])
      setPermissions(Array.isArray(p) ? p : [])
      setViolations(Array.isArray(v) ? v : [])
    } catch (err) {
      console.error('[AccessControl] 加载失败:', err)
    }
    setLoading(false)
  }

  const startEdit = (agentId: string) => {
    const perm = permissions.find(p => p.agentId === agentId)
    if (perm) {
      setEditingAgent(agentId)
      setEditForm(JSON.parse(JSON.stringify(perm)))
    }
  }

  const saveEdit = async () => {
    if (!editingAgent || !editForm) return
    await window.luminaAPI.accessUpdatePermissions(editingAgent, {
      allowedReadPaths: editForm.allowedReadPaths,
      allowedWritePaths: editForm.allowedWritePaths,
      allowedDangerousTools: editForm.allowedDangerousTools,
      networkAccess: editForm.networkAccess,
      allowedDomains: editForm.allowedDomains,
      shellAccess: editForm.shellAccess,
      allowedCommands: editForm.allowedCommands,
    })
    setEditingAgent(null)
    setEditForm(null)
    loadData()
  }

  const cancelEdit = () => {
    setEditingAgent(null)
    setEditForm(null)
  }

  const resetPerm = async (agentId: string) => {
    if (!confirm(`重置 ${agentId} 的权限为默认值？`)) return
    await window.luminaAPI.accessResetPermissions(agentId)
    loadData()
  }

  const handleClearViolations = async () => {
    await window.luminaAPI.accessClearViolations()
    loadData()
  }

  // 辅助：数组输入转数组
  const toArray = (val: string): string[] => val.split(',').map(s => s.trim()).filter(Boolean)

  if (loading) {
    return <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 12 }}>加载中...</div>
  }

  return (
    <div style={{ padding: '0 0 20px 0' }}>

      {/* 权限列表 */}
      {permissions.map(perm => (
        <div key={perm.agentId} style={{ ...cardStyle }}>

          {/* 头 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: editingAgent === perm.agentId ? 12 : 4 }}>
            <span style={{
              padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
              background: perm.agentId === 'lumina' ? '#8b5cf620' : perm.agentId === 'yak' ? '#3b82f620' : '#f59e0b20',
              color: perm.agentId === 'lumina' ? '#8b5cf6' : perm.agentId === 'yak' ? '#3b82f6' : '#f59e0b',
            }}>
              {perm.agentId === 'lumina' ? '🧑 Lumina' : perm.agentId === 'yak' ? '🐍 Yak' : '🍵 热茶'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {perm.description}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              {editingAgent !== perm.agentId && (
                <>
                  <button onClick={() => startEdit(perm.agentId)} style={chBtnSmall}>✏️ 编辑</button>
                  <button onClick={() => resetPerm(perm.agentId)} style={chBtnSmall}>🔄 重置</button>
                </>
              )}
              {editingAgent === perm.agentId && (
                <>
                  <button onClick={saveEdit} style={{ ...chBtnSmall, background: '#10b981', color: '#fff', border: 'none' }}>💾 保存</button>
                  <button onClick={cancelEdit} style={chBtnSmall}>取消</button>
                </>
              )}
            </div>
          </div>

          {editingAgent === perm.agentId ? (
            /* 编辑模式 */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div style={labelStyle}>允许读取路径（逗号分隔, * 为全部）</div>
                <input type="text" value={editForm?.allowedReadPaths?.join(', ') || ''}
                  onChange={e => setEditForm({ ...editForm, allowedReadPaths: toArray(e.target.value) })}
                  style={inputStyle} placeholder="K:\Projects, D:\Data" />
              </div>
              <div>
                <div style={labelStyle}>允许写入路径（逗号分隔, 空=禁止写）</div>
                <input type="text" value={editForm?.allowedWritePaths?.join(', ') || ''}
                  onChange={e => setEditForm({ ...editForm, allowedWritePaths: toArray(e.target.value) })}
                  style={inputStyle} placeholder="K:\Lumina 2\LuminaLife2.0" />
              </div>
              <div>
                <div style={labelStyle}>允许危险工具（逗号分隔, * 为全部）</div>
                <input type="text" value={editForm?.allowedDangerousTools?.join(', ') || ''}
                  onChange={e => setEditForm({ ...editForm, allowedDangerousTools: toArray(e.target.value) })}
                  style={inputStyle} placeholder="file_write, file_edit, shell_exec" />
              </div>
              <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11 }}>
                  <input type="checkbox" checked={editForm?.networkAccess ?? true}
                    onChange={e => setEditForm({ ...editForm, networkAccess: e.target.checked })} />
                  允许网络访问
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11 }}>
                  <input type="checkbox" checked={editForm?.shellAccess ?? true}
                    onChange={e => setEditForm({ ...editForm, shellAccess: e.target.checked })} />
                  允许执行命令
                </label>
              </div>
            </div>
          ) : (
            /* 查看模式 */
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px', fontSize: 11, color: 'var(--text-secondary)' }}>
              <div>📖 读取路径: <strong>{perm.allowedReadPaths?.length === 1 && perm.allowedReadPaths[0] === '*' ? '全部' : perm.allowedReadPaths?.length > 0 ? (perm.allowedReadPaths?.slice(0, 3).join(', ') + (perm.allowedReadPaths?.length > 3 ? ' …' : '')) : '无'}</strong></div>
              <div>✏️ 写入路径: <strong>{perm.allowedWritePaths?.length === 1 && perm.allowedWritePaths[0] === '*' ? '全部' : perm.allowedWritePaths?.length > 0 ? (perm.allowedWritePaths?.slice(0, 2).join(', ') + (perm.allowedWritePaths?.length > 2 ? ' …' : '')) : '❌ 禁止写'}</strong></div>
              <div>🔧 危险工具: <strong>{perm.allowedDangerousTools?.length === 1 && perm.allowedDangerousTools[0] === '*' ? '全部' : perm.allowedDangerousTools?.slice(0, 3).join(', ') || '无'}</strong></div>
              <div>🌐 网络: <strong>{perm.networkAccess ? '✅ 允许' : '❌ 禁止'}</strong></div>
              <div>💻 Shell: <strong>{perm.shellAccess ? '✅ 允许' : '❌ 禁止'}</strong></div>
            </div>
          )}
        </div>
      ))}

      {/* 违规记录 */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={sectionTitle}>🚫 违规记录</span>
          {violations.length > 0 && (
            <button onClick={handleClearViolations} style={chBtnSmall}>🗑️ 清除</button>
          )}
        </div>

        {violations.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>暂无违规记录</div>
        )}

        {violations.slice(0, 20).map((v: any, i: number) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '6px 10px', marginBottom: 4, borderRadius: 4,
            background: v.denied ? '#fef2f2' : 'var(--surface-100)',
            border: '1px solid var(--border-light)', fontSize: 11,
          }}>
            <span style={{
              padding: '1px 5px', borderRadius: 3, fontSize: 10, fontWeight: 600,
              background: v.denied ? '#ef444420' : '#10b98120',
              color: v.denied ? '#ef4444' : '#10b981',
              flexShrink: 0, marginTop: 1,
            }}>
              {v.denied ? '❌ 拒绝' : '⚠️ 放行'}
            </span>
            <div style={{ flex: 1, lineHeight: 1.5 }}>
              <div><strong>{v.agentId}</strong> → {v.action}: <span style={{ wordBreak: 'break-all' }}>{v.target}</span></div>
              <div style={{ color: 'var(--text-secondary)' }}>{v.reason}</div>
            </div>
          </div>
        ))}
        {violations.length > 20 && (
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
            … 还有 {violations.length - 20} 条记录
          </div>
        )}
      </div>

      <div style={{
        padding: 12, borderRadius: 8,
        background: 'var(--surface-100)', border: '1px solid var(--border-light)', fontSize: 11,
      }}>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          💡 权限控制在现有 disabledTools 基础上增加文件系统隔离、网络访问控制、shell 命令白名单。
          当 Yak 尝试写文件而权限不足时，操作会被拒绝并记录到违规日志中。
          Lumina 拥有全部权限，Yak 可写文件和执行命令，热茶仅可读。
        </div>
      </div>
    </div>
  )
}

const chBtnPrimary: React.CSSProperties = {
  padding: '6px 16px', borderRadius: 5, border: 'none',
  background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: 11,
}

const chBtnSecondary: React.CSSProperties = {
  padding: '6px 16px', borderRadius: 5, border: '1px solid var(--border-light)',
  background: 'var(--surface-0)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 11,
}

const chBtnSmall: React.CSSProperties = {
  padding: '3px 10px', borderRadius: 4, border: '1px solid var(--border-light)',
  background: 'var(--surface-0)', cursor: 'pointer', fontSize: 10, color: 'var(--text-primary)',
}