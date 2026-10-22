// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React, { useState } from 'react'
import { SettingSection, Toggle, SettingRowLast } from '../../components/SettingsUI'

/** 🔔 主动通知设置 */
export default function SettingsNotifications() {
  const [proactiveNotify, setProactiveNotify] = useState(() => {
    try { return localStorage.getItem('lumina_proactive_notify') !== 'false' } catch { return true }
  })

  const handleToggle = (v: boolean) => {
    setProactiveNotify(v)
    try { localStorage.setItem('lumina_proactive_notify', v ? 'true' : 'false') } catch {}
  }

  return (
    <SettingSection
      title="🔔 主动通知"
      desc="当 Lumina 主动搭话时（早安/晚安提醒、热搜话题等），通过 Windows 弹窗通知你"
      badge={proactiveNotify ? '已开启' : undefined}
    >
      <SettingRowLast label="通知开关" desc="开启后，Lumina 主动推送的消息会通过系统弹窗提醒你">
        <Toggle checked={proactiveNotify} onChange={handleToggle} />
      </SettingRowLast>

      <div style={{
        marginTop: 12, padding: 12, borderRadius: 8,
        background: 'linear-gradient(135deg, #fef3c7, #fef9c3)',
        border: '1px solid #f59e0b', fontSize: 11,
      }}>
        <div style={{ color: '#92400e', marginBottom: 4, fontWeight: 600 }}>💡 提示</div>
        <div style={{ color: '#b45309', lineHeight: 1.5 }}>
          主动引擎的具体触发策略和调度配置在左侧面板的「主动引擎」侧边栏中管理。此处仅控制是否通过系统弹窗通知。
        </div>
      </div>
    </SettingSection>
  )
}
