// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// panels/WebDavSyncPanel.tsx — 跨设备云同步设置页（提案4）
//
// WebDAV 配置表单 / 连接测试 / 加密口令 / 立即同步 / 冲突解决列表。
// 兼容坚果云 / Nextcloud / 任意 WebDAV 服务。
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

export default function WebDavSyncPanel({ embedded }: { embedded?: boolean } = {}) {
  const [form, setForm] = useState({ url: '', username: '', password: '', remoteDir: 'lumina-sync', direction: 'bidirectional' as any })
  const [encPwd, setEncPwd] = useState('')
  const [hasEnc, setHasEnc] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [report, setReport] = useState<any>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await api().webdavGetConfig()
      if (r.ok && r.config) {
        setForm((f) => ({ ...f, url: r.config.url || '', username: r.config.username || '', remoteDir: r.config.remoteDir || 'lumina-sync', direction: r.config.direction || 'bidirectional' }))
        setHasEnc(!!r.hasEncryption)
      }
    } catch {}
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const saveSettings = async () => {
    setErr(''); setMsg(''); setBusy(true)
    try {
      const r = await api().webdavSaveSettings({ ...form })
      if (!r.ok) {setErr(r.error || '保存失败'); return}
      setMsg('连接配置已保存（密码已用系统 safeStorage 加密存储）。')
    } catch (e: any) {setErr(e?.message || String(e))} finally {setBusy(false)}
  }

  const testConn = async () => {
    setErr(''); setMsg(''); setBusy(true)
    try {
      // 先保存当前表单再测
      await api().webdavSaveSettings({ ...form })
      const r = await api().webdavTestConnection()
      if (r.ok) {setMsg(`连接成功 ✅（HTTP ${r.status}）`)}
      else {setErr('连接失败：' + (r.error || ('HTTP ' + r.status)))}
    } catch (e: any) {setErr(e?.message || String(e))} finally {setBusy(false)}
  }

  const saveEnc = async () => {
    setErr(''); setMsg('')
    const r = await api().webdavSetEncryptionPassword(encPwd)
    if (r.ok) {setHasEnc(!!encPwd); setEncPwd(''); setMsg(encPwd ? '客户端加密已开启，云端只存密文。' : '已关闭客户端加密。')}
  }

  const runSync = async () => {
    setErr(''); setMsg(''); setReport(null); setBusy(true)
    try {
      const r = await api().webdavRun()
      if (!r.ok) {setErr(r.error || '同步失败'); return}
      setReport(r.report)
      setMsg(`同步完成：上传 ${r.report.uploaded}，下载 ${r.report.downloaded}，删除 ${r.report.deleted}，冲突 ${r.report.conflicts.length}`)
    } catch (e: any) {setErr(e?.message || String(e))} finally {setBusy(false)}
  }

  const resolve = async (rel: string, choice: 'local' | 'remote' | 'merge') => {
    setErr('')
    const r = await api().webdavResolveConflict(rel, choice)
    if (r.ok) {setMsg(`已按「${choice === 'local' ? '保留本机' : choice === 'remote' ? '保留云端' : '合并'}」解决 ${rel}`); runSync()}
    else {setErr(r.error || '解决失败')}
  }

  const conflicts: string[] = report?.conflicts || []

  return (
    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
      <div style={card}>
        <div style={{ ...label, fontSize: 13, marginBottom: 6 }}>☁️ 跨设备云同步（WebDAV）</div>
        <div style={{ marginBottom: 10, lineHeight: 1.6 }}>
          把记忆文件与数据库备份同步到你自己的 WebDAV 网盘。推荐坚果云 / Nextcloud。
        </div>

        <div style={label}>WebDAV 地址</div>
        <input style={input} placeholder="https://dav.jianguoyun.com/dav/" value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <div style={label}>用户名</div>
        <input style={input} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <div style={label}>密码（应用授权码）</div>
        <input style={input} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <div style={label}>云端目录名</div>
        <input style={input} value={form.remoteDir} onChange={(e) => setForm({ ...form, remoteDir: e.target.value })} />
        <div style={label}>同步方向</div>
        <select style={input} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
          <option value="bidirectional">双向同步</option>
          <option value="upload-only">仅上传</option>
          <option value="download-only">仅下载</option>
        </select>

        <button style={btn} onClick={saveSettings} disabled={busy}>保存配置</button>
        <button style={subtleBtn} onClick={testConn} disabled={busy}>测试连接</button>
      </div>

      <div style={card}>
        <div style={label}>🔒 客户端加密（AES-256-GCM）</div>
        <div style={{ marginBottom: 8, opacity: 0.8, lineHeight: 1.6 }}>
          {hasEnc ? '已开启：云端只存密文。' : '未开启：文件以明文上传。'} 设置口令后，上传前在本地加密。
        </div>
        <input style={input} type="password" placeholder={hasEnc ? '留空=关闭；输入新口令=更换' : '设置加密口令'}
          value={encPwd} onChange={(e) => setEncPwd(e.target.value)} />
        <button style={subtleBtn} onClick={saveEnc}>{hasEnc ? '更新/关闭加密口令' : '开启加密'}</button>
      </div>

      <div style={card}>
        <button style={btn} onClick={runSync} disabled={busy}>{busy ? '同步中…' : '立即同步'}</button>
        {report && (
          <div style={{ marginTop: 8, fontSize: 11, opacity: 0.8 }}>
            上传 {report.uploaded} · 下载 {report.downloaded} · 删除 {report.deleted} · 冲突 {report.conflicts.length}
          </div>
        )}
      </div>

      {conflicts.length > 0 && (
        <div style={card}>
          <div style={{ ...label, color: '#d97706' }}>⚠ 冲突文件（{conflicts.length}）</div>
          {conflicts.map((c) => (
            <div key={c} style={{ padding: 6, borderBottom: '1px solid var(--border-light)' }}>
              <div style={{ marginBottom: 4 }}>{c}</div>
              <button style={subtleBtn} onClick={() => resolve(c, 'local')}>保留本机</button>
              <button style={subtleBtn} onClick={() => resolve(c, 'remote')}>保留云端</button>
              <button style={subtleBtn} onClick={() => resolve(c, 'merge')}>合并(文本)</button>
            </div>
          ))}
        </div>
      )}

      {msg && <div style={{ ...card, borderColor: 'var(--accent-200)', color: 'var(--text-primary)' }}>{msg}</div>}
      {err && <div style={{ ...card, borderColor: '#dc2626', color: '#dc2626' }}>{err}</div>}

      <div style={{ opacity: 0.55, fontSize: 11, lineHeight: 1.6 }}>
        诚实说明：WebDAV 真实服务器连接尚未实机验证（当前用 mock 单测覆盖请求构造）；
        AES 加解密已做代码层 round-trip 验证。官方云需自建服务端（预留 officialCloud 接口，当前为空）。
      </div>
    </div>
  )
}
