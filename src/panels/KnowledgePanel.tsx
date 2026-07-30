// ============================================================
// KnowledgePanel.tsx — Lumina 知识库面板 (v3.9)
//
// 功能:
//   - 拖入文件自动导入
//   - 粘贴 URL 抓取内容
//   - 手写笔记
//   - 语义搜索
//   - RAG 对话增强
// 记忆运维 Tab（统计/重建/清空）
// ============================================================

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { showToast } from '../components/Toast'

interface KBDoc {
  id: string
  title: string
  sourceType: 'file' | 'url' | 'note'
  tags: string[]
  createdAt: number
  size: number
}

interface KBSearchResult {
  docId: string
  chunkId: string
  title: string
  content: string
  score: number
  source: string
}

interface KBStats {
  totalDocs: number
  totalChunks: number
  totalSize: number
  lastIndexed: number | null
}

export default function KnowledgePanel() {
  const [docs, setDocs] = useState<KBDoc[]>([])
  const [stats, setStats] = useState<KBStats>({ totalDocs: 0, totalChunks: 0, totalSize: 0, lastIndexed: null })
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KBSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [activeTab, setActiveTab] = useState<'library' | 'search' | 'add' | 'memory'>('library')
  const [noteTitle, setNoteTitle] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [importUrl, setImportUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null)
  const [expandedDocContent, setExpandedDocContent] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)
  // 记忆运维
  const [memStats, setMemStats] = useState<any>(null)
  const [reindexing, setReindexing] = useState(false)

  const api = useMemo(() => (window as any).luminaAPI as { invoke: (channel: string, ...args: any[]) => Promise<any> }, [])

  // 加载列表
  const loadDocs = useCallback(async () => {
    try {
      const [docsList, statsData] = await Promise.all([
        api ? api.invoke('kb:list') : Promise.resolve([]),
        api ? api.invoke('kb:stats') : Promise.resolve({ totalDocs: 0, totalChunks: 0, totalSize: 0, lastIndexed: null }),
      ])
      setDocs(docsList || [])
      setStats(statsData)
    } catch (e) {
      console.error('KB load error:', e)
    }
  }, [api])

  useEffect(() => { loadDocs() }, [loadDocs])

  // 加载记忆统计
  const loadMemStats = useCallback(async () => {
    try {
      const data = await api.invoke('memory:stats')
      setMemStats(data)
    } catch { /* 知识库可能没有记忆模块 */ }
  }, [api])

  useEffect(() => { if (activeTab === 'memory') loadMemStats() }, [activeTab, loadMemStats])

  // 搜索
  const doSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults([])
      return
    }
    setSearching(true)
    try {
      const results = await api.invoke('kb:search', searchQuery, 10)
      setSearchResults(results || [])
    } catch (e) {
      console.error('KB search error:', e)
      showToast('搜索失败', 'error')
    } finally {
      setSearching(false)
    }
  }, [searchQuery, api])

  // 文件导入
  const importFile = useCallback(async (filePath: string) => {
    setImporting(true)
    try {
      const result = await api.invoke('kb:import-file', filePath)
      if (result.ok) {
        showToast(`✅ 已导入: ${result.doc.title}`, 'success')
        loadDocs()
      } else {
        showToast(`导入失败: ${result.error}`, 'error')
      }
    } catch (e: any) {
      showToast(`导入失败: ${e.message}`, 'error')
    } finally {
      setImporting(false)
    }
  }, [api, loadDocs])

  // 拖拽
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer.files
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      // 通过 preload 暴露的文件路径
      if ((f as any).path) {
        await importFile((f as any).path)
      }
    }
  }, [importFile])

  // URL 导入
  const handleUrlImport = async () => {
    if (!importUrl.trim()) return
    setImporting(true)
    try {
      const result = await api.invoke('kb:import-url', importUrl, importUrl, `[从URL导入: ${importUrl}]`)
      if (result.ok) {
        showToast(`✅ URL已导入`, 'success')
        setImportUrl('')
        loadDocs()
      }
    } catch (e: any) {
      showToast(`导入失败: ${e.message}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  // 笔记保存
  const saveNote = async () => {
    if (!noteTitle.trim() || !noteContent.trim()) return
    setImporting(true)
    try {
      const result = await api.invoke('kb:create-note', noteTitle, noteContent)
      if (result.ok) {
        showToast('✅ 笔记已保存', 'success')
        setNoteTitle('')
        setNoteContent('')
        loadDocs()
      }
    } catch (e: any) {
      showToast(`保存失败: ${e.message}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  // 删除
  const deleteDoc = async (id: string, title: string) => {
    if (!confirm(`确定删除「${title}」？`)) return
    try {
      await api.invoke('kb:delete-doc', id)
      showToast('已删除', 'success')
      loadDocs()
    } catch (e: any) {
      showToast('删除失败', 'error')
    }
  }

  // 展开查看
  const toggleExpand = async (docId: string) => {
    if (expandedDoc === docId) {
      setExpandedDoc(null)
      setExpandedDocContent('')
      return
    }
    try {
      const doc = await api.invoke('kb:get-doc', docId)
      if (doc) {
        setExpandedDoc(docId)
        setExpandedDocContent(doc.content.slice(0, 3000))
      }
    } catch { /* ignore */ }
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / 1048576).toFixed(1)}MB`
  }

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const typeIcon: Record<string, string> = { file: '📄', url: '🔗', note: '📝' }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--surface-0)' }}>
      {/* 顶部统计 */}
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
        background: 'var(--surface-0)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>🧠 知识库</h3>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
            {stats.totalDocs}篇 · {stats.totalChunks}块 · {formatSize(stats.totalSize)}
          </span>
        </div>
        {/* 标签切换 */}
        <div style={{ display: 'flex', gap: 4 }}>
          {([
            { key: 'library', icon: '📚', label: '文库' },
            { key: 'search', icon: '🔍', label: '搜索' },
            { key: 'add', icon: '➕', label: '添加' },
            { key: 'memory', icon: '🧹', label: '运维' },
          ] as const).map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              style={{
                flex: 1, padding: '5px 0', borderRadius: 6, border: 'none',
                fontSize: 11, fontWeight: activeTab === tab.key ? 600 : 400,
                background: activeTab === tab.key ? '#eff6ff' : 'transparent',
                color: activeTab === tab.key ? '#3b82f6' : 'var(--text-secondary)',
                cursor: 'pointer', transition: 'all 0.15s',
              }}>
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* 内容区 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        
        {/* ── 文库 Tab ── */}
        {activeTab === 'library' && (
          <div
            ref={dropRef}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            style={{
              minHeight: 120,
              borderRadius: 10,
              border: `2px dashed ${dragOver ? '#3b82f6' : 'var(--border-light)'}`,
              background: dragOver ? '#eff6ff' : 'var(--surface-0)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: 8, transition: 'all 0.2s',
            }}>
            <div style={{ textAlign: 'center', color: dragOver ? '#3b82f6' : 'var(--text-secondary)', fontSize: 11 }}>
              <div style={{ fontSize: 24, marginBottom: 4 }}>📁</div>
              {dragOver ? '松开即可导入' : '拖拽文件到此处导入'}
              <div style={{ fontSize: 9, marginTop: 2 }}>
                .md .txt .json .html .csv .py .ts .js ...
              </div>
            </div>
          </div>
        )}

        {/* ── 搜索 Tab ── */}
        {activeTab === 'search' && (
          <div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doSearch()}
                placeholder="搜索你的知识库..."
                style={{
                  flex: 1, padding: '6px 10px', borderRadius: 6,
                  border: '1px solid #d1d5db', fontSize: 12, boxSizing: 'border-box',
                }}
              />
              <button onClick={doSearch} disabled={searching || !searchQuery.trim()}
                style={{
                  padding: '6px 12px', borderRadius: 6, border: 'none',
                  background: searchQuery.trim() ? '#3b82f6' : 'var(--border-light)',
                  color: '#fff', fontSize: 11, cursor: searchQuery.trim() ? 'pointer' : 'default',
                }}>
                {searching ? '...' : '搜索'}
              </button>
            </div>
            {searchResults.length === 0 && searchQuery && !searching && (
              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12, padding: 20 }}>
                未找到相关内容
              </div>
            )}
            {searchResults.map((r, i) => (
              <div key={`${r.chunkId}-${i}`} style={{
                padding: '8px 10px', marginBottom: 6, borderRadius: 8,
                background: 'var(--surface-0)', border: '1px solid var(--border-light)',
                cursor: 'pointer',
              }} onClick={() => toggleExpand(r.docId)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>{r.title}</span>
                  <span style={{ fontSize: 9, color: '#3b82f6', background: 'var(--accent-50)', padding: '1px 6px', borderRadius: 4 }}>
                    {(r.score * 100).toFixed(0)}%
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{r.content}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── 添加 Tab ── */}
        {activeTab === 'add' && (
          <div>
            {/* 文件选择 */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>📄 从文件导入</div>
              <input ref={fileInputRef} type="file" multiple
                onChange={async e => {
                  const files = e.target.files
                  if (files) {
                    for (let i = 0; i < files.length; i++) {
                      if ((files[i] as any).path) {
                        await importFile((files[i] as any).path)
                      }
                    }
                  }
                  e.target.value = ''
                }}
                style={{ display: 'none' }}
              />
              <button onClick={() => fileInputRef.current?.click()}
                style={{
                  width: '100%', padding: '8px', borderRadius: 8,
                  border: '1px dashed #d1d5db', background: 'var(--surface-0)',
                  fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer',
                }}>
                点击选择文件...
              </button>
            </div>

            {/* URL 导入 */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>🔗 从 URL 导入</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <input
                  value={importUrl}
                  onChange={e => setImportUrl(e.target.value)}
                  placeholder="https://..."
                  style={{
                    flex: 1, padding: '6px 10px', borderRadius: 6,
                    border: '1px solid #d1d5db', fontSize: 12, boxSizing: 'border-box',
                  }}
                />
                <button onClick={handleUrlImport} disabled={importing || !importUrl.trim()}
                  style={{
                    padding: '6px 12px', borderRadius: 6, border: 'none',
                    background: importUrl.trim() ? '#3b82f6' : 'var(--border-light)',
                    color: '#fff', fontSize: 11, cursor: importUrl.trim() ? 'pointer' : 'default',
                  }}>
                  导入
                </button>
              </div>
            </div>

            {/* 手写笔记 */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>📝 手写笔记</div>
              <input
                value={noteTitle}
                onChange={e => setNoteTitle(e.target.value)}
                placeholder="笔记标题"
                style={{
                  width: '100%', padding: '6px 10px', borderRadius: 6,
                  border: '1px solid #d1d5db', fontSize: 12, marginBottom: 6, boxSizing: 'border-box',
                }}
              />
              <textarea
                value={noteContent}
                onChange={e => setNoteContent(e.target.value)}
                placeholder="笔记内容..."
                rows={6}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 6,
                  border: '1px solid #d1d5db', fontSize: 12, resize: 'vertical',
                  fontFamily: 'inherit', boxSizing: 'border-box',
                }}
              />
              <button onClick={saveNote} disabled={importing || !noteTitle.trim() || !noteContent.trim()}
                style={{
                  marginTop: 6, width: '100%', padding: '8px', borderRadius: 8, border: 'none',
                  background: (noteTitle.trim() && noteContent.trim()) ? '#3b82f6' : 'var(--border-light)',
                  color: '#fff', fontSize: 12, cursor: (noteTitle.trim() && noteContent.trim()) ? 'pointer' : 'default',
                }}>
                {importing ? '保存中...' : '💾 保存笔记'}
              </button>
            </div>
          </div>
        )}

        {/* ── 🆕 v8.1 记忆运维 Tab ── */}
        {activeTab === 'memory' && (
          <div style={{ fontSize: 12 }}>
            {/* 操作按钮组 */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button onClick={async () => {
                setReindexing(true)
                try {
                  const result = await api.invoke('memory:reindex')
                  if (result.ok) {
                    showToast(`✅ 重建完成: ${result.indexed} 条向量`, 'success')
                    loadMemStats()
                  }
                } catch (e: any) {
                  showToast(`重建失败: ${e.message}`, 'error')
                } finally { setReindexing(false) }
              }} disabled={reindexing}
                style={{
                  flex: 1, padding: '8px', borderRadius: 8, border: 'none',
                  background: reindexing ? '#d1d5db' : '#3b82f6',
                  color: '#fff', fontSize: 11, cursor: reindexing ? 'default' : 'pointer',
                }}>
                {reindexing ? '重建中...' : '🔄 重建向量索引'}
              </button>
              <button onClick={async () => {
                if (!confirm('确定清空所有事实记忆？此操作不可撤销。')) return
                try {
                  const result = await api.invoke('memory:clear-category', 'facts')
                  if (result.ok) showToast('✅ 已清空事实记忆', 'success')
                  else showToast(result.error || '清空失败', 'error')
                } catch (e: any) { showToast(`清空失败: ${e.message}`, 'error') }
              }}
                style={{
                  flex: 1, padding: '8px', borderRadius: 8, border: 'none',
                  background: '#ef4444', color: '#fff', fontSize: 11, cursor: 'pointer',
                }}>
                🗑️ 清空事实
              </button>
            </div>

            {/* 统计信息 */}
            {memStats ? (
              <div style={{
                background: 'var(--surface-100)', borderRadius: 10,
                padding: '12px', border: '1px solid var(--border-light)',
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                  📊 记忆统计
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
                  {[
                    { label: '🧠 事实记忆', value: memStats.totalFacts },
                    { label: '💭 反思记录', value: memStats.totalReflections },
                    { label: '❤️ 用户偏好', value: memStats.totalPreferences },
                    { label: '🔄 用户习惯', value: memStats.totalHabits },
                    { label: '📖 经验教训', value: memStats.totalLessons },
                    { label: '📐 项目约定', value: memStats.totalConventions },
                  ].map(item => (
                    <div key={item.label} style={{
                      display: 'flex', justifyContent: 'space-between', padding: '4px 0',
                      borderBottom: '1px solid var(--border-light)',
                    }}>
                      <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{item.label}</span>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 11 }}>{item.value}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-secondary)' }}>
                    <span>向量库: {memStats.vectorStoreSize} 条</span>
                    <span>嵌入模式: {memStats.embeddingMode || 'local'}</span>
                    <span>DB 大小: {(memStats.dbSize / 1024).toFixed(1)}KB</span>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 11, padding: 24 }}>
                ⏳ 加载记忆统计中...
              </div>
            )}
          </div>
        )}
      </div> {/* /内容区 */}

      {/* 文档列表（文库 Tab） */}
      {activeTab === 'library' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 8px' }}>
          {docs.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12, padding: 24 }}>
              📭 知识库为空，拖入文件或添加笔记开始
            </div>
          ) : (
            docs.map(doc => (
              <div key={doc.id}>
                <div style={{
                  padding: '8px 10px', marginBottom: 4, borderRadius: 8,
                  background: 'var(--surface-0)', border: '1px solid var(--border-light)',
                  display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                }} onClick={() => toggleExpand(doc.id)}>
                  <span style={{ fontSize: 16 }}>{typeIcon[doc.sourceType]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {doc.title}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-secondary)' }}>
                      {formatDate(doc.createdAt)} · {formatSize(doc.size)}
                      {doc.tags.length > 0 && (
                        <span style={{ marginLeft: 4 }}>
                          {doc.tags.slice(0, 3).map(t => (
                            <span key={t} style={{
                              marginRight: 2, padding: '0 4px', borderRadius: 3,
                              background: 'var(--border-light)', color: 'var(--text-secondary)', fontSize: 8,
                            }}>{t}</span>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                  <button onClick={e => { e.stopPropagation(); deleteDoc(doc.id, doc.title) }}
                    style={{
                      border: 'none', background: 'none', color: '#ef4444',
                      fontSize: 14, cursor: 'pointer', padding: '2px 4px', borderRadius: 4,
                    }} title="删除">
                    🗑️
                  </button>
                </div>
                {/* 展开内容 */}
                {expandedDoc === doc.id && (
                  <div style={{
                    marginLeft: 24, marginBottom: 8, padding: '8px 10px',
                    borderRadius: 6, background: 'var(--surface-100)', border: '1px solid var(--border-light)',
                    fontSize: 11, lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word', maxHeight: 300, overflowY: 'auto',
                  }}>
                    {expandedDocContent || '（内容为空）'}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
