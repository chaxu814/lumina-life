// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import React, { useState, useEffect, useCallback } from 'react'
import { IconCheck, IconTrash, IconMail } from '../components/Icons'

interface Mail {
  id: string
  subject: string
  body: string
  priority: string  // 🔧 IPC 返回值为运行时 string，不做字面量约束
  read: boolean
  createdAt: number
  readAt?: number
  deletedAt?: number  // v2.8: 归档时间（归档视图用）
}

type FilterMode = 'all' | 'unread' | 'important' | 'archive'

/* ── 邮件正文渲染 ──
 *
 * 之前直接 `{mail.body}` 填进 pre-wrap 容器，于是 `**加粗**`、`## 标题`、
 * `📎 https://...` 这些标记原封不动糊在屏幕上（用户报的“只发网站”的一半原因）。
 *
 * 这里只渲染一小撮安全的 Markdown 子集，输出 React 元素而不是 HTML 字符串：
 * 正文可能来自 LLM（新闻简报），用 dangerouslySetInnerHTML 等于把注入面打开。
 */
const BOLD_RE = /\*\*([^*]+)\*\*|__([^_]+)__/g
const EM_RE = /(^|[\s(])_([^_]+)_/g

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []

  // 1) 先切加粗（两个分支组：**[x]** / __[x]__）
  const segments: Array<{ text: string; strong: boolean }> = []
  let rest = text
  let guard = 0
  while (rest && guard++ < 200) {
    BOLD_RE.lastIndex = 0
    const m = BOLD_RE.exec(rest)
    if (!m) { segments.push({ text: rest, strong: false }); break }
    if (m.index > 0) { segments.push({ text: rest.slice(0, m.index), strong: false }) }
    segments.push({ text: m[1] ?? m[2] ?? '', strong: true })
    rest = rest.slice(m.index + m[0].length)
  }

  // 2) 再在非加粗片段里处理 _斜体_ / *斜体*
  segments.forEach((seg, si) => {
    if (seg.strong) {
      if (seg.text) { out.push(<strong key={`${keyBase}-b${si}`}>{seg.text}</strong>) }
      return
    }
    seg.text.split(EM_RE).forEach((p, pi) => {
      if (pi % 3 === 2) { out.push(<em key={`${keyBase}-i${si}-${pi}`}>{p}</em>) }
      else if (p) { out.push(p) }
    })
  })

  return out
}

function MailBody({ body }: { body: string }) {
  const lines = (body || '').split('\n')

  return (
    <div>
      {lines.map((raw, i) => {
        const line = raw.replace(/\s+$/, '')
        if (!line.trim()) { return <div key={i} style={{ height: 8 }} /> }

        // 分隔线
        if (/^---+$/.test(line.trim())) {
          return <hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border-light)', margin: '12px 0' }} />
        }
        // 标题
        const h = /^(#{1,3})\s+(.*)$/.exec(line)
        if (h) {
          const size = [16, 14.5, 13.5][h[1].length - 1]
          return (
            <div key={i} style={{
              fontSize: size, fontWeight: 700, color: 'var(--text-primary)',
              margin: i === 0 ? '0 0 8px' : '12px 0 6px', lineHeight: 1.4,
            }}>
              {renderInline(h[2], `h${i}`)}
            </div>
          )
        }
        // 引用块（LLM 叙述里的「值得关注」）
        if (/^>\s?/.test(line)) {
          return (
            <div key={i} style={{
              margin: '8px 0', padding: '8px 12px', borderRadius: 6,
              borderLeft: '3px solid var(--accent-500)',
              background: 'var(--accent-50)', color: 'var(--text-primary)',
            }}>
              {renderInline(line.replace(/^>\s?/, ''), `q${i}`)}
            </div>
          )
        }
        // 链接：📎 https://… 或整行裸 URL
        const urlLine = /^(?:📎\s*)?(https?:\/\/\S+)$/.exec(line.trim())
        if (urlLine) {
          return (
            <div key={i} style={{ margin: '2px 0 8px' }}>
              <a href={urlLine[1]} target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--accent-primary)', fontSize: 12, wordBreak: 'break-all' }}>
                {line.trim().replace(/^📎\s*/, '')}
              </a>
            </div>
          )
        }
        // 页脚（📬 / 💡）——压暗压小，不跟正文抢注意力
        if (/^(📬|💡|📭)/.test(line.trim())) {
          return (
            <div key={i} style={{ fontSize: 11, color: 'var(--text-tertiary, var(--text-muted))', margin: '2px 0' }}>
              {renderInline(line, `f${i}`)}
            </div>
          )
        }
        return (
          <div key={i} style={{ margin: '2px 0', whiteSpace: 'pre-wrap' }}>
            {renderInline(line, `p${i}`)}
          </div>
        )
      })}
    </div>
  )
}

export default function MailPanel() {
  const [mails, setMails] = useState<Mail[]>([])
  const [archived, setArchived] = useState<Mail[]>([])
  const [unread, setUnread] = useState(0)
  const [total, setTotal] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterMode>('all')
  const [animatingIds, setAnimatingIds] = useState<Set<string>>(new Set()) // 新邮件入场动画

  const refresh = useCallback(async () => {
    try {
      const [result, archiveResult] = await Promise.all([
        window.luminaAPI.mailList('all'),
        window.luminaAPI.mailArchivedList(),
      ])
      // 检测新邮件（之前不存在的 ID）
      setMails(prev => {
        const prevIds = new Set(prev.map(m => m.id))
        const newIds = result.mails.filter((m: Mail) => !prevIds.has(m.id)).map((m: Mail) => m.id)
        if (newIds.length > 0) {
          setAnimatingIds(new Set(newIds))
          setTimeout(() => setAnimatingIds(new Set()), 800)
        }
        return result.mails
      })
      setArchived(archiveResult.mails)
      setUnread(result.unread)
      setTotal(result.total)
    } catch (err) {
      console.warn('[MailPanel] 加载失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const cleanup = window.luminaAPI.onMailChanged(() => refresh())
    return cleanup
  }, [refresh])

  const handleMarkRead = async (mailId: string) => {
    await window.luminaAPI.mailMarkRead(mailId)
    refresh()
  }

  const handleMarkAllRead = async () => {
    await window.luminaAPI.mailMarkRead('all')
    refresh()
  }

  const handleDelete = async (mailId: string) => {
    // v2.8: 删除=软删除（进归档），加确认防误触
    if (!window.confirm('确定删除这封邮件吗？可随时从「归档」中恢复。')) {return}
    await window.luminaAPI.mailDelete(mailId)
    if (expandedId === mailId) {setExpandedId(null)}
    refresh()
  }

  const handleDeleteAllRead = async () => {
    const readMails = mails.filter(m => m.read)
    if (readMails.length === 0) {return}
    const ok = window.confirm(
      `确定删除 ${readMails.length} 封已读邮件吗？\n\n删除的邮件会移入「归档」，可随时恢复。`
    )
    if (!ok) {return}
    for (const m of readMails) {
      await window.luminaAPI.mailDelete(m.id)
    }
    refresh()
  }

  const handleRestore = async (mailId: string) => {
    await window.luminaAPI.mailRestore(mailId)
    refresh()
  }

  const handlePurgeArchived = async (mailId: string) => {
    if (!window.confirm('确定永久删除这封归档邮件吗？此操作不可恢复。')) {return}
    await window.luminaAPI.mailPurgeArchived(mailId)
    refresh()
  }

  const toggleExpand = async (mail: Mail) => {
    setExpandedId(expandedId === mail.id ? null : mail.id)
    if (!mail.read) {
      await window.luminaAPI.mailMarkRead(mail.id)
      refresh()
    }
  }

  const filteredMails = mails.filter(m => {
    if (filter === 'unread') {return !m.read}
    if (filter === 'important') {return m.priority === 'important'}
    return true
  })

  const importantCount = mails.filter(m => m.priority === 'important').length
  const readCount = mails.filter(m => m.read).length

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)

    if (diffMin < 1) {return '刚刚'}
    if (diffMin < 60) {return `${diffMin} 分钟前`}
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (d.toDateString() === yesterday.toDateString()) {
      return '昨天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  return (
    <div className="panel">
      {/* ═══════════ 头部 ═══════════ */}
      <div className="panel-header">
        <div className="panel-title">📬 Agent 邮件</div>
        <div className="panel-subtitle" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {unread > 0
            ? <><span style={{ fontWeight: 700, color: 'var(--accent-500)' }}>{unread} 封未读</span><span style={{ color: 'var(--text-disabled)' }}>·</span><span>{total} 封总计</span></>
            : total > 0
            ? <span>{total} 封总计</span>
            : <span>Agent 的重要提醒和通知会出现在这里</span>}
        </div>
      </div>

      {/* ═══════════ 统计条 ═══════════ */}
      {total > 0 && (
        <div style={{
          display: 'flex', gap: 12, padding: '0 16px 6px', fontSize: 11,
          color: 'var(--text-tertiary)',
        }}>
          <span>📬 {total} 封</span>
          <span>📖 {readCount} 已读</span>
          <span>🔴 {importantCount} 重要</span>
        </div>
      )}

      {/* ═══════════ 操作栏 ═══════════ */}
      {total > 0 && (
        <div style={{
          padding: '0 16px 10px', display: 'flex', gap: 6, flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          {/* 筛选标签 */}
          <div style={{ display: 'flex', gap: 0, marginRight: 'auto' }}>
            {([
              { key: 'all' as FilterMode, label: '全部' },
              { key: 'unread' as FilterMode, label: `未读 ${unread}` },
              { key: 'important' as FilterMode, label: `重要 ${importantCount}` },
              { key: 'archive' as FilterMode, label: `🗄 归档 ${archived.length}` },
            ]).map(tab => (
              <button key={tab.key}
                onClick={() => setFilter(tab.key)}
                style={{
                  padding: '3px 10px', fontSize: 11, fontWeight: filter === tab.key ? 600 : 400,
                  border: `1px solid ${filter === tab.key ? 'var(--accent-400)' : 'var(--border-light)'}`,
                  background: filter === tab.key ? 'var(--accent-50)' : 'var(--surface-0)',
                  color: filter === tab.key ? 'var(--accent-600)' : 'var(--text-tertiary)',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
                onMouseEnter={e => {
                  if (filter !== tab.key) {
                    e.currentTarget.style.background = 'var(--surface-50)'
                    e.currentTarget.style.color = 'var(--text-secondary)'
                  }
                }}
                onMouseLeave={e => {
                  if (filter !== tab.key) {
                    e.currentTarget.style.background = 'var(--surface-0)'
                    e.currentTarget.style.color = 'var(--text-tertiary)'
                  }
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* 批量操作 */}
          {unread > 0 && (
            <button className="btn btn-ghost btn-xs" onClick={handleMarkAllRead}
              style={{ fontSize: 11 }}>
              <IconCheck size={11} /> 全部已读
            </button>
          )}
          {readCount > 0 && filter !== 'archive' && (
            <button className="btn btn-ghost btn-xs" onClick={handleDeleteAllRead}
              style={{ fontSize: 11, color: 'var(--danger-500)' }}
              title="删除所有已读邮件（移入归档，可恢复）">
              <IconTrash size={11} /> 删除已读
            </button>
          )}
        </div>
      )}

      {/* ═══════════ 邮件列表 ═══════════ */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
        {loading ? (
          <EmptyState icon="⏳" text="加载中…" />
        ) : filter === 'archive' ? (
          archived.length === 0 ? (
            <EmptyState icon="🗄" text="归档为空"
              hint="删除的邮件会移入这里，可随时恢复，不再丢失" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {archived.map((mail) => (
                <div key={mail.id}
                  style={{
                    background: 'var(--surface-0)',
                    border: '1px dashed var(--border-light)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '10px 14px',
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                  <span style={{ fontSize: 16, opacity: 0.5 }}>🗄</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 500,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {mail.subject}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      删除于 {formatTime(mail.deletedAt ?? mail.createdAt)}
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-xs"
                    onClick={() => handleRestore(mail.id)}
                    title="恢复到收件箱"
                    style={{ fontSize: 11, color: 'var(--accent-600)' }}>
                    恢复
                  </button>
                  <button className="btn btn-ghost btn-xs"
                    onClick={() => handlePurgeArchived(mail.id)}
                    title="永久删除（不可恢复）"
                    style={{ fontSize: 11, color: 'var(--text-disabled)' }}>
                    彻底删除
                  </button>
                </div>
              ))}
            </div>
          )
        ) : filteredMails.length === 0 ? (
          filter !== 'all' ? (
            <EmptyState icon="📭" text="没有匹配的邮件"
              hint={`当前筛选: ${filter === 'unread' ? '未读' : '重要'}`} />
          ) : (
            <EmptyState icon="📭" text="收件箱为空"
              hint="Agent 会在定时任务完成、发现重要信息时自动发送邮件。试试说「每天8点发邮件提醒我」" />
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filteredMails.map((mail) => {
              const isExpanded = expandedId === mail.id
              const isNew = animatingIds.has(mail.id)
              return (
                <div key={mail.id}
                  className={`mail-item ${isNew ? 'mail-item-new' : ''} ${isExpanded ? 'mail-item-expanded' : ''}`}
                  onClick={() => toggleExpand(mail)}
                  style={{
                    background: mail.read ? 'var(--surface-0)' : 'var(--accent-50)',
                    border: `1px solid ${mail.priority === 'important' && !mail.read
                      ? '#fca5a5'
                      : mail.read ? 'var(--border-light)' : 'var(--accent-200)'}`,
                    borderRadius: 'var(--radius-lg)',
                    cursor: 'pointer',
                    overflow: 'hidden',
                    transform: 'translateY(0)',
                    transition: 'all 0.25s ease, border-color 0.3s ease, box-shadow 0.25s ease',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)'
                    e.currentTarget.style.transform = 'translateY(-1px)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.boxShadow = 'none'
                    e.currentTarget.style.transform = 'translateY(0)'
                  }}
                >
                  {/* 邮件头部 */}
                  <div style={{
                    padding: '10px 14px',
                    display: 'flex', alignItems: 'center', gap: 10,
                    transition: 'background 0.2s ease',
                  }}>
                    {/* 图标区 */}
                    <span style={{
                      fontSize: 16, flexShrink: 0,
                      opacity: mail.read ? 0.4 : 1,
                      transition: 'opacity 0.3s ease, transform 0.3s ease',
                      transform: isExpanded ? 'rotate(15deg) scale(1.1)' : 'rotate(0deg) scale(1)',
                    }}>
                      {mail.priority === 'important' ? '🔴' : mail.read ? '📖' : '📬'}
                    </span>

                    {/* 标题 */}
                    <span style={{
                      fontWeight: mail.read ? 500 : 700,
                      fontSize: 13,
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      transition: 'color 0.3s ease',
                      color: mail.read ? 'var(--text-secondary)' : 'var(--text-primary)',
                    }}>
                      {mail.subject}
                    </span>

                    {/* 时间 */}
                    <span style={{
                      fontSize: 11,
                      color: 'var(--text-tertiary)',
                      whiteSpace: 'nowrap',
                    }}>
                      {formatTime(mail.createdAt)}
                    </span>

                    {/* 展开指示器 */}
                    <span style={{
                      fontSize: 10, color: 'var(--text-disabled)',
                      transition: 'transform 0.3s ease',
                      transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    }}>
                      ▼
                    </span>

                    {/* 删除按钮 */}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(mail.id) }}
                      title="删除"
                      style={{
                        background: 'none', border: 'none',
                        color: 'var(--text-disabled)', cursor: 'pointer',
                        padding: 2, opacity: 0.3,
                        transition: 'opacity 0.15s, color 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.opacity = '0.9'
                        e.currentTarget.style.color = 'var(--danger-500)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.opacity = '0.3'
                        e.currentTarget.style.color = 'var(--text-disabled)'
                      }}
                    >
                      <IconTrash size={13} />
                    </button>
                  </div>

                  {/* 邮件正文（带动画展开/收起） */}
                  <div className="mail-body-wrapper"
                    style={{
                      maxHeight: isExpanded ? 600 : 0,
                      opacity: isExpanded ? 1 : 0,
                      transition: 'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease, padding 0.35s ease',
                      padding: isExpanded ? '0 14px 14px' : '0 14px',
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{
                      borderTop: '1px solid var(--border-light)',
                      paddingTop: 10,
                      fontSize: 13,
                      lineHeight: 1.75,
                      color: 'var(--text-secondary)',
                      wordBreak: 'break-word',
                    }}>
                      <MailBody body={mail.body} />
                      {/* 邮件底部操作 */}
                      <div style={{
                        marginTop: 12, display: 'flex', gap: 8,
                        borderTop: '1px solid var(--border-light)',
                        paddingTop: 10,
                      }}>
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flex: 1 }}>
                          {mail.priority === 'important' ? '🔴 重要' : '📬 普通'} ·
                          {mail.readAt
                            ? ` 已读于 ${new Date(mail.readAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                            : ' 未读'}
                        </span>
                        <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); handleDelete(mail.id) }}
                          style={{ fontSize: 11 }}>
                          <IconTrash size={11} /> 删除
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ═══════════ CSS 动画注入 ═══════════ */}
      <style>{`
        @keyframes mailSlideIn {
          0%   { opacity: 0; transform: translateY(-12px) scale(0.96); }
          50%  { opacity: 0.8; transform: translateY(2px) scale(1.01); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        .mail-item-new {
          animation: mailSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
      `}</style>
    </div>
  )
}

/** 空状态占位 */
function EmptyState({ icon, text, hint }: { icon: string; text: string; hint?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 16px' }}>
      <div style={{
        fontSize: 48, marginBottom: 12, opacity: 0.4,
        animation: 'mailEmptyFloat 3s ease-in-out infinite',
      }}>
        {icon}
      </div>
      <div style={{ color: 'var(--text-tertiary)', fontSize: 13, marginBottom: 6, fontWeight: 500 }}>
        {text}
      </div>
      {hint && (
        <div style={{ color: 'var(--text-disabled)', fontSize: 11, lineHeight: 1.7, maxWidth: 280, margin: '0 auto' }}>
          {hint}
        </div>
      )}
      <style>{`
        @keyframes mailEmptyFloat {
          0%, 100% { transform: translateY(0); }
          50%  { transform: translateY(-6px); }
        }
      `}</style>
    </div>
  )
}
