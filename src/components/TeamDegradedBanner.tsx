// ============================================================
// components/TeamDegradedBanner.tsx — 团队降级全局横幅
//
// 主进程 onTeamDegraded 推送表示：某个后台成员（Yak/热茶）未配独立模型，
// 本轮由 Lumina 代执行 —— 本轮没有真正的多 Agent 协作、审查不具备独立性。
//
// 设计要点：
//  1. 全局横幅宿主，挂在 App 根布局（TopBar 下方），任何面板下都可见。
//  2. 同一会话同类事件合并：横幅已展开时，新事件只更新内容与计数，
//     不重复弹出第二张横幅，也不重复弹系统通知（60s 节流）。
//  3. 同时触发系统通知（Notification API），用户切到别的应用也能看到。
//  4. 「去配置」复用 App.tsx 已有的 'lumina:open-settings' 事件（tab=llm）。
// ============================================================

import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { showToast } from './Toast'

// 复用 src/types.d.ts 在 luminaAPI.onTeamDegraded 上声明的 payload 类型：
// 方法首参是回调，回调首参才是 payload 对象
type DegradedEvent = Parameters<Parameters<typeof window.luminaAPI.onTeamDegraded>[0]>[0]

interface BannerState {
  payload: DegradedEvent
  /** 本会话同类（同 memberId）降级次数，合并显示 */
  count: number
}

const NOTIFY_THROTTLE_MS = 60_000

function fireSystemNotification(title: string, body: string) {
  try {
    if (typeof Notification === 'undefined') {return}
    if (Notification.permission === 'granted') {
      new Notification(title, { body })
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') {new Notification(title, { body })}
      }).catch(() => { /* 忽略权限异常 */ })
    }
  } catch {
    /* 环境不支持 Notification 时静默 */
  }
}

export default function TeamDegradedBanner() {
  const { t } = useTranslation()
  const [state, setState] = useState<BannerState | null>(null)
  const lastNotifyAtRef = useRef(0)
  const dismissedIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const api = window.luminaAPI
    // preload 尚未暴露该方法时静默跳过（运行期防御，行为与之前一致）
    if (typeof api.onTeamDegraded !== 'function') {return}

    const unsub = api.onTeamDegraded((payload) => {
      // 用户在本次运行中手动关掉过横幅，同 memberId 不再弹（重新计数也不弹）
      if (dismissedIdsRef.current.has(payload.memberId)) {return}

      setState((prev) => {
        // 同一会话同类事件合并：已展开同 memberId 横幅 → 更新内容 + 计数
        if (prev && prev.payload.memberId === payload.memberId) {
          return { payload, count: prev.count + 1 }
        }
        // 不同 memberId（比如热茶也降级了）→ 替换为最新事件，计数归零
        return { payload, count: 1 }
      })

      // 系统通知：60s 内同类事件只弹一次，避免刷屏
      const now = Date.now()
      if (now - lastNotifyAtRef.current > NOTIFY_THROTTLE_MS) {
        lastNotifyAtRef.current = now
        fireSystemNotification(
          t('banner.notification_title'),
          t('banner.notification_body', { name: payload.memberName }),
        )
        showToast(t('banner.toast_body', { name: payload.memberName }), 'warning')
      }
    })

    return () => {
      if (typeof unsub === 'function') {unsub()}
    }
  }, [t])

  if (!state) {return null}
  const { payload, count } = state

  const goConfigure = () => {
    window.dispatchEvent(new CustomEvent('lumina:open-settings', { detail: { tab: 'llm' } }))
  }

  const close = () => {
    dismissedIdsRef.current.add(payload.memberId)
    setState(null)
  }

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: 44, left: '50%', transform: 'translateX(-50%)',
        zIndex: 9998,
        display: 'flex', alignItems: 'center', gap: 10,
        maxWidth: 680,
        padding: '8px 14px',
        borderRadius: 10,
        background: 'var(--yellow-100, #fef9c3)',
        border: '1px solid var(--yellow-300, #fde047)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
        fontSize: 12.5,
        color: 'var(--text-primary)',
        animation: 'fadeInDown 0.2s ease-out',
      }}
    >
      <span style={{ fontSize: 16 }}>⚠️</span>
      <div style={{ flex: 1, lineHeight: 1.5 }}>
        <b>{t('banner.title', { name: payload.memberName })}</b>
        <span style={{ margin: '0 4px' }}>—</span>
        {t('banner.body')}
        {count > 1 && (
          <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>
            {t('banner.count', { count })}
          </span>
        )}
        {payload.taskPreview && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
            {t('banner.task_preview', { task: payload.taskPreview })}
          </div>
        )}
      </div>
      <button
        onClick={goConfigure}
        style={{
          flexShrink: 0, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
          border: 'none', background: 'var(--accent-500)', color: '#fff',
          fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        }}
      >
        {t('banner.configure')}
      </button>
      <button
        onClick={close}
        aria-label={t('banner.close')}
        style={{
          flexShrink: 0, width: 22, height: 22, borderRadius: 6, cursor: 'pointer',
          border: 'none', background: 'transparent', color: 'var(--text-secondary)',
          fontSize: 13, lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  )
}
