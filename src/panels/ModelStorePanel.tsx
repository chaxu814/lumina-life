// ============================================================
// panels/ModelStorePanel.tsx — 🪆 Live2D 模型库（本地/离线模式）
//
// 【为什么叫「Live2D 模型」而不是「配件商城」】
// 这里管理的不是帽子/衣服一类饰品，而是**桌宠本体模型**：
// Cubism 的 .model3.json + .moc3，以及 VRM/MMD/PNT 桌宠。
// 叫「配件商城」会让用户以为这里能下载装扮，与实际功能不符。
//
// 客户端 MVP：本地模型库列表（卡片 + 预览占位）、一键热切换、从文件夹导入。
// 未配置云端 Worker 时顶部显示「本地/离线模式」提示；导入前主进程已跑
// modelValidator（schema + 恶意脚本扫描），block 级会直接拒收并展示原因。
// ============================================================

import React, { useEffect, useState, useCallback } from 'react'

interface ModelDto {
  id: string
  name: string
  kind?: string
  builtin?: boolean
  url?: string
}

interface CloudStatus {
  configured: boolean
  url: string | null
  mode: string
  note: string
}

export default function ModelStorePanel() {
  const [models, setModels] = useState<ModelDto[]>([])
  const [currentId, setCurrentId] = useState<string>('')
  const [cloud, setCloud] = useState<CloudStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string>('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [listRes, cloudRes] = await Promise.all([
        window.luminaAPI.modelStoreList(),
        window.luminaAPI.modelStoreCloudStatus(),
      ])
      if (listRes?.ok) {
        setModels(listRes.models || [])
        setCurrentId(listRes.current?.id || '')
      }
      if (cloudRes?.ok) {setCloud({ configured: cloudRes.configured, url: cloudRes.url, mode: cloudRes.mode, note: cloudRes.note })}
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {void refresh()}, [refresh])

  const switchTo = async (id: string) => {
    setBusyId(id)
    setMessage(null)
    try {
      const res = await window.luminaAPI.modelStoreSelect(id)
      if (res?.ok) {
        setCurrentId(id)
        setMessage({ kind: 'ok', text: `已切换到「${id}」，桌宠正在热加载…` })
      } else {
        setMessage({ kind: 'err', text: res?.error || '切换失败' })
      }
    } finally { setBusyId('') }
  }

  const importFolder = async () => {
    setBusyId('__import__')
    setMessage(null)
    try {
      const res = await window.luminaAPI.modelStoreImportFolder()
      if (res?.canceled) {return}
      if (res?.blocked) {
        const why = (res.issues || []).map((i: any) => `· ${i.message}`).join('\n')
        setMessage({ kind: 'err', text: `安全拦截：${res.error}\n${why}` })
      } else if (res?.ok) {
        const warn = (res.warnings || []).map((w: any) => w.message).join('；')
        setMessage({ kind: warn ? 'warn' : 'ok', text: `已导入「${res.model?.name}」${warn ? '（注意：' + warn + '）' : ''}` })
        void refresh()
      } else {
        setMessage({ kind: 'err', text: res?.error || '导入失败' })
      }
    } finally { setBusyId('') }
  }

  return (
    <div style={{ padding: '4px 2px' }}>
      {/* 标题 */}
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
        🪆 Live2D 模型
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.6 }}>
        切换桌宠用的本体模型。模型热加载，切换后立即生效。
      </div>

      {/* 离线/云端模式提示 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
        borderRadius: 10, marginBottom: 14, fontSize: 12,
        background: cloud?.configured ? 'var(--accent-50)' : 'var(--surface-100)',
        border: '1px solid var(--border-light)',
        color: 'var(--text-secondary)',
      }}>
        <span style={{ fontSize: 16 }}>{cloud?.configured ? '☁️' : '📦'}</span>
        <span>
          {cloud?.configured
            ? `已接入在线模型库：${cloud.url}`
            : (cloud?.note || '本地/离线模式：仅浏览和导入本机模型')}
        </span>
      </div>

      {/* 工具条 */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
        <button onClick={importFolder} disabled={busyId === '__import__'}
          style={{
            padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: 'var(--accent-600)', color: '#fff', fontSize: 13, fontWeight: 600,
          }}>
          {busyId === '__import__' ? '导入中…' : '＋ 从文件夹导入模型'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          支持 Live2D Cubism 3/4/5（.model3.json + .moc3）· VRM（.vrm）· MMD · PNT 桌宠，导入前自动扫描恶意脚本
        </span>
      </div>

      {/* 消息 */}
      {message && (
        <pre style={{
          whiteSpace: 'pre-wrap', fontSize: 12, padding: '10px 12px', borderRadius: 8, marginBottom: 14,
          background: message.kind === 'err' ? '#fef2f2' : message.kind === 'warn' ? '#fffbeb' : '#f0fdf4',
          color: message.kind === 'err' ? '#b91c1c' : message.kind === 'warn' ? '#92400e' : '#166534',
        }}>{message.text}</pre>
      )}

      {/* 模型卡片网格 */}
      {loading
        ? <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>加载中…</div>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {models.map((m) => {
              const active = m.id === currentId
              return (
                <div key={m.id} style={{
                  border: active ? '2px solid var(--accent-600)' : '1px solid var(--border-light)',
                  borderRadius: 10, padding: 12, background: 'var(--surface-0)',
                }}>
                  <div style={{ height: 80, borderRadius: 8, background: 'var(--surface-100)', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
                    {m.kind === 'vrm' ? '🧊' : m.kind === 'mmd' ? '🎭' : m.kind === 'pngtuber' ? '🖼️' : m.kind === 'cat' ? '🐱' : '🪆'}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
                    {m.name}
                    {active && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent-600)' }}>● 使用中</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    {m.kind}{m.builtin ? ' · 内置' : ' · 自定义'}
                  </div>
                  <button
                    onClick={() => switchTo(m.id)}
                    disabled={active || busyId === m.id}
                    style={{
                      width: '100%', padding: '6px 0', borderRadius: 6, cursor: active ? 'default' : 'pointer',
                      border: '1px solid var(--border-light)', fontSize: 12,
                      background: active ? 'var(--surface-100)' : 'var(--accent-50)',
                      color: active ? 'var(--text-secondary)' : 'var(--accent-600)',
                    }}>
                    {active ? '当前模型' : busyId === m.id ? '切换中…' : '切换'}
                  </button>
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}
