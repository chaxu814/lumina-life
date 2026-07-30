import React, { useState, useEffect } from 'react'
import { useStore } from '../../stores/appStore'
import { SettingSection, SettingRow, SettingRowLast, SettingBtn, StatusBadge } from '../../components/SettingsUI'

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

/** 🔊 语音合成设置 */
export default function SettingsTTS() {
  const ttsConfig = useStore(s => s.ttsConfig)
  const setTTSConfig = useStore(s => s.setTTSConfig)
  const ttsEngine = useStore(s => s.ttsEngine)

  const [ttsStatus, setTtsStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [ttsMsg, setTtsMsg] = useState('')
  const [edgeRunning, setEdgeRunning] = useState(false)

  // 检查 Edge TTS 状态
  useEffect(() => {
    if (ttsEngine !== 'edge') return
    let cancelled = false
    const check = async () => {
      try {
        const status = await window.luminaAPI?.edgeTtsStatus?.()
        if (!cancelled && status?.running) setEdgeRunning(true)
      } catch {}
    }
    const timer = setTimeout(check, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [ttsEngine])

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
      const text = ttsConfig.voice.includes('Xiaoxiao') ? '你好，我是晓晓，很高兴认识你！' : '你好，欢迎使用 Lumina 语音合成系统。'
      const res = await window.luminaAPI?.edgeTtsSpeak?.({ voice: ttsConfig.voice, text, speed: ttsConfig.speed })
      if (res?.audio) { setTtsStatus('ok'); setTtsMsg('试听中...') }
      else if (res?.error) { setTtsStatus('fail'); setTtsMsg(`❌ ${res.error}`) }
      else { setTtsStatus('fail'); setTtsMsg('❌ 播放失败：无返回数据') }
    } catch (e: any) { setTtsStatus('fail'); setTtsMsg(e.message || '未知错误') }
  }

  return (
    <SettingSection title="🔊 Edge TTS（语音合成）" desc="浏览器 Edge TTS 引擎，支持多音色中英文语音合成。">
      {/* 状态 + 控制 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <StatusBadge status={edgeRunning ? 'running' : 'stopped'} label={edgeRunning ? '运行中' : '未启动'} />
        <SettingBtn variant={edgeRunning ? 'danger' : 'success'} onClick={edgeRunning ? stopEdge : startEdge}>
          {edgeRunning ? '⏹ 停止' : '▶ 启动'}
        </SettingBtn>
      </div>

      {/* 音色选择 */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>
          音色
        </label>
        <select
          value={ttsConfig.voice}
          onChange={e => setTTSConfig({ voice: e.target.value })}
          style={{
            width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 12,
            border: '1.5px solid var(--border-light)', outline: 'none',
            background: 'var(--surface-0)', color: 'var(--text-primary)',
            boxSizing: 'border-box', cursor: 'pointer',
          }}
        >
          {EDGE_VOICES.map(v => (
            <option key={v.id} value={v.id}>{v.label}</option>
          ))}
        </select>
      </div>

      {/* 语速 / 音量 */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 2 }}>
            语速 {ttsConfig.speed}x
          </label>
          <input type="range" min="0.5" max="2" step="0.1" value={ttsConfig.speed}
            onChange={e => setTTSConfig({ speed: parseFloat(e.target.value) })}
            style={{ width: '100%', accentColor: '#8b5cf6' }} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 2 }}>
            音量 {Math.round(ttsConfig.volume * 100)}%
          </label>
          <input type="range" min="0" max="1" step="0.05" value={ttsConfig.volume}
            onChange={e => setTTSConfig({ volume: parseFloat(e.target.value) })}
            style={{ width: '100%', accentColor: '#8b5cf6' }} />
        </div>
      </div>

      {/* 试听 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SettingBtn variant="primary" onClick={testTTS} disabled={ttsStatus === 'testing' || !edgeRunning} loading={ttsStatus === 'testing'}>
          🔊 试听
        </SettingBtn>
        {ttsMsg && (
          <span style={{ fontSize: 12, color: ttsStatus === 'ok' ? '#16a34a' : '#ef4444' }}>
            {ttsMsg}
          </span>
        )}
      </div>
    </SettingSection>
  )
}
