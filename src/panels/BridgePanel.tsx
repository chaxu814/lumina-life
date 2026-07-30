import React, { useState } from 'react'
import { useStore } from '../stores/appStore'
import { IconWifi, IconWifiOff, IconCheck, IconGlobe, IconDiscord } from '../components/Icons'

const PLATFORMS = [
  { id: 'discord' as const, name: 'Discord', desc: '全球游戏社区', Icon: IconDiscord },
  { id: 'wechat' as const, name: '微信 OneBot', desc: '国内主力平台，支持群聊/私聊', Icon: IconGlobe },
  { id: 'telegram' as const, name: 'Telegram', desc: 'Bot API 实时推送', Icon: IconGlobe },
  { id: 'feishu' as const, name: '飞书', desc: '企业协作 · 消息/文档/日历', Icon: IconGlobe },
]

export default function BridgePanel() {
  const bridgeConfig = useStore((s) => s.bridgeConfig)
  const setBridgeConfig = useStore((s) => s.setBridgeConfig)

  const connectedCount = PLATFORMS.filter((p) => bridgeConfig[p.id]?.enabled).length

  const updatePlatform = (id: string, updates: any) => {
    const all = { ...bridgeConfig } as any
    all[id] = { ...all[id], ...updates }
    setBridgeConfig(all)
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">🌐 桥接</div>
        <div className="panel-subtitle">
          {connectedCount}/{PLATFORMS.length} 平台已连接 · 多平台消息同步
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {PLATFORMS.map((plat) => {
          const cfg = bridgeConfig[plat.id]
          const isOn = cfg?.enabled
          const connected = isOn && cfg?.token
          return (
            <div key={plat.id} className="card" style={{ padding: '18px 20px' }}>
              <div style={{ display: 'flex', gap: 14 }}>
                {/* Status indicator */}
                <div style={{
                  width: 40, height: 40, borderRadius: 'var(--radius-md)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: connected ? 'var(--green-100)' : 'var(--surface-100)',
                  color: connected ? 'var(--green-500)' : 'var(--text-disabled)',
                  flexShrink: 0,
                }}>
                  {connected ? <IconWifi size={20} /> : <IconWifiOff size={20} />}
                </div>

                {/* Info */}
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{plat.name}</span>
                    {connected && <span className="badge badge-success"><IconCheck size={11} />已连接</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12 }}>{plat.desc}</div>

                  {isOn && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
                        <label className="form-label">
                          {plat.id === 'discord' ? 'Bot Token' : plat.id === 'wechat' ? 'WebSocket URL' : 'Token'}
                        </label>
                        <input
                          className="form-input mono"
                          type="password"
                          value={cfg.token || ''}
                          onChange={(e) => updatePlatform(plat.id, { token: e.target.value })}
                          placeholder={plat.id === 'discord' ? 'MTEx...' : plat.id === 'wechat' ? 'ws://127.0.0.1:6700' : '输入 Token'}
                        />
                      </div>
                      {connected && (
                        <button className="btn btn-secondary btn-sm" style={{ marginBottom: 0 }}>重连</button>
                      )}
                    </div>
                  )}
                </div>

                {/* Toggle */}
                <div className={'toggle' + (isOn ? ' on' : '')} onClick={() => updatePlatform(plat.id, { enabled: !isOn })} />
              </div>
            </div>
          )
        })}
      </div>

      {/* Sync log */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <span style={{ fontSize: 16 }}>📋</span>
          <span className="card-title">同步日志</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[
            '10:32 — Discord #general → 回复成功',
            '10:15 — 微信 → 收到消息 "早上好"',
            '09:45 — Telegram → 发送每日新闻',
          ].map((log, i) => (
            <div key={i} style={{ padding: '4px 0', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{log}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
