import React, { useState, useEffect } from 'react'
import { useStore } from '../../stores/appStore'
import { SettingSection, SettingRow, SettingRowLast, SettingBtn, StatusBadge, Toggle } from '../../components/SettingsUI'
import { ttsEngine } from '../../services/ttsEngine'

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

const INDEXTTS_EMOTIONS = [
  { id: 'calm', label: '平静' },
  { id: 'happy', label: '开心' },
  { id: 'angry', label: '生气' },
  { id: 'sad', label: '难过' },
  { id: 'afraid', label: '害怕' },
  { id: 'surprised', label: '惊讶' },
  { id: 'melancholic', label: '忧郁' },
  { id: 'neutral', label: '中性' },
]

const INDEXTTS_LANGS = [
  { id: 'ZH', label: '中文' },
  { id: 'EN', label: 'English' },
  { id: 'JA', label: '日本語' },
  { id: 'ES', label: 'Español' },
  { id: 'AR', label: 'العربية' },
]

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 12,
  border: '1.5px solid var(--border-light)', outline: 'none',
  background: 'var(--surface-0)', color: 'var(--text-primary)',
  boxSizing: 'border-box', cursor: 'pointer',
}

/** 🔊 语音合成设置 */
export default function SettingsTTS() {
  const ttsConfig = useStore(s => s.ttsConfig)
  const setTTSConfig = useStore(s => s.setTTSConfig)

  const [ttsStatus, setTtsStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [ttsMsg, setTtsMsg] = useState('')
  const [edgeRunning, setEdgeRunning] = useState(false)
  const [indexttsStatus, setIndexttsStatus] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle')
  const [indexttsMsg, setIndexttsMsg] = useState('')

  const engine = ttsConfig.engine || 'edge-tts'
  const ttsEnabled = ttsConfig.enabled !== false

  // 检查 Edge TTS 状态
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const status = await window.luminaAPI?.edgeTtsStatus?.()
        if (!cancelled && status?.running) setEdgeRunning(true)
      } catch {}
    }
    const timer = setTimeout(check, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])

  // 同步配置到 ttsEngine 单例
  useEffect(() => {
    ttsEngine.configure({
      engine: ttsConfig.engine || 'edge-tts',
      voice: ttsConfig.voice,
      speed: ttsConfig.speed,
      volume: ttsConfig.volume,
      enabled: ttsConfig.enabled,
      indextts: ttsConfig.indextts ? {
        port: ttsConfig.indextts.port,
        refAudioPath: ttsConfig.indextts.refAudioPath,
        lang: ttsConfig.indextts.lang,
        emotion: ttsConfig.indextts.emotion,
        durationFactor: ttsConfig.indextts.durationFactor,
      } : undefined,
    })
  }, [ttsConfig])

  // 检查 IndexTTS 状态
  const checkIndexTTS = async () => {
    setIndexttsStatus('checking')
    setIndexttsMsg('')
    const health = await ttsEngine.indexTtsHealth()
    if (health.ok) {
      setIndexttsStatus('ok')
      setIndexttsMsg('✅ 服务就绪')
    } else {
      setIndexttsStatus('fail')
      setIndexttsMsg('❌ ' + health.detail)
    }
  }

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

  const testTTS = async () => {
    setTtsStatus('testing')
    setTtsMsg('')
    try {
      let text = '你好，欢迎使用 Lumina 语音合成系统。'
      if (engine === 'edge-tts' && ttsConfig.voice.includes('Xiaoxiao')) {
        text = '你好，我是晓晓，很高兴认识你！'
      }
      const result = await ttsEngine.speak({ text })
      if (result.error) {
        setTtsStatus('fail')
        setTtsMsg('❌ ' + result.error)
      } else {
        setTtsStatus('ok')
        setTtsMsg('🔊 试听中...')
      }
    } catch (e: any) {
      setTtsStatus('fail')
      setTtsMsg(e.message || '未知错误')
    }
  }

  const updateIndexTTS = (patch: Partial<typeof ttsConfig.indextts>) => {
    setTTSConfig({ indextts: { ...ttsConfig.indextts!, ...patch } })
  }

  const selectRefAudio = async () => {
    try {
      const result = await window.luminaAPI?.dialogOpen?.({
        filters: [{ name: '音频文件', extensions: ['wav', 'mp3', 'flac', 'm4a'] }],
        properties: ['openFile'],
      })
      if (result && !result.canceled && result.filePaths?.length) {
        updateIndexTTS({ refAudioPath: result.filePaths[0] })
      }
    } catch {}
  }

  return (
    <SettingSection title="🔊 TTS 语音" desc="语音合成引擎设置，支持 Edge-TTS 和 IndexTTS-2.5 切换。">
      {/* 声音总开关 */}
      <SettingRow label="语音开关" desc="关闭后所有 TTS 语音都不会播放（包括 Agent 回复和桌宠）">
        <Toggle checked={ttsEnabled} onChange={() => setTTSConfig({ enabled: !ttsEnabled })} />
      </SettingRow>

      {/* 引擎选择 */}
      <SettingRow label="TTS 引擎" desc="选择语音合成引擎">
        <select
          value={engine}
          onChange={e => setTTSConfig({ engine: e.target.value as any })}
          style={{ ...selectStyle, width: 200 }}
        >
          <option value="edge-tts">Edge TTS（在线，多音色）</option>
          <option value="indextts">IndexTTS-2.5（本地，声音克隆）</option>
        </select>
      </SettingRow>

      {/* ══════ Edge TTS 设置 ══════ */}
      {engine === 'edge-tts' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '10px 12px', background: 'var(--surface-100, #f3f4f6)', borderRadius: 8 }}>
            <StatusBadge status={edgeRunning ? 'running' : 'stopped'} label={edgeRunning ? '运行中' : '未启动'} />
            <SettingBtn variant={edgeRunning ? 'danger' : 'success'} onClick={edgeRunning ? stopEdge : startEdge}>
              {edgeRunning ? '⏹ 停止' : '▶ 启动'}
            </SettingBtn>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Edge TTS 由 Lumina Python Node 提供</span>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>音色</label>
            <select value={ttsConfig.voice} onChange={e => setTTSConfig({ voice: e.target.value })} style={selectStyle}>
              {EDGE_VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 2 }}>语速 {ttsConfig.speed}x</label>
              <input type="range" min="0.5" max="2" step="0.1" value={ttsConfig.speed}
                onChange={e => setTTSConfig({ speed: parseFloat(e.target.value) })}
                style={{ width: '100%', accentColor: '#8b5cf6' }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 2 }}>音量 {Math.round(ttsConfig.volume * 100)}%</label>
              <input type="range" min="0" max="1" step="0.05" value={ttsConfig.volume}
                onChange={e => setTTSConfig({ volume: parseFloat(e.target.value) })}
                style={{ width: '100%', accentColor: '#8b5cf6' }} />
            </div>
          </div>
        </>
      )}

      {/* ══════ IndexTTS-2.5 设置 ══════ */}
      {engine === 'indextts' && (
        <>
          <div style={{ marginBottom: 14, padding: '10px 12px', background: 'var(--surface-100, #f3f4f6)', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <StatusBadge status={indexttsStatus === 'ok' ? 'running' : indexttsStatus === 'fail' ? 'stopped' : 'warning'}
                label={indexttsStatus === 'ok' ? '就绪' : indexttsStatus === 'checking' ? '检查中…' : '未连接'} />
              <SettingBtn variant="primary" onClick={checkIndexTTS} disabled={indexttsStatus === 'checking'}>
                🔄 检查连接
              </SettingBtn>
            </div>
            {indexttsMsg && (
              <div style={{ fontSize: 11, color: indexttsStatus === 'ok' ? '#16a34a' : '#ef4444', marginBottom: 6 }}>{indexttsMsg}</div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              IndexTTS-2.5 是本地 GPU 语音克隆模型，需要 Python 3.10-3.11 + NVIDIA GPU（约 6GB 显存）。<br/>
              启动服务：运行 <code style={{ background: 'rgba(139,92,246,0.1)', padding: '1px 4px', borderRadius: 3 }}>python\start_indextts.bat</code><br/>
              模型目录默认 <code style={{ background: 'rgba(139,92,246,0.1)', padding: '1px 4px', borderRadius: 3 }}>K:\IndexTTS-2.5</code>
            </div>
          </div>

          {/* 端口 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>服务端口</label>
            <input type="number" value={ttsConfig.indextts?.port || 18927}
              onChange={e => updateIndexTTS({ port: parseInt(e.target.value) || 18927 })}
              style={{ ...selectStyle, width: 120 }} />
          </div>

          {/* 参考音频 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>参考音频（声音克隆）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" value={ttsConfig.indextts?.refAudioPath || ''}
                onChange={e => updateIndexTTS({ refAudioPath: e.target.value })}
                placeholder="选择一段 wav/mp3 作为参考声音"
                style={{ ...selectStyle, flex: 1 }} />
              <SettingBtn variant="primary" onClick={selectRefAudio}>浏览</SettingBtn>
            </div>
          </div>

          {/* 语言 */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>语言</label>
              <select value={ttsConfig.indextts?.lang || 'ZH'}
                onChange={e => updateIndexTTS({ lang: e.target.value as any })}
                style={selectStyle}>
                {INDEXTTS_LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>情绪</label>
              <select value={ttsConfig.indextts?.emotion || 'calm'}
                onChange={e => updateIndexTTS({ emotion: e.target.value })}
                style={selectStyle}>
                {INDEXTTS_EMOTIONS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            </div>
          </div>

          {/* 语速 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 2 }}>
              语速系数 {ttsConfig.indextts?.durationFactor?.toFixed(1) || '1.0'}（大于1变慢，小于1变快）
            </label>
            <input type="range" min="0.5" max="2" step="0.1"
              value={ttsConfig.indextts?.durationFactor || 1.0}
              onChange={e => updateIndexTTS({ durationFactor: parseFloat(e.target.value) })}
              style={{ width: '100%', accentColor: '#8b5cf6' }} />
          </div>
        </>
      )}

      {/* 通用音量 + 试听 */}
      <SettingRowLast label="试听" desc="播放一段测试语音验证效果">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {ttsMsg && (
            <span style={{ fontSize: 12, color: ttsStatus === 'ok' ? '#16a34a' : '#ef4444' }}>{ttsMsg}</span>
          )}
          <SettingBtn variant="primary" onClick={testTTS} disabled={ttsStatus === 'testing' || !ttsEnabled} loading={ttsStatus === 'testing'}>
            🔊 试听
          </SettingBtn>
        </div>
      </SettingRowLast>
    </SettingSection>
  )
}
