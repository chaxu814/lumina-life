// ============================================================
// components/ArtifactViewer.tsx — 产物渲染区
//
// 产物标签页栏 + 渲染区：
// - code   ：行号 + 简单关键字正则着色
// - markdown：极简正则渲染（标题/列表/代码块/换行）
// - image  ：<img> 渲染 dataUrl，显示实际尺寸
// - pdf    ：<iframe>/<embed> 渲染 blobUrl，带系统打开
// - json   ：JSON.parse 格式化 + 代码高亮
// - csv    ：解析为原生 <table>，首行表头，奇偶交替，横向滚动
// - text   ：等宽字体 + 行号（不着色）
// - binary ：文件信息卡（名称/大小/类型/时间）+ 下载/打开
//
// 体积保护：按 ARTIFACT_SIZE_LIMITS 截断或提示。
// 图片/PDF 通过 IPC artifact:read-file 读取本地文件生成 dataUrl/blobUrl。
// ============================================================

import React, { useMemo, useState, useEffect, useRef } from 'react'
import {
  useTaskWorkspace, type ArtifactItem, type ArtifactKind,
  detectArtifactKind, isTextArtifact, ARTIFACT_SIZE_LIMITS,
} from '../stores/taskWorkspaceStore'

const MAX_LINES = 1000
const MAX_CSV_ROWS = 100

/** 简单关键字着色：把代码按 token 拆分，关键字/字符串/注释/数字上色 */
function highlightCode(code: string): string {
  let html = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const commentSlots: string[] = []
  html = html.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    commentSlots.push(m)
    return `\u000C${commentSlots.length - 1}\u000C`
  })
  html = html.replace(/\/\/[^\n]*/g, (m) => {
    commentSlots.push(m)
    return `\u000C${commentSlots.length - 1}\u000C`
  })
  const keywords = /\b(const|let|var|function|return|if|else|for|while|import|from|export|default|async|await|new|class|extends|try|catch|throw|typeof|interface|type|enum|public|private|static|def|print|None|True|False|self|this|null|undefined)\b/g
  html = html.replace(keywords, '<span class="tw-tok-keyword">$1</span>')
  html = html.replace(/(&quot;|'|"|`)[^"'`]*\1/g, '<span class="tw-tok-string">$&</span>')
  html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tw-tok-number">$1</span>')
  html = html.replace(/\u000C(\d+)\u000C/g, (_m, idx) => {
    return `<span class="tw-tok-comment">${commentSlots[Number(idx)]}</span>`
  })
  return html
}

/** 极简 Markdown 渲染：标题、有序/无序列表、引用、代码块、加粗、表格、换行 */
function renderMarkdown(md: string): string {
  // 1) 先抽出 fenced code block，避免内部 | # 等被误解析
  const codeBlocks: string[] = []
  let src = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, body) => {
    codeBlocks.push(body)
    return `\u000C${codeBlocks.length - 1}\u000C`
  })

  const lines = src.split('\n')
  const out: string[] = []
  let inTable = false
  let tableHeader = false

  const flushTable = () => { inTable = false; tableHeader = false }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 表格行：含至少一个 |
    if (trimmed.includes('|')) {
      // 分隔行 |---|---| 跳过（不作为数据行）
      const isSep = /^\s*\|?\s*:?-{2,}/.test(trimmed) && /\|/.test(trimmed)
      const cells = trimmed.split('|').map((c) => c.trim()).filter((_, idx, arr) =>
        // 去掉首尾因首尾 | 产生的空串
        !(idx === 0 && arr[0] === '') && !(idx === arr.length - 1 && arr[arr.length - 1] === ''),
      )
      if (!inTable) { out.push('<table class="tw-md-table">'); inTable = true; tableHeader = true }
      if (isSep) continue
      const tag = tableHeader ? 'th' : 'td'
      out.push('<tr>' + cells.map((c) => `<${tag}>${inlineMd(c)}</${tag}>`).join('') + '</tr>')
      tableHeader = false
      continue
    } else if (inTable) {
      out.push('</table>')
      flushTable()
    }

    // 标题
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const size = level <= 2 ? 15 : level === 3 ? 13 : 12
      out.push(`<div style="font-weight:700;font-size:${size}px;margin:8px 0 3px">${inlineMd(h[2])}</div>`)
      continue
    }
    // 引用块
    if (/^>\s?/.test(trimmed)) {
      out.push(`<div style="border-left:3px solid var(--border-light);padding-left:10px;margin:4px 0;color:var(--text-secondary)">${inlineMd(trimmed.replace(/^>\s?/, ''))}</div>`)
      continue
    }
    // 无序列表
    const ul = trimmed.match(/^[-*]\s+(.*)$/)
    if (ul) {
      out.push(`<div style="padding-left:14px">• ${inlineMd(ul[1])}</div>`)
      continue
    }
    // 有序列表
    const ol = trimmed.match(/^\d+\.\s+(.*)$/)
    if (ol) {
      out.push(`<div style="padding-left:14px">${trimmed.match(/^\d+/)![0]}. ${inlineMd(ol[1])}</div>`)
      continue
    }
    // 空行
    if (trimmed === '') { out.push('<div style="height:6px"></div>'); continue }
    out.push(`<div>${inlineMd(trimmed)}</div>`)
  }
  if (inTable) out.push('</table>')

  let html = out.join('\n')
  // 还原代码块
  html = html.replace(/\u000C(\d+)\u000C/g, (_m, idx) => {
    return `<pre style="background:var(--surface-100);padding:8px;border-radius:6px;overflow:auto"><code>${codeBlocks[Number(idx)]}</code></pre>`
  })
  return html
}

/** Markdown 行内格式：加粗 + 行内代码 */
function inlineMd(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code style="background:var(--surface-100);padding:1px 4px;border-radius:3px">$1</code>')
}

/** 转义 HTML 字符串（JSON/CSV 单元格安全） */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 格式化文件大小 */
function formatSize(bytes?: number): string {
  if (bytes == null) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 解析 CSV/TSV 为二维数组，带引号处理 */
function parseCsv(content: string, delimiter?: string): string[][] {
  const delim = delimiter || (content.includes('\t') && !content.includes(',') ? '\t' : ',')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      row.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

/** 高亮 JSON（简单正则：键/字符串/数字/布尔/null） */
function highlightJson(json: string): string {
  let html = escapeHtml(json)
  // 键
  html = html.replace(/&quot;([^&]+?)&quot;(\s*:)/g, '<span class="tw-tok-string">&quot;$1&quot;</span>$2')
  // 字符串值
  html = html.replace(/:\s*&quot;([^&]*?)&quot;/g, ': <span class="tw-tok-string">&quot;$1&quot;</span>')
  // 数字
  html = html.replace(/\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, '<span class="tw-tok-number">$1</span>')
  // 布尔/null
  html = html.replace(/\b(true|false|null)\b/g, '<span class="tw-tok-keyword">$1</span>')
  return html
}

const ArtifactViewer: React.FC = () => {
  const artifacts = useTaskWorkspace((s) => s.artifacts)
  const activeArtifactId = useTaskWorkspace((s) => s.activeArtifactId)
  const setActiveArtifact = useTaskWorkspace((s) => s.setActiveArtifact)
  const closeArtifact = useTaskWorkspace((s) => s.closeArtifact)
  const activeTaskId = useTaskWorkspace((s) => s.activeTaskId)
  const collapsedSections = useTaskWorkspace((s) => s.collapsedSections)
  const toggleSection = useTaskWorkspace((s) => s.toggleSection)
  const [copied, setCopied] = useState(false)

  // 仅显示当前任务的产物；无 activeTaskId 时显示全部
  const scopedArtifacts = useMemo(() => {
    if (!activeTaskId || activeTaskId === '__runtime__') return artifacts
    return artifacts.filter((a) => a.taskId === activeTaskId)
  }, [artifacts, activeTaskId])

  const active: ArtifactItem | undefined = useMemo(
    () => scopedArtifacts.find((a) => a.id === activeArtifactId) || scopedArtifacts[0],
    [scopedArtifacts, activeArtifactId],
  )

  // 图片/PDF：通过 IPC 读取本地文件生成 dataUrl/blobUrl
  const [remoteDataUrl, setRemoteDataUrl] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error' | 'done'>('idle')
  const blobUrlRef = useRef<string | null>(null)

  const kind: ArtifactKind = useMemo(() => {
    if (active?.kind) return active.kind
    return detectArtifactKind(active?.filename || '', active?.content)
  }, [active])

  // 需要远程读取的类型：image/pdf（只有 filePath 没有 dataUrl 时）
  const needsRemote =
    (kind === 'image' || kind === 'pdf') &&
    !!active?.filePath &&
    !active?.dataUrl &&
    !remoteDataUrl

  useEffect(() => {
    if (!needsRemote || !active?.filePath) return
    let cancelled = false
    setLoadState('loading')
    window.luminaAPI?.artifactReadFile(active.filePath)
      .then((res) => {
        if (cancelled) return
        if (res?.ok && res.dataUrl) {
          setRemoteDataUrl(res.dataUrl)
          setLoadState('done')
        } else {
          setLoadState('error')
        }
      })
      .catch(() => { if (!cancelled) setLoadState('error') })
    return () => { cancelled = true }
  }, [needsRemote, active?.filePath])

  // PDF blobUrl 生命周期：用后释放，组件卸载清理
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [])

  if (scopedArtifacts.length === 0 || !active) {
    return null
  }

  const effectiveDataUrl = active.dataUrl || remoteDataUrl

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(active.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* 剪贴板不可用时静默 */ }
  }

  const handleDownload = async () => {
    try {
      await window.luminaAPI?.artifactSave({ filename: active.filename, content: active.content })
    } catch { /* 用户取消或失败 */ }
  }

  const handleOpenFolder = async () => {
    if (!active.filePath) {
      try {
        const res = await window.luminaAPI?.artifactSave({ filename: active.filename, content: active.content })
        if (res?.filePath) {
          await window.luminaAPI?.artifactOpenInFolder(res.filePath)
        }
      } catch { /* 忽略 */ }
      return
    }
    try {
      await window.luminaAPI?.artifactOpenInFolder(active.filePath)
    } catch { /* 忽略 */ }
  }

  const handleOpenExternal = async () => {
    if (!active.filePath) return
    try {
      await window.luminaAPI?.artifactOpenExternal(active.filePath)
    } catch { /* 忽略 */ }
  }

  // ── 渲染各类型 ──
  const sizeLimit = ARTIFACT_SIZE_LIMITS[kind]
  const effectiveSize = active.size ?? active.content.length
  const tooLarge = effectiveSize > sizeLimit && sizeLimit !== Infinity

  const renderBody = () => {
    switch (kind) {
      case 'image': {
        if (loadState === 'loading') return <div className="tw-artifact-placeholder">加载图片中…</div>
        if (loadState === 'error') return <div className="tw-artifact-error">图片读取失败 <button className="tw-artifact-btn" onClick={() => setLoadState('idle')}>重试</button></div>
        if (!effectiveDataUrl) return <div className="tw-artifact-placeholder">无图片数据</div>
        if (tooLarge) return <div className="tw-artifact-note">图片过大（{formatSize(effectiveSize)}），请下载到本地查看</div>
        return (
          <div className="tw-image-view">
            <img
              src={effectiveDataUrl}
              alt={active.filename}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              onError={() => setLoadState('error')}
            />
          </div>
        )
      }
      case 'pdf': {
        if (loadState === 'loading') return <div className="tw-artifact-placeholder">加载 PDF 中…</div>
        if (loadState === 'error') return <div className="tw-artifact-error">PDF 读取失败 <button className="tw-artifact-btn" onClick={() => setLoadState('idle')}>重试</button></div>
        if (!effectiveDataUrl) return <div className="tw-artifact-placeholder">无 PDF 数据</div>
        if (tooLarge) return <div className="tw-artifact-note">PDF 过大（{formatSize(effectiveSize)}），请在系统中打开查看</div>
        return (
          <div className="tw-pdf-view">
            <iframe src={effectiveDataUrl} style={{ width: '100%', height: '100%', border: 'none' }} title={active.filename} />
            {active.filePath && (
              <div className="tw-pdf-fallback">
                <button className="tw-artifact-btn" onClick={handleOpenExternal}>在系统中打开 PDF</button>
              </div>
            )}
          </div>
        )
      }
      case 'json': {
        let pretty = active.content
        try {
          pretty = JSON.stringify(JSON.parse(active.content), null, 2)
        } catch { /* 非法 JSON，原样展示 */ }
        const lines = tooLarge ? pretty.split('\n').slice(0, MAX_LINES) : pretty.split('\n')
        return (
          <div className="tw-code">
            <div className="tw-code-lines">{lines.map((_, i) => <div key={i}>{i + 1}</div>)}</div>
            <div className="tw-code-body" dangerouslySetInnerHTML={{ __html: highlightJson(lines.join('\n')) }} />
          </div>
        )
      }
      case 'csv': {
        const rows = parseCsv(active.content)
        const displayRows = tooLarge ? rows.slice(0, MAX_CSV_ROWS) : rows
        const header = displayRows[0] || []
        const bodyRows = displayRows.slice(1)
        return (
          <div className="tw-csv-scroll">
            <table className="tw-csv-table">
              <thead>
                <tr>{header.map((c, i) => <th key={i}>{escapeHtml(c)}</th>)}</tr>
              </thead>
              <tbody>
                {bodyRows.map((row, ri) => (
                  <tr key={ri} className={ri % 2 === 0 ? 'even' : 'odd'}>
                    {row.map((c, ci) => <td key={ci}>{escapeHtml(c)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {tooLarge && <div className="tw-artifact-note">CSV 行数过多，仅显示前 {MAX_CSV_ROWS} 行</div>}
          </div>
        )
      }
      case 'markdown': {
        return (
          <div className="tw-code-scroll">
            <div className="tw-md-view" dangerouslySetInnerHTML={{ __html: renderMarkdown(active.content) }} />
          </div>
        )
      }
      case 'text': {
        const lines = tooLarge ? active.content.split('\n').slice(0, MAX_LINES) : active.content.split('\n')
        return (
          <div className="tw-code">
            <div className="tw-code-lines">{lines.map((_, i) => <div key={i}>{i + 1}</div>)}</div>
            <div className="tw-code-body" style={{ whiteSpace: 'pre-wrap' }}>{lines.join('\n')}</div>
          </div>
        )
      }
      case 'code': {
        const lines = tooLarge ? active.content.split('\n').slice(0, MAX_LINES) : active.content.split('\n')
        return (
          <div className="tw-code">
            <div className="tw-code-lines">{lines.map((_, i) => <div key={i}>{i + 1}</div>)}</div>
            <div className="tw-code-body" dangerouslySetInnerHTML={{ __html: highlightCode(lines.join('\n')) }} />
          </div>
        )
      }
      case 'binary':
      default: {
        return (
          <div className="tw-binary-info">
            <div className="tw-binary-icon">📦</div>
            <div className="tw-binary-name">{active.filename}</div>
            <div className="tw-binary-meta">类型：{kind} · 大小：{formatSize(effectiveSize)}</div>
            {active.mtime != null && (
              <div className="tw-binary-meta">修改时间：{new Date(active.mtime).toLocaleString()}</div>
            )}
            <div className="tw-binary-actions">
              {active.filePath && <button className="tw-artifact-btn" onClick={handleOpenExternal}>系统中打开</button>}
              <button className="tw-artifact-btn" onClick={handleDownload}>下载</button>
            </div>
          </div>
        )
      }
    }
  }

  const artifactsCollapsed = collapsedSections.artifacts

  return (
    <div className="tw-artifact-view">
      {/* 产物标签页栏 */}
      <div className="tw-artifact-tabs">
        {scopedArtifacts.map((a) => (
          <div
            key={a.id}
            className={`tw-artifact-tab ${a.id === active.id ? 'active' : ''}`}
            onClick={() => setActiveArtifact(a.id)}
          >
            <span>📄 {a.filename}</span>
            <span className="tw-lang-badge">{a.language}</span>
            <span
              style={{ marginLeft: 2, cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); closeArtifact(a.id) }}
            >✕</span>
          </div>
        ))}
        <span
          className={`tw-section-title tw-section-toggleable tw-artifact-collapse`}
          onClick={() => toggleSection('artifacts')}
          title={artifactsCollapsed ? '展开' : '折叠'}
        >
          <span className={`tw-chevron ${artifactsCollapsed ? 'collapsed' : ''}`}>▾</span>
        </span>
      </div>

      {!artifactsCollapsed && (
        <>
          {/* 工具栏 */}
          <div className="tw-artifact-toolbar">
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1 }}>
              {active.filename} · {kind}
            </span>
            {isTextArtifact(kind) && (
              <button className="tw-artifact-btn" onClick={handleCopy}>
                {copied ? '已复制 ✓' : '复制'}
              </button>
            )}
            <button className="tw-artifact-btn" onClick={handleDownload}>下载</button>
            <button className="tw-artifact-btn" onClick={handleOpenFolder}>打开文件夹</button>
          </div>

          {/* 渲染区 */}
          <div className="tw-code-scroll">
            {renderBody()}
          </div>

          {tooLarge && (kind === 'code' || kind === 'text' || kind === 'json') && (
            <div className="tw-truncated-note">
              文件过大（{formatSize(effectiveSize)}），仅显示前 {MAX_LINES} 行，已截断
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default ArtifactViewer
