// ============================================================
// ChatInputBar.tsx — 统一输入框组件 (v1.0)
// 包含：输入框 + 底部工具栏（Lucky Agent、思考、表情、文件、实时语音、AI操作电脑、胶囊）
// ============================================================

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../stores/appStore'
import { EMOJI_GROUPS, AGENT_VOICES } from '../chat/chatShared'
import { showToast } from './Toast'
import LuckyModeSelector from './LuckyModeSelector'
import LuckyModeSettings from './LuckyModeSettings'
import { useLuckyMode } from '../hooks/useLuckyMode'
import type { LuckySettingsConfig } from './LuckyModeSettings'
import { sttService, type STTStatus } from '../services/sttService'
import { handlePasteInsert } from '../lib/pasteInsert'

interface ChatInputBarProps {
  input: string
  setInput: (value: string) => void
  onSend: () => void
  onAbort?: () => void
  isProcessing?: boolean
  placeholder?: string
  showMentionHint?: boolean
  onKeyDown?: (e: React.KeyboardEvent) => void
  fileInputRef?: React.RefObject<HTMLInputElement>
  onFileSelect?: (files: FileList) => void
  attachments?: Array<{ name: string; size: number; text?: string }>
}

export default function ChatInputBar({
  input,
  setInput,
  onSend,
  onAbort,
  isProcessing = false,
  placeholder = '',
  showMentionHint = false,
  onKeyDown,
  fileInputRef: externalFileInputRef,
  onFileSelect,
  attachments = [],
}: ChatInputBarProps) {
  const { t } = useTranslation()
  const internalFileInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = externalFileInputRef || internalFileInputRef
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // State
  const [thinkingMode, setThinkingMode] = useState(true)
  const [showEmoji, setShowEmoji] = useState(false)
  const [realtimeVoiceActive, setRealtimeVoiceActive] = useState(false)
  const [computerUseActive, setComputerUseActive] = useState(false)
  const [sttListening, setSttListening] = useState(false)
  const [sttStatus, setSttStatus] = useState<STTStatus | null>(null)

  // Lucky Mode
  const luckyMode = useLuckyMode()

  // Auto resize textarea
  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
  }, [])

  // Voice input toggle
  const toggleMic = useCallback(async () => {
    if (sttListening) {
      sttService.stop()
      setSttListening(false)
      setSttStatus(null)
      return
    }
    try {
      setSttListening(true)
      setSttStatus({ listening: true, engine: 'web-speech', engineLabel: 'Web Speech', retryCount: 0 })
      sttService.setCallbacks(
        (text: string) => { const cur = typeof input === 'function' ? (input as any)() : input; setInput(cur + text) },
        (s: STTStatus) => { setSttStatus(s); if (!s.listening) {setSttListening(false)} },
      )
      await sttService.start()
    } catch (e) {
      console.warn('STT failed:', e)
      setSttListening(false)
      setSttStatus({ listening: false, engine: 'web-speech', engineLabel: 'Web Speech', error: String(e), retryCount: 0 })
      setTimeout(() => setSttStatus(null), 2000)
    }
  }, [sttListening, setInput])

  // Realtime voice toggle
  const toggleRealtimeVoice = useCallback(async () => {
    if (realtimeVoiceActive) {
      try {
        const r = await window.luminaAPI?.agentStopRealtimeVoice?.()
        if (r?.success) { setRealtimeVoiceActive(false); showToast(t('chat.voice_stopped'), 'info') }
        else { showToast(`⚠️ ${r?.error || t('chat.stop_failed')}`, 'warning') }
      } catch (e: any) { showToast(`⚠️ ${e.message}`, 'warning') }
    } else {
      try {
        const r = await window.luminaAPI?.agentStartRealtimeVoice?.()
        if (r?.success) { setRealtimeVoiceActive(true); showToast(r.message || t('chat.voice_started'), 'info') }
        else { showToast(`⚠️ ${r?.error || t('chat.start_failed')}`, 'warning') }
      } catch (e: any) { showToast(`⚠️ ${e.message}`, 'warning') }
    }
  }, [realtimeVoiceActive])

  // Computer use toggle
  const toggleComputerUse = useCallback(async () => {
    if (computerUseActive) {
      try { await window.luminaAPI?.agentStopComputerUse?.() } catch {}
      setComputerUseActive(false)
      showToast(t('chat.computer_stopped'), 'info')
    } else {
      try {
        const r = await window.luminaAPI?.agentStartComputerUse?.()
        if (r?.success) { setComputerUseActive(true); showToast(r.message || t('chat.computer_ready'), 'info') }
        else { showToast(`⚠️ ${r?.error || t('chat.start_failed')}`, 'warning') }
      } catch (e: any) { showToast(`⚠️ ${e.message}`, 'warning') }
    }
  }, [computerUseActive])

  // Time capsule
  const handleTimeCapsule = useCallback(() => {
    const text = input.trim()
    if (!text) { alert(t('chat.capsule_empty')); return }
    if (window.confirm(`⏳ 埋一颗时光胶囊给未来的自己？\n\n内容: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"\n\n默认 30 天后开启`)) {
      setInput(`帮我埋一颗时光胶囊，内容是：${text}，30天后开启`)
      setTimeout(() => { onSend(); setInput('') }, 80)
    }
  }, [input, setInput, onSend])

  // Default keydown handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (onKeyDown) {
      onKeyDown(e)
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }, [onKeyDown, onSend])

  return (
    <div style={{
      borderTop: '1px solid var(--border-light)',
      background: 'var(--surface-0)',
    }}>
      {/* 输入框区域 */}
      <div style={{ padding: '8px 12px 4px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => { setInput(e.target.value); autoResize() }}
            onPaste={e => handlePasteInsert(e, input, setInput)}
            onKeyDown={handleKeyDown}
            aria-label="消息输入框"
            placeholder={isProcessing ? t('chat.replying') : (placeholder || t('chat.placeholder'))}
            rows={1}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: 8,
              border: '1px solid var(--border-light)', fontSize: 13, lineHeight: 1.5,
              resize: 'none', outline: 'none', fontFamily: 'inherit',
              minHeight: 36, maxHeight: 120,
              background: isProcessing ? '#fffbeb' : 'var(--surface-0)',
            }}
          />

          {/* 🎤 语音输入 */}
          <button
            onClick={toggleMic}
            title={sttListening ? t('chat.mic_stop_title') : t('chat.mic_title')}
            aria-label={sttListening ? t('chat.mic_stop_title') : t('chat.mic_title')}
            aria-pressed={sttListening}
            style={{
              width: 36, height: 36, borderRadius: 8,
              border: `1.5px solid ${sttListening ? '#ef4444' : 'var(--border-light)'}`,
              background: sttListening ? '#fef2f2' : 'var(--surface-100)',
              cursor: 'pointer', fontSize: 17,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: sttListening ? '0 0 8px rgba(239,68,68,0.3)' : 'none',
            }}>
            {sttListening ? '🔴' : '🎤'}
          </button>

          {/* 发送/停止按钮 */}
          {isProcessing ? (
            <button
              onClick={onAbort}
              title={t('chat.stop_generating')}
              aria-label={t('chat.stop_generating')}
              style={{
                width: 36, height: 36, borderRadius: 8,
                border: '1.5px solid #ef4444',
                background: '#fef2f2',
                cursor: 'pointer', fontSize: 17,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              ⏹️
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!input.trim()}
              title={t('chat.send')}
              aria-label={t('chat.send')}
              style={{
                width: 36, height: 36, borderRadius: 8,
                border: 'none',
                background: input.trim() ? '#3b82f6' : 'var(--border-light)',
                cursor: input.trim() ? 'pointer' : 'default',
                color: input.trim() ? '#fff' : 'var(--text-secondary)',
                fontSize: 17,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              ➤
            </button>
          )}
        </div>

        {/* 模型信息 + @提示 */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginTop: 4, fontSize: 10, color: 'var(--text-secondary)',
        }}>
          <span>
            {showMentionHint && input.includes('@') ? t('chat.mention_hint') : ''}
          </span>
          <span style={{ opacity: 0.6 }}>
            {t('chat.kbd_hint')}
          </span>
        </div>
      </div>

      {/* 底部工具栏 */}
      <div style={{
        padding: '4px 12px 6px',
        display: 'flex', gap: 4, alignItems: 'center',
        flexWrap: 'wrap',
      }}>
        {/* ── 🍀 Lucky Agent ── */}
        <LuckyModeSelector
          currentPreset={luckyMode.preset}
          onPresetChange={(p) => luckyMode.setPreset(p)}
          runtimeInfo={{
            preset: luckyMode.preset,
            isActive: luckyMode.isActive,
            currentIteration: luckyMode.runtime.currentIteration,
            maxIteration: luckyMode.runtime.maxIteration,
            isPaused: luckyMode.isPaused,
            pauseReason: luckyMode.runtime.pauseReason,
          }}
          onOpenSettings={() => luckyMode.setShowSettings(true)}
        />
        {luckyMode.isPaused && (
          <button
            onClick={luckyMode.resume}
            style={{
              padding: '4px 10px', borderRadius: 6,
              border: '1.5px solid #fca5a5', background: '#fef2f2',
              cursor: 'pointer', fontSize: 12, display: 'flex',
              alignItems: 'center', gap: 3, fontFamily: 'inherit',
              color: '#dc2626',
            }}>
            {t('chat.continue')}
          </button>
        )}

        {/* ── 🧠 思考 ── */}
        <button
          onClick={() => setThinkingMode(v => !v)}
          title={thinkingMode ? t('chat.thinking_on') : t('chat.thinking_off')}
          aria-label={thinkingMode ? t('chat.thinking_on') : t('chat.thinking_off')}
          aria-pressed={thinkingMode}
          style={{
            padding: '4px 10px', borderRadius: 6,
            border: `1.5px solid ${thinkingMode ? '#f59e0b' : 'var(--border-light)'}`,
            background: thinkingMode ? 'var(--yellow-100)' : 'var(--surface-50)',
            cursor: 'pointer', fontSize: 12, display: 'flex',
            alignItems: 'center', gap: 3, fontFamily: 'inherit',
            opacity: thinkingMode ? 1 : 0.6,
            transition: 'all .2s',
          }}>
          {t('chat.thinking')}
        </button>

        {/* ── 😊 表情 ── */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setShowEmoji(!showEmoji)}
            title={t('chat.emoji_title')}
            aria-label={t('chat.emoji_title')}
            aria-expanded={showEmoji}
            style={{
              padding: '4px 10px', borderRadius: 6,
              border: `1.5px solid ${showEmoji ? '#93c5fd' : 'var(--border-light)'}`,
              background: showEmoji ? 'var(--accent-50)' : 'var(--surface-50)',
              cursor: 'pointer', fontSize: 12, display: 'flex',
              alignItems: 'center', gap: 3, fontFamily: 'inherit',
              transition: 'all .15s',
            }}>
            {t('chat.emoji')}
          </button>
          {showEmoji && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                onClick={() => setShowEmoji(false)} />
              <div style={{
                position: 'absolute', bottom: 40, left: 0, zIndex: 100,
                width: 312, background: 'var(--surface-0)', borderRadius: 12,
                border: '1px solid var(--border-light)',
                boxShadow: '0 4px 24px rgba(0,0,0,.12)',
                overflow: 'hidden',
              }}>
                {/* Emoji 网格 */}
                <div style={{ maxHeight: 260, overflowY: 'auto', padding: '4px 6px' }}>
                  {EMOJI_GROUPS.map((group, gi) => (
                    <div key={gi}>
                      <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '6px 4px 2px', fontWeight: 500 }}>
                        {group.label} {group.name}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                        {group.emojis.map((emoji, ei) => {
                          if (emoji === 'x') {return <div key={ei} style={{ width: 30, height: 30 }} />}
                          return (
                            <button key={ei}
                              onClick={() => {
                                setInput(input + emoji)
                                setShowEmoji(false)
                              }}
                              title={emoji}
                              style={{
                                width: 30, height: 30, borderRadius: 5,
                                border: 'none', background: 'transparent',
                                cursor: 'pointer', fontSize: 17, padding: 0,
                                lineHeight: '30px', textAlign: 'center',
                              }}
                              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--border-light)'}
                              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                            >
                              {emoji}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── 📎 文件 ── */}
        <button
          onClick={() => fileInputRef.current?.click()}
          title={t('chat.file_title')}
          aria-label={t('chat.file_title')}
          style={{
            padding: '4px 10px', borderRadius: 6,
            border: `1.5px solid ${attachments.length > 0 ? '#93c5fd' : 'var(--border-light)'}`,
            background: attachments.length > 0 ? 'var(--accent-50)' : 'var(--surface-50)',
            cursor: 'pointer', fontSize: 12, display: 'flex',
            alignItems: 'center', gap: 3, fontFamily: 'inherit',
          }}>
          {t('chat.file')}{attachments.length > 0 ? <sup style={{ fontSize: 9, color: '#3b82f6', marginLeft: 1 }}>{attachments.length}</sup> : null}
        </button>

        {/* ── 🎙️ 实时语音对话 ── */}
        <button onClick={toggleRealtimeVoice}
          title={realtimeVoiceActive ? t('chat.voice_on_title') : t('chat.voice_off_title')}
          aria-label={realtimeVoiceActive ? t('chat.voice_on_title') : t('chat.voice_off_title')}
          aria-pressed={realtimeVoiceActive}
          style={{
            padding: '4px 10px', borderRadius: 6,
            border: `1.5px solid ${realtimeVoiceActive ? '#22c55e' : 'var(--border-light)'}`,
            background: realtimeVoiceActive ? 'var(--green-100)' : 'var(--surface-50)',
            cursor: 'pointer', fontSize: 12, display: 'flex',
            alignItems: 'center', gap: 3, fontFamily: 'inherit',
            boxShadow: realtimeVoiceActive ? '0 0 6px rgba(34,197,94,0.35)' : 'none',
          }}>
          {realtimeVoiceActive ? t('chat.voice_on') : t('chat.voice_off')}
        </button>

        {/* ── 💻 AI操作电脑 ── */}
        <button onClick={toggleComputerUse}
          title={computerUseActive ? t('chat.computer_on_title') : t('chat.computer_off_title')}
          aria-label={computerUseActive ? t('chat.computer_on_title') : t('chat.computer_off_title')}
          aria-pressed={computerUseActive}
          style={{
            padding: '4px 10px', borderRadius: 6,
            border: `1.5px solid ${computerUseActive ? '#a855f7' : 'var(--border-light)'}`,
            background: computerUseActive ? 'var(--accent-50)' : 'var(--surface-50)',
            cursor: 'pointer', fontSize: 12, display: 'flex',
            alignItems: 'center', gap: 3, fontFamily: 'inherit',
            boxShadow: computerUseActive ? '0 0 6px rgba(168,85,247,0.35)' : 'none',
          }}>
          {t('chat.computer')}
        </button>

        {/* ── ⏳ 胶囊 ── */}
        <button onClick={handleTimeCapsule}
          title={t('chat.capsule_title')}
          aria-label={t('chat.capsule_title')}
          style={{
            padding: '4px 10px', borderRadius: 6,
            border: '1.5px solid var(--border-light)',
            background: 'var(--surface-50)',
            cursor: 'pointer', fontSize: 12, display: 'flex',
            alignItems: 'center', gap: 3, fontFamily: 'inherit',
          }}>
          {t('chat.capsule')}
        </button>

        {/* ── 弹性空间 ── */}
        <div style={{ flex: 1 }} />
      </div>

      {/* Lucky Mode Settings Modal */}
      {luckyMode.showSettings && (
        <LuckyModeSettings
          config={luckyMode.settings}
          onSave={(cfg) => { luckyMode.saveSettings(cfg); luckyMode.setShowSettings(false) }}
          onClose={() => luckyMode.setShowSettings(false)}
        />
      )}
    </div>
  )
}
