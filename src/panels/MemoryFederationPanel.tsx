// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// panels/MemoryFederationPanel.tsx — 记忆共享设置页（提案3 Level 1）
//
// 导出本地记忆为 JSON 包 / 粘贴导入别人分享的记忆包 /
// 查看已导入的联邦记忆列表与来源标签、可信度。
// 导入的记忆落在 federated/<source>/，不覆盖你的原文件。
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'

const api = () => (window as any).luminaAPI

const card: React.CSSProperties = {
  borderRadius: 10, border: '1px solid var(--border-light)', padding: 14,
  marginBottom: 10, background: 'var(--surface-0)',
}
const input: React.CSSProperties = {
  width: '100%', padding: 7, borderRadius: 7, border: '1px solid var(--border-light)',
  background: 'var(--surface-0)', color: 'var(--text-primary)', marginBottom: 8, fontSize: 12,
}
const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 3, display: 'block' }
const btn: React.CSSProperties = {
  border: 'none', borderRadius: 7, padding: '7px 14px', fontSize: 12, fontWeight: 700,
  cursor: 'pointer', marginRight: 6, background: 'var(--accent-600)', color: '#fff',
}
const subtleBtn: React.CSSProperties = { ...btn, background: 'var(--surface-100)', color: 'var(--text-primary)' }

export default function MemoryFederationPanel({ embedded }: { embedded?: boolean } = {}) {
  const [sources, setSources] = useState<any[]>([])
  const [exportedJson, setExportedJson] = useState('')
  const [importText, setImportText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      const r = await api().federationList()
      if (r.ok) {setSources(r.sources || [])}
    } catch {}
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const doExport = async () => {
    setErr(''); setMsg(''); setBusy(true)
    try {
      const r = await api().federationExport({})
      if (!r.ok) {setErr(r.error || '导出失败'); return}
      const json = JSON.stringify(r.package, null, 2)
      setExportedJson(json)
      setMsg(`已打包 ${r.package.entries.length} 条记忆（你自己的，可信度 1.0）。可复制下方 JSON 发给别人。`)
    } catch (e: any) {setErr(e?.message || String(e))} finally {setBusy(false)}
  }

  const doSaveExport = async () => {
    if (!exportedJson) {return}
    try {
      const path = await api().dialogSave({ defaultPath: 'lumina-memory-export.json', filters: [{ name: '记忆包', extensions: ['json'] }] })
      if (path) {
        await api().fsWriteFile(path, exportedJson)
        setMsg('已保存到 ' + path)
      }
    } catch (e: any) {setErr(e?.message || String(e))}
  }

  const doImport = async () => {
    setErr(''); setMsg(''); setBusy(true)
    try {
      let pkg: any
      try { pkg = JSON.parse(importText) } catch {setErr('JSON 解析失败'); return}
      const r = await api().federationImport(pkg, { onConflict: 'mark' })
      if (!r.ok) {setErr(r.error || '导入失败'); return}
      setMsg(`导入完成：新增 ${r.imported} 条，跳过 ${r.skipped} 条${r.conflicts.length ? '，冲突 ' + r.conflicts.length + ' 条（已标记，未覆盖你的原文件）' : ''}`)
      setImportText('')
      refresh()
    } catch (e: any) {setErr(e?.message || String(e))} finally {setBusy(false)}
  }

  const changeConfidence = async (source: string, v: number) => {
    await api().federationSetConfidence(source, v)
    refresh()
  }

  return (
    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
      <div style={card}>
        <div style={{ ...label, fontSize: 13, marginBottom: 6 }}>🤝 团队记忆共享 Federation</div>
        <div style={{ marginBottom: 10, lineHeight: 1.6 }}>
          把你的记忆打包成可分享的 JSON，也可以导入别人分享的记忆。
          导入的记忆会隔离存放在 <code>federated/&lt;来源&gt;/</code>，<b>不会覆盖你自己的原文件</b>。
          你自己的记忆可信度 1.0，导入的默认 0.7，可在下方调整。
        </div>

        <div style={{ borderTop: '1px dashed var(--border-light)', margin: '10px 0' }} />

        <div style={label}>① 导出我的记忆</div>
        <button style={btn} onClick={doExport} disabled={busy}>{busy ? '打包中…' : '打包导出'}</button>
        {exportedJson && <button style={subtleBtn} onClick={doSaveExport}>保存为文件</button>}
        {exportedJson && (
          <textarea readOnly value={exportedJson.slice(0, 4000)} style={{ ...input, height: 120, marginTop: 8 }} />
        )}

        <div style={{ borderTop: '1px dashed var(--border-light)', margin: '14px 0' }} />

        <div style={label}>② 导入记忆包（粘贴别人分享的 JSON）</div>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder='{"version":1,"app":"lumina-life",...}'
          style={{ ...input, height: 100 }}
        />
        <button style={btn} onClick={doImport} disabled={busy || !importText.trim()}>导入</button>
      </div>

      <div style={card}>
        <div style={label}>③ 已导入的联邦记忆（{sources.length}）</div>
        {sources.length === 0 && <div style={{ opacity: 0.6 }}>还没有导入的记忆。</div>}
        {sources.map((s) => (
          <div key={s.source} style={{ padding: 8, border: '1px solid var(--border-light)', borderRadius: 8, marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>
                来源 <b style={{ color: 'var(--text-primary)' }}>{s.source}</b>
                <span style={{ marginLeft: 8, opacity: 0.6 }}>{s.entryCount} 条</span>
                {s.status === 'conflict' && <span style={{ marginLeft: 8, color: '#d97706' }}>⚠ {s.conflicts.length} 冲突待选</span>}
              </span>
              <span style={{ fontSize: 11 }}>
                可信度
                <input
                  type="range" min={0} max={1} step={0.1} value={s.confidence}
                  onChange={(e) => changeConfidence(s.source, parseFloat(e.target.value))}
                  style={{ verticalAlign: 'middle', marginLeft: 6 }}
                />
                {Number(s.confidence).toFixed(1)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {msg && <div style={{ ...card, borderColor: 'var(--accent-200)', color: 'var(--text-primary)' }}>{msg}</div>}
      {err && <div style={{ ...card, borderColor: '#dc2626', color: '#dc2626' }}>{err}</div>}

      <div style={{ opacity: 0.55, fontSize: 11, lineHeight: 1.6 }}>
        说明：公共记忆池（Cloudflare Worker）模板见 <code>docs/templates/memory-pool-worker.js</code>；
        端到端加密的 P2P 架构尚为设计稿（隐私红线，未实现），见 <code>docs/federation-e2ee-design.md</code>。
      </div>
    </div>
  )
}
