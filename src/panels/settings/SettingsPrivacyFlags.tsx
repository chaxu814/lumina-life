/**
 * SettingsPrivacyFlags.tsx — 「隐私与开关」设置页（I6 + I7）
 *
 * 两块内容：
 *  A. 你的数据在哪（I6 隐私/自托管叙事）：
 *     - 本地 SQLite 文件位置、记忆不上云、API Key 本机加密、TF-IDF 离线可用
 *     - 诚实声明：模型推理按你配置走（联网或本地模型），本页只负责记忆与人格文件
 *     - 一键导出/导入（zip），双协议 License 行
 *  B. 功能开关（I7）：列出所有 flag，点击即时生效并写回主进程
 */
import React, { useEffect, useState } from 'react'
import {
  FLAG_META, loadFlags, setFlagRemote, snapshotFlags, RendererFlagKey,
} from '../../services/featureFlagsClient'

const card: React.CSSProperties = {
  borderRadius: 12, border: '1px solid var(--border-light)', padding: 20,
  marginBottom: 16, background: 'var(--surface-0)',
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
}
const titleStyle: React.CSSProperties = {
  fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10,
  display: 'flex', alignItems: 'center', gap: 6,
}
const bodyStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 8,
}

export default function SettingsPrivacyFlags() {
  const [flags, setFlags] = useState<Record<RendererFlagKey, boolean>>(snapshotFlags())
  const [busy, setBusy] = useState<'idle' | 'export' | 'import'>('idle')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [locs, setLocs] = useState<{ userData?: string; memoryDb?: string; flagsFile?: string }>({})

  useEffect(() => {
    loadFlags().then(setFlags)
    const api = (window as any).luminaAPI
    api?.dataGetLocations?.().then((r: any) => setLocs(r || {})).catch(() => {})
  }, [])

  const toggle = async (key: RendererFlagKey, value: boolean) => {
    await setFlagRemote(key, value)
    setFlags(await loadFlags())
    if (key === 'mode.minimal') {
      setMsg({ ok: true, text: value ? '已开启精简模式（重新打开窗口后完整生效）' : '已关闭精简模式' })
    }
  }

  const doExport = async () => {
    setBusy('export'); setMsg(null)
    const api = (window as any).luminaAPI
    try {
      if (!api?.dataExportZip) { setMsg({ ok: false, text: '导出接口尚未接线（集成方接入后可用）' }); return }
      const r = await api.dataExportZip()
      if (r?.ok) {setMsg({ ok: true, text: `已导出到：${r.zipPath}（约 ${((r.bytes || 0) / 1024).toFixed(0)} KB）` })}
      else {setMsg({ ok: false, text: '导出失败：' + (r?.error || '未知') })}
    } catch (e: any) {
      setMsg({ ok: false, text: '导出失败：' + (e?.message || e) })
    } finally { setBusy('idle') }
  }

  const doImport = async () => {
    setBusy('import'); setMsg(null)
    const api = (window as any).luminaAPI
    try {
      if (!api?.dataImportZip) { setMsg({ ok: false, text: '导入接口尚未接线（集成方接入后可用）' }); return }
      const r = await api.dataImportZip()
      if (r?.ok) {
        const total = Object.values(r.imported || {}).reduce((a: number, b: any) => a + (b || 0), 0)
        setMsg({ ok: true, text: `导入完成：新增 ${total} 条记录（已存在的自动跳过，不覆盖）` })
      } else {setMsg({ ok: false, text: '导入失败：' + (r?.error || '未知') })}
    } catch (e: any) {
      setMsg({ ok: false, text: '导入失败：' + (e?.message || e) })
    } finally { setBusy('idle') }
  }

  return (
    <div>
      {/* A. 你的数据在哪 */}
      <div style={card}>
        <div style={titleStyle}>🔐 你的数据在哪</div>
        <div style={bodyStyle}>
          Lumina 是<b>本地优先</b>的：关于你的一切记忆、人格文件、对话摘要都只存在这台电脑上，
          不上传到任何服务器。API Key 也只在本机加密保存；离线检索（TF-IDF）在断网时照样能工作。
        </div>
        <div style={{ ...bodyStyle, background: 'var(--surface-1)', padding: '8px 12px', borderRadius: 8 }}>
          <div>🗂️ 数据目录：<code style={{ fontSize: 11 }}>{locs.userData || '（启动后显示）'}</code></div>
          <div>🗃️ 记忆库：<code style={{ fontSize: 11 }}>{locs.memoryDb || 'lumina-memory.db'}</code></div>
        </div>
        <div style={{ ...bodyStyle, color: 'var(--text-tertiary, #888)' }}>
          诚实说明：记忆文件只在本机；但「模型推理」按你配置走——
          用云端模型时请求会发给你填的服务商，用本地模型（如 Ollama）时则完全不出本机。
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button onClick={doExport} disabled={busy !== 'idle'}
            style={btn}>📦 导出我的全部记忆 (.zip)</button>
          <button onClick={doImport} disabled={busy !== 'idle'}
            style={btn}>📥 从备份导入（合并，不覆盖）</button>
        </div>
        {msg && (
          <div style={{
            marginTop: 12, fontSize: 12, padding: '8px 12px', borderRadius: 8,
            background: msg.ok ? 'var(--green-100, #dcfce7)' : 'var(--red-100, #fee2e2)',
            color: msg.ok ? '#166534' : '#991b1b',
          }}>{msg.text}</div>
        )}
        <div style={{ ...bodyStyle, marginTop: 14, paddingTop: 10, borderTop: '1px dashed var(--border-light)' }}>
          License: <b>AGPL-3.0 OR Apache-2.0</b> — 核心永远开放，你可以自托管、审计、二次开发。
        </div>
      </div>

      {/* B. 功能开关 */}
      <div style={card}>
        <div style={titleStyle}>{flags['mode.minimal'] ? '🧪 功能开关（精简模式进行中）' : '🧪 功能开关'}</div>
        <div style={bodyStyle}>
          新行为默认保守：实验项默认关，成熟增强默认开。改动即时生效并写入本机配置；
          「精简模式」打开后侧边栏只保留聊天与设置，其余高级项收进这里。
        </div>
        {Object.entries(
          FLAG_META.reduce<Record<string, typeof FLAG_META>>((acc, f) => {
            ;(acc[f.group] ||= []).push(f)
            return acc
          }, {})
        ).map(([group, items]) => (
          <div key={group} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>{group}</div>
            {items.map(f => (
              <div key={f.key} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 4px', borderBottom: '1px solid var(--border-light)',
              }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {f.name}
                    <span style={{ fontWeight: 400, color: 'var(--text-tertiary, #999)', marginLeft: 8, fontSize: 11 }}>{f.desc}</span>
                  </div>
                </div>
                <Switch checked={!!flags[f.key]} onChange={v => toggle(f.key, v)} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

const btn: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border-light)',
  background: 'var(--surface-1)', cursor: 'pointer', fontSize: 12,
  color: 'var(--text-primary)',
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)}
      style={{
        width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
        background: checked ? '#3b82f6' : '#cbd5e1', position: 'relative', transition: 'background .15s',
      }}>
      <span style={{
        position: 'absolute', top: 2, left: checked ? 20 : 2, width: 18, height: 18,
        borderRadius: '50%', background: '#fff', transition: 'left .15s',
        boxShadow: '0 1px 3px rgba(0,0,0,.2)',
      }} />
    </button>
  )
}
