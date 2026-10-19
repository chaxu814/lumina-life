import React from 'react'
import { useStore } from '../../stores/appStore'
import { SettingSection } from '../../components/SettingsUI'

/** ♿ 无障碍设置（创新提案 7：无障碍语音交互） */
function ToggleRow({
  label, desc, checked, onChange,
}: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 }}>{desc}</div>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        style={{
          width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
          background: checked ? 'var(--accent-500)' : 'var(--border-light)',
          position: 'relative', transition: 'background 0.2s', flexShrink: 0,
        }}
      >
        <div style={{
          width: 18, height: 18, borderRadius: '50%', background: '#fff',
          position: 'absolute', top: 3, left: checked ? 23 : 3, transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }} />
      </button>
    </div>
  )
}

export default function SettingsA11y() {
  const a11y = useStore((s) => s.a11y)
  const setA11y = useStore((s) => s.setA11y)

  const scales: Array<{ value: 1 | 1.25 | 1.5; label: string }> = [
    { value: 1, label: '100%' },
    { value: 1.25, label: '125%' },
    { value: 1.5, label: '150%' },
  ]

  return (
    <>
      <SettingSection title="🎙 语音交互（PTT）" desc="按住快捷键说话，松开后自动识别、分发意图并用语音播报结果。播报中再按一次可打断并重新说。">
        <ToggleRow
          label="启用语音交互"
          desc="开启后注册全局 PTT 快捷键（录音→STT→意图→TTS 闭环）。"
          checked={a11y.voiceLoopEnabled}
          onChange={(v) => setA11y({ voiceLoopEnabled: v })}
        />
        <div style={{ marginTop: 14 }}>
          <label htmlFor="a11y-ptt" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
            PTT 快捷键
          </label>
          <input
            id="a11y-ptt"
            type="text"
            value={a11y.pttShortcut}
            onChange={(e) => setA11y({ pttShortcut: e.target.value })}
            placeholder="Ctrl+Space"
            aria-label="PTT 快捷键"
            style={{
              display: 'block', marginTop: 6, padding: '6px 10px', borderRadius: 6,
              border: '1px solid var(--border-light)', fontSize: 12, fontFamily: 'var(--font-mono)',
              width: 220, background: 'var(--surface-0)', color: 'var(--text-primary)',
            }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
            Electron 加速器格式，如 Ctrl+Space / Alt+A。与 Ctrl+Shift+L、Alt+Space 等已占用键冲突时不会注册。
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <ToggleRow
            label="唤醒词（预留）"
            desc="接入 Porcupine 后可免按快捷键、说一声“露娜”就开始对话。当前为关键词兜底，配置面板占位。"
            checked={a11y.wakeWordEnabled}
            onChange={(v) => setA11y({ wakeWordEnabled: v })}
          />
        </div>
      </SettingSection>

      <SettingSection title="🔍 高对比度" desc="文字与背景对比度 ≥ 7:1（WCAG AAA），焦点框 2px 实线，按钮边框加粗。">
        <ToggleRow
          label="高对比度模式"
          desc="适合低视力或强光环境。深色主题下自动切换为黑白高对比。"
          checked={a11y.highContrast}
          onChange={(v) => setA11y({ highContrast: v })}
        />
      </SettingSection>

      <SettingSection title="🔠 字号缩放" desc="主界面全部文字（聊天 / 面板 / 设置）与桌宠聊天窗同步缩放；图标与头像保持原始尺寸，布局自动重排。">
        <div style={{ display: 'flex', gap: 8 }} role="group" aria-label="字号缩放">
          {scales.map((s) => {
            const active = a11y.fontScale === s.value
            return (
              <button
                key={s.value}
                onClick={() => setA11y({ fontScale: s.value })}
                aria-pressed={active}
                style={{
                  padding: '8px 18px', borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${active ? 'var(--accent-500)' : 'var(--border-light)'}`,
                  background: active ? 'var(--accent-50)' : 'var(--surface-0)',
                  color: active ? 'var(--accent-600)' : 'var(--text-primary)',
                  fontSize: 13, fontWeight: active ? 600 : 400,
                }}
              >
                {s.label}
              </button>
            )
          })}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.6 }}>
          改完立即生效，无需重启。125% / 150% 下部分密集面板需要滚动查看——这是字号变大后的正常重排。
        </div>
      </SettingSection>

      <div style={{
        padding: 10, borderRadius: 8, fontSize: 11, lineHeight: 1.6,
        background: 'var(--accent-50)', color: 'var(--accent-700)',
        border: '1px solid var(--accent-100)',
      }}>
        💡 提示：Tab 键可在所有按钮与输入框间移动焦点；弹窗内按 Esc 关闭并把焦点还给触发按钮。
        真实麦克风录音 / STT / TTS 需在本机环境验证，无头 CI 下以 mock 单测覆盖状态机。
      </div>
    </>
  )
}
