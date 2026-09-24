import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
  const ttsConfig = useStore(s => s.ttsConfig)
  const setTTSConfig = useStore(s => s.setTTSConfig)

  const [ttsStatus, setTtsStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [ttsMsg, setTtsMsg] = useState('')
  const [edgeRunning, setEdgeRunning] = useState(false)
  const [indexttsStatus, setIndexttsStatus] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle')
  const [indexttsMsg, setIndexttsMsg] = useState('')

  // 离线语音识别（whisper-base 多语种，支持中文）
  const [sttOffline, setSttOffline] = useState<any>(null)
  const [sttBusy, setSttBusy] = useState(false)
  const [sttPct, setSttPct] = useState(0)
  const [sttFile, setSttFile] = useState('')
  const [sttErr, setSttErr] = useState('')
  const refreshStt = async () => {
    try { const r = await window.luminaAPI?.sttOfflineStatus?.(); if (r?.ok) {setSttOffline(r)} } catch {}
  }
  useEffect(() => {
    refreshStt()
    let un: any = null
    try {
      un = window.luminaAPI?.onSttDownloadProgress?.((d: any) => {
        if (typeof d.progress === 'number') {setSttPct(Math.round(d.progress * 100))}
        if (d.file) {setSttFile(d.file)}
        if (d.status === 'done') { setSttBusy(false); setSttPct(100); refreshStt() }
        if (d.status === 'error') { setSttBusy(false); setSttErr(d.message || '下载失败') }
      })
    } catch {}
    return () => { try { un?.() } catch {} }
  }, [])
  const downloadStt = async () => {
    setSttBusy(true); setSttErr(''); setSttPct(0)
    try {
      const r = await window.luminaAPI?.sttDownloadModel?.()
      if (r?.ok) { setSttPct(100); setSttOffline({ ...sttOffline, ...r }) }
      else { setSttErr(r?.error || '下载失败') }
    } catch (e: any) { setSttErr(e?.message || '下载失败') }
    finally { setSttBusy(false) }
  }

  const engine = ttsConfig.engine || 'edge-tts'
  const ttsEnabled = ttsConfig.enabled !== false

  // 检查 Edge TTS 状态
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const status = await window.luminaAPI?.edgeTtsStatus?.()
        if (!cancelled && status?.running) {setEdgeRunning(true)}
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
      if (res?.ok) {setEdgeRunning(true)}
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
    <SettingSection title={t('tts.section_title')} desc={t('tts.section_desc')}>
      {/* 声音总开关 */}
      <SettingRow label={t('tts.toggle_label')} desc={t('tts.toggle_desc')}>
        <Toggle checked={ttsEnabled} onChange={() => setTTSConfig({ enabled: !ttsEnabled })} />
      </SettingRow>

      {/* 引擎选择 */}
      <SettingRow label={t('tts.engine_label')} desc={t('tts.engine_desc')}>
        <select
          value={engine}
          onChange={e => setTTSConfig({ engine: e.target.value as any })}
          style={{ ...selectStyle, width: 200 }}
        >
          <option value="edge-tts">{t('tts.engine_edge')}</option>
          <option value="indextts">{t('tts.engine_indextts')}</option>
        </select>
      </SettingRow>

      {/* ══════ Edge TTS 设置 ══════ */}
      {engine === 'edge-tts' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '10px 12px', background: 'var(--surface-100, #f3f4f6)', borderRadius: 8 }}>
            <StatusBadge status={edgeRunning ? 'running' : 'stopped'} label={edgeRunning ? t('tts.running') : t('tts.stopped')} />
            <SettingBtn variant={edgeRunning ? 'danger' : 'success'} onClick={edgeRunning ? stopEdge : startEdge}>
              {edgeRunning ? t('tts.stop') : t('tts.start')}
            </SettingBtn>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('tts.edge_backend')}</span>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>{t('tts.voice')}</label>
            <select value={ttsConfig.voice} onChange={e => setTTSConfig({ voice: e.target.value })} style={selectStyle}>
              {EDGE_VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 2 }}>{t('tts.speed')} {ttsConfig.speed}x</label>
              <input type="range" min="0.5" max="2" step="0.1" value={ttsConfig.speed}
                onChange={e => setTTSConfig({ speed: parseFloat(e.target.value) })}
                style={{ width: '100%', accentColor: '#8b5cf6' }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 2 }}>{t('tts.volume')} {Math.round(ttsConfig.volume * 100)}%</label>
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
                label={indexttsStatus === 'ok' ? t('tts.ready') : indexttsStatus === 'checking' ? t('tts.checking') : t('tts.disconnected')} />
              <SettingBtn variant="primary" onClick={checkIndexTTS} disabled={indexttsStatus === 'checking'}>
                {t('tts.check_conn')}
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
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>{t('tts.index_port')}</label>
            <input type="number" value={ttsConfig.indextts?.port || 18927}
              onChange={e => updateIndexTTS({ port: parseInt(e.target.value) || 18927 })}
              style={{ ...selectStyle, width: 120 }} />
          </div>

          {/* 参考音频 */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>{t('tts.index_ref_audio')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" value={ttsConfig.indextts?.refAudioPath || ''}
                onChange={e => updateIndexTTS({ refAudioPath: e.target.value })}
                placeholder={t('tts.index_ref_placeholder')}
                style={{ ...selectStyle, flex: 1 }} />
              <SettingBtn variant="primary" onClick={selectRefAudio}>{t('tts.browse')}</SettingBtn>
            </div>
          </div>

          {/* 语言 */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>{t('tts.lang')}</label>
              <select value={ttsConfig.indextts?.lang || 'ZH'}
                onChange={e => updateIndexTTS({ lang: e.target.value as any })}
                style={selectStyle}>
                {INDEXTTS_LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>{t('tts.emotion')}</label>
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
              {t('tts.speed_factor')} {ttsConfig.indextts?.durationFactor?.toFixed(1) || '1.0'} {t('tts.speed_factor_hint')}
            </label>
            <input type="range" min="0.5" max="2" step="0.1"
              value={ttsConfig.indextts?.durationFactor || 1.0}
              onChange={e => updateIndexTTS({ durationFactor: parseFloat(e.target.value) })}
              style={{ width: '100%', accentColor: '#8b5cf6' }} />
          </div>
        </>
      )}

      {/* ══════ 离线语音识别（STT）══════ */}
      <div style={{ marginTop: 18, marginBottom: 14, padding: '12px 14px', background: 'var(--surface-100, #f3f4f6)', borderRadius: 10, border: '1px solid var(--border-light)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{t('tts.stt_title')}</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
          {t('tts.stt_desc')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusBadge
            status={sttOffline?.modelReady ? 'running' : sttOffline?.depReady ? 'warning' : 'stopped'}
            label={sttOffline?.modelReady ? t('tts.stt_ready_badge') : sttOffline?.depReady ? t('tts.stt_no_model') : t('tts.stt_no_dep')}
          />
          {sttOffline?.modelReady && sttOffline?.sizeMB > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('tts.stt_used', { size: sttOffline.sizeMB })}</span>
          )}
          {!sttOffline?.modelReady && (
            <SettingBtn variant="success" onClick={downloadStt} disabled={sttBusy || !sttOffline?.depReady} loading={sttBusy}>
              {sttBusy ? (sttPct > 0 ? t('tts.stt_downloading', { pct: sttPct }) : t('tts.stt_preparing')) : t('tts.stt_download')}
            </SettingBtn>
          )}
        </div>
        {sttBusy && (
          <div style={{ marginTop: 8 }}>
            <div style={{ height: 6, background: 'var(--surface-0, #e5e7eb)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: sttPct + '%', height: '100%', background: '#8b5cf6', transition: 'width .2s' }} />
            </div>
            {sttFile && <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4, wordBreak: 'break-all' }}>{sttFile}</div>}
          </div>
        )}
        {sttErr && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{sttErr}</div>}
      </div>

      {/* 通用音量 + 试听 */}
      <SettingRowLast label={t('tts.preview_label')} desc={t('tts.preview_desc')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {ttsMsg && (
            <span style={{ fontSize: 12, color: ttsStatus === 'ok' ? '#16a34a' : '#ef4444' }}>{ttsMsg}</span>
          )}
          <SettingBtn variant="primary" onClick={testTTS} disabled={ttsStatus === 'testing' || !ttsEnabled} loading={ttsStatus === 'testing'}>
            {t('tts.preview_btn')}
          </SettingBtn>
        </div>
      </SettingRowLast>
    </SettingSection>
  )
}
