import React, { useState, useEffect, useRef } from 'react'
import { SettingSection, SettingRow, SettingRowLast, Toggle, SettingBtn, StatusBadge } from '../../components/SettingsUI'

/** 💻 Lumina Virtual Pet 设置（整合模型/大小/穿透/自主行为/动作测试） */
export default function SettingsPet() {
  const [petRunning, setPetRunning] = useState(false)
  const [petClickThrough, setPetClickThrough] = useState(true)
  const [petAutoRestart, setPetAutoRestart] = useState(true)
  const [petModel, setPetModel] = useState<'Mao'>('Mao')
  const [petScale, setPetScale] = useState(100)
  const [petAuto, setPetAuto] = useState<'off' | 'light' | 'heavy'>('light')
  const [starting, setStarting] = useState(false)
  const [startProgress, setStartProgress] = useState(0)
  const [startStage, setStartStage] = useState('')
  const scaleTimer = useRef<any>(null)

  const api = () => (window as any).luminaAPI

  // 初始化 + 状态广播同步
  useEffect(() => {
    ;(async () => {
      try {
        const status = await api()?.petStatus?.()
        setPetRunning(!!status)
        const cfg = await api()?.petConfig?.()
        if (cfg) {
          setPetClickThrough(!!cfg.clickThrough)
          setPetAutoRestart(!!cfg.autoRestart)
          if (typeof cfg.scale === 'number') setPetScale(Math.round(cfg.scale * 100))
          if (cfg.auto === 'off' || cfg.auto === 'light' || cfg.auto === 'heavy') setPetAuto(cfg.auto)
        }
        const m = await api()?.petGetModel?.()
        if (m === 'Mao') setPetModel(m)
      } catch {}
    })()
    const unsubState = api()?.onPetState?.((r: boolean) => { setPetRunning(!!r); if (r) { setStarting(false); setStartProgress(100) } })
    const unsubProgress = api()?.onPetStartupProgress?.((p: number, stage: string) => {
      setStartProgress(p)
      setStartStage(stage)
      if (p >= 100) {
        setTimeout(() => { setStarting(false); setStartProgress(0) }, 600)
      }
    })
    return () => { unsubState?.(); unsubProgress?.() }
  }, [])

  const handlePetToggle = async () => {
    const next = !petRunning
    try {
      if (next) {
        setStarting(true)
        setStartProgress(5)
        setStartStage('正在启动…')
      }
      const res = await api()?.petToggle?.(next)
      if (res?.ok) {
        setPetRunning(next)
        if (!next) { setStarting(false); setStartProgress(0) }
      } else {
        setStarting(false)
      }
    } catch {
      console.error('[SettingsPet] 桌宠切换失败')
      setStarting(false)
    }
  }

  const handlePetClickThroughToggle = async () => {
    const next = !petClickThrough
    setPetClickThrough(next)
    try { await api()?.petUpdateConfig?.({ clickThrough: next }) } catch {}
  }

  const handlePetAutoRestartToggle = async () => {
    const next = !petAutoRestart
    setPetAutoRestart(next)
    try { await api()?.petUpdateConfig?.({ autoRestart: next }) } catch {}
  }

  const handleModelChange = async (v: 'Mao') => {
    setPetModel(v)
    try { await api()?.petSettings?.({ model: v }) } catch {}
  }

  const handleScaleInput = (v: number) => {
    setPetScale(v)
    clearTimeout(scaleTimer.current)
    scaleTimer.current = setTimeout(async () => {
      try { await api()?.petSettings?.({ scale: v / 100 }) } catch {}
    }, 400)
  }

  const handleAutoChange = async (v: 'off' | 'light' | 'heavy') => {
    setPetAuto(v)
    try { await api()?.petSettings?.({ auto: v }) } catch {}
  }

  const testAction = (action: string) => {
    try {
      api()?.petTestIntent?.({ action, mood: '开心 😊', speech: action + '喵~' })
    } catch {}
  }

  const selectStyle: React.CSSProperties = {
    background: 'var(--surface-100, #f3f4f6)', border: '1px solid var(--border-light)',
    borderRadius: 8, padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)', outline: 'none',
  }
  const btnStyle: React.CSSProperties = {
    padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border-light)',
    background: 'var(--surface-100, #f3f4f6)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12,
  }
  const ACTION_LABELS: Record<string, string> = {
    wave: '👋 挥手', nod: '🙂 点头', think: '💭 思考', happy: '🎉 开心', sleep: '😴 睡觉', wake: '☀️ 醒来',
  }

  return (
    <SettingSection title="🐾 Lumina Virtual Pet" desc="Lumina 电子宠物——一个小伙伴常驻在桌面上陪伴你（右键模型可打开自定义菜单 / 按住模型可拖拽移动）">
      <SettingRow label="桌宠开关" desc="启动/关闭桌宠">
        {starting ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 180 }}>
            <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--surface-200, #e5e7eb)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${startProgress}%`, borderRadius: 3,
                background: 'linear-gradient(90deg, #7c6ff7, #4a9eff)',
                transition: 'width .3s ease',
              }} />
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{startProgress}%</span>
          </div>
        ) : (
          <>
            <StatusBadge status={petRunning ? 'running' : 'stopped'} label={petRunning ? '运行中' : '已关闭'} />
            <SettingBtn variant={petRunning ? 'danger' : 'success'} onClick={handlePetToggle}>
              {petRunning ? '关闭' : '启动'}
            </SettingBtn>
          </>
        )}
      </SettingRow>
      {starting && startStage && (
        <div style={{ padding: '0 0 8px 0', fontSize: 11, color: 'var(--text-secondary)' }}>{startStage}</div>
      )}

      <SettingRow label="鼠标穿透" desc="开启后空白区域穿透到桌面；悬停模型时自动接管鼠标可交互">
        <Toggle checked={petClickThrough} onChange={handlePetClickThroughToggle} />
      </SettingRow>

      <SettingRow label="模型" desc="切换 Live2D 模型（记住选择）">
        <select value={petModel} onChange={(e) => handleModelChange(e.target.value as 'Mao')} style={selectStyle}>
          <option value="Mao">虹色 Mao</option>
        </select>
      </SettingRow>

      <SettingRow label={`大小 ${petScale}%`} desc="拖动调整模型尺寸（40%–160%，会保存）">
        <input
          type="range" min={40} max={160} step={5} value={petScale}
          onChange={(e) => handleScaleInput(Number(e.target.value))}
          style={{ width: 160, accentColor: 'var(--accent-500, #7c6ff7)' }}
        />
      </SettingRow>

      <SettingRow label="自主行为" desc="关闭 / 轻度：LLM 每 60s 自主思考行动 / 重度：30s 并附加屏幕感知">
        <select value={petAuto} onChange={(e) => handleAutoChange(e.target.value as 'off' | 'light' | 'heavy')} style={selectStyle}>
          <option value="off">关闭</option>
          <option value="light">轻度</option>
          <option value="heavy">重度</option>
        </select>
      </SettingRow>

      <SettingRow label="动作测试" desc="直接驱动 Live2D 做对应动作">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {Object.keys(ACTION_LABELS).map((a) => (
            <button key={a} style={btnStyle} onClick={() => testAction(a)}>{ACTION_LABELS[a]}</button>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="完整设置面板" desc="对话/动画/声音/猫爪模式等 N.E.K.O 风格设置">
        <SettingBtn variant="primary" onClick={() => { try { api()?.petOpenSettings?.() } catch {} }}>打开</SettingBtn>
      </SettingRow>

      <SettingRow label="初始人格引导" desc="重看新手引导，选择陪着你的样子">
        <SettingBtn variant="primary" onClick={() => { try { api()?.petOpenOnboarding?.() } catch {} }}>打开</SettingBtn>
      </SettingRow>

      <SettingRowLast label="随 Lumina 启动" desc="打开 Lumina 主程序时自动启动桌宠">
        <Toggle checked={petAutoRestart} onChange={handlePetAutoRestartToggle} />
      </SettingRowLast>
    </SettingSection>
  )
}
