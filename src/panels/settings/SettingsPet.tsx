import React, { useState, useEffect } from 'react'
import { SettingSection, SettingRow, SettingRowLast, Toggle, SettingBtn, StatusBadge } from '../../components/SettingsUI'

/** 💻 桌宠模式设置 */
export default function SettingsPet() {
  const [petRunning, setPetRunning] = useState(false)
  const [petClickThrough, setPetClickThrough] = useState(false)
  const [petAutoRestart, setPetAutoRestart] = useState(true)
  const [petOpacity, setPetOpacity] = useState(1.0)

  // 监听桌宠事件
  useEffect(() => {
    const unsubscribe = window.luminaAPI?.onPetEvent?.((event: any) => {
      if (event.type === 'double-click') {
        // 双击桌宠 → 主窗口显示
      }
      if (event.type === 'idle-long') {
        // 可触发主动问候
      }
    })
    return () => unsubscribe?.()
  }, [])

  // 初始化状态
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

  const handlePetToggle = async () => {
    const next = !petRunning
    try {
      const res = await window.luminaAPI?.petToggle?.(next)
      if (res?.ok) setPetRunning(next)
    } catch {
      console.error('[SettingsPet] 桌宠切换失败')
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

  return (
    <SettingSection title="🐱 桌宠模式" desc="Lumina 桌面宠物——一个小伙伴常驻在桌面上陪伴你">
      <SettingRow label="桌宠开关" desc="启动/关闭桌宠">
        <StatusBadge status={petRunning ? 'running' : 'stopped'} label={petRunning ? '运行中' : '已关闭'} />
        <SettingBtn variant={petRunning ? 'danger' : 'success'} onClick={handlePetToggle}>
          {petRunning ? '关闭' : '启动'}
        </SettingBtn>
      </SettingRow>

      <SettingRow label="鼠标穿透" desc="开启后点击桌宠不会遮挡桌面操作">
        <Toggle checked={petClickThrough} onChange={handlePetClickThroughToggle} />
      </SettingRow>

      <SettingRowLast label="自动重启" desc="Lumina 启动时自动开启桌宠">
        <Toggle checked={petAutoRestart} onChange={handlePetAutoRestartToggle} />
      </SettingRowLast>
    </SettingSection>
  )
}
