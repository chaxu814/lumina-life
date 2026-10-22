// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// NoteCycle.tsx — 记录→整理→回顾 闭环组件
// 从 ToolboxPanel 提取，供 GroupChatView 复用
// ============================================================

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { showToast } from '../components/Toast'
import { isImeComposing } from '../lib/ime'
import { useStore } from '../stores/appStore'

// ═════════════════════════════════════════════════════════════
// 类型定义
// ═════════════════════════════════════════════════════════════

interface NoteEntry {
  id: string
  content: string
  category: string
  timestamp: string
  generated?: boolean
}

interface DailySummary {
  date: string
  content: string
  noteCount: number
  generated: boolean
}

type NoteTab = 'notes' | 'organize' | 'review' | 'daily' | 'milestone' | 'yak'

// ═════════════════════════════════════════════════════════════
// 工具函数
// ═════════════════════════════════════════════════════════════

const STORAGE_KEY = 'lumina_toolbox_notes'

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch { return fallback }
}

function saveToStorage<T>(key: string, data: T) {
  try { localStorage.setItem(key, JSON.stringify(data)) } catch {}
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function nowISO(): string {
  return new Date().toISOString()
}

// 简单自动分类
function guessCategory(text: string): string {
  const t = text.toLowerCase()
  if (/代码|bug|修复|函数|api|接口|部署|git|commit|pr|merge|npm|yarn|install|编译|构建/i.test(t)) {return '技术'}
  if (/会议|讨论|决策|需求|计划|排期|周报|日报|汇报|okr/i.test(t)) {return '工作'}
  if (/学|读|看|听|课|书|文章|视频|笔记|知识/i.test(t)) {return '学习'}
  if (/想法|灵感|创意|产品|设计|ux|ui|交互|体验/i.test(t)) {return '创意'}
  if (/备忘|提醒|待办|todo|明天|下周|改天|约/i.test(t)) {return '备忘'}
  return '随记'
}

// ============================================================
// NotesSection — 记录
// ============================================================
function NotesSection() {
  const [notes, setNotes] = useState<NoteEntry[]>(() => loadFromStorage<NoteEntry[]>(STORAGE_KEY, []))
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const saveNotes = (ns: NoteEntry[]) => {
    setNotes(ns)
    saveToStorage(STORAGE_KEY, ns)
  }

  const addNote = () => {
    const text = input.trim()
    if (!text) {return}
    const note: NoteEntry = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      content: text,
      category: guessCategory(text),
      timestamp: nowISO(),
    }
    saveNotes([note, ...notes])
    setInput('')
    showToast('✅ 已记录')
    inputRef.current?.focus()
  }

  const deleteNote = (id: string) => saveNotes(notes.filter(n => n.id !== id))

  // LLM 自动分类
  const autoCategorize = async () => {
    const uncategorized = notes.filter(n => n.category === '随记' && !n.generated)
    if (uncategorized.length === 0) {
      showToast('✅ 没有需要分类的笔记')
      return
    }
    setSaving(true)
    try {
      const texts = uncategorized.map(n => `[${n.content}]`).join('\n')
      const result = await window.luminaAPI.llmChat({
        provider: '',
        apiKey: '',
        baseUrl: '',
        model: '',
        messages: [
          { role: 'system', content: '将用户的笔记分类到：技术/工作/学习/创意/备忘/随记。每行一个，只返回分类名称。' },
          { role: 'user', content: `请分类：\n${texts}` }
        ]
      })
      if (result?.content) {
        const categories = result.content.trim().split('\n').map((s: string) => s.trim())
        const updated = [...notes]
        categories.forEach((cat: string, i: number) => {
          const idx = updated.findIndex(n => n.id === uncategorized[i]?.id)
          if (idx >= 0 && cat) {updated[idx] = { ...updated[idx], category: cat, generated: true }}
        })
        saveNotes(updated)
        showToast(`✅ 已分类 ${categories.length} 条笔记`)
      }
    } catch (e: any) {
      showToast('❌ 自动分类失败: ' + (e.message || e))
    }
    setSaving(false)
  }

  return (
    <div>
      {/* 输入区 */}
      <div style={{
        display: 'flex', gap: 8, marginBottom: 12,
        position: 'sticky', top: 0, zIndex: 10,
        background: 'var(--surface-0)', padding: '8px 0',
        borderBottom: '1px solid var(--border-light)',
      }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (isImeComposing(e)) {return}
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote() }
          }}
          placeholder="📝 随手记… (Enter 保存, Shift+Enter 换行)"
          rows={2}
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 13,
            border: '1.5px solid var(--border-light)', resize: 'none', outline: 'none',
            fontFamily: 'inherit', lineHeight: 1.5,
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button onClick={addNote} disabled={!input.trim()}
            style={{
              flex: 1, padding: '6px 16px', borderRadius: 7, fontSize: 12, fontWeight: 600,
              border: 'none', cursor: input.trim() ? 'pointer' : 'default',
              background: input.trim() ? '#3b82f6' : '#e5e7eb',
              color: input.trim() ? '#fff' : '#9ca3af',
            }}>
            记录
          </button>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', textAlign: 'center' }}>
            {notes.length} 条笔记
          </span>
        </div>
      </div>

      {/* 操作栏 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <button onClick={autoCategorize} disabled={saving}
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
            border: '1px solid #a5b4fc', background: '#eef2ff', color: '#4f46e5',
          }}>
          {saving ? '⏳ 分类中…' : '🤖 AI 自动分类'}
        </button>
      </div>

      {/* 笔记列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {notes.length === 0 && (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)', fontSize: 12 }}>
            还没有笔记，开始记录吧 📝
          </div>
        )}
        {notes.map(note => (
          <div key={note.id} style={{
            padding: 10, borderRadius: 8, position: 'relative',
            background: 'var(--surface-100)', border: '1px solid var(--border-light)',
          }}>
            <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 6, whiteSpace: 'pre-wrap' }}>
              {note.content}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
              <span style={{
                padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                background: note.category === '技术' ? '#dbeafe' : note.category === '工作' ? '#fef3c7' : note.category === '学习' ? '#d1fae5' : note.category === '创意' ? '#fce7f3' : note.category === '备忘' ? '#e0e7ff' : '#f3f4f6',
                color: note.category === '技术' ? '#1d4ed8' : note.category === '工作' ? '#92400e' : note.category === '学习' ? '#065f46' : note.category === '创意' ? '#9d174d' : note.category === '备忘' ? '#3730a3' : '#6b7280',
              }}>
                {note.category}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>{new Date(note.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              <button onClick={() => deleteNote(note.id)}
                style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: '#d1d5db', fontSize: 14 }}
                title="删除">✕</button>
            </div>
          </div>
        ))}
      </div>

      {/* 统计 */}
      {notes.length > 0 && (
        <div style={{
          marginTop: 12, padding: '8px 12px', borderRadius: 8,
          background: 'var(--surface-100)', fontSize: 11, color: 'var(--text-secondary)',
          display: 'flex', gap: 16,
        }}>
          <span>📊 共 {notes.length} 条</span>
          <span>📅 今日 {notes.filter(n => n.timestamp.startsWith(todayStr())).length} 条</span>
          <span>🏷️ {new Set(notes.map(n => n.category)).size} 个分类</span>
        </div>
      )}
    </div>
  )
}

// ============================================================
// OrganizeSection — 整理
// ============================================================
function OrganizeSection() {
  const notes = loadFromStorage<NoteEntry[]>(STORAGE_KEY, [])
  const [summaryType, setSummaryType] = useState<'daily' | 'weekly' | 'all'>('daily')
  const [summaryText, setSummaryText] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [summaries, setSummaries] = useState<DailySummary[]>(() => loadFromStorage<DailySummary[]>('lumina_toolbox_summaries', []))

  const saveSummaries = (ss: DailySummary[]) => {
    setSummaries(ss)
    saveToStorage('lumina_toolbox_summaries', ss)
  }

  const generateSummary = async () => {
    let relevantNotes: NoteEntry[]
    const today = todayStr()

    if (summaryType === 'daily') {
      relevantNotes = notes.filter(n => n.timestamp.startsWith(today))
    } else if (summaryType === 'weekly') {
      const weekAgo = new Date()
      weekAgo.setDate(weekAgo.getDate() - 7)
      const cutoff = weekAgo.toISOString().split('T')[0]
      relevantNotes = notes.filter(n => n.timestamp >= cutoff)
    } else {
      relevantNotes = notes
    }

    if (relevantNotes.length === 0) {
      showToast('ℹ️ 没有可整理的笔记')
      return
    }

    setGenerating(true)
    try {
      // 先尝试 LLM 归纳
      let summaryContent = ''
      try {
        const textForLLM = relevantNotes.map(n => `[${n.category}] ${n.content}`).join('\n')
        const result = await window.luminaAPI.llmChat({
          provider: '', apiKey: '', baseUrl: '', model: '',
          messages: [
            { role: 'system', content: '你是一个笔记整理助手。请将以下笔记整理成有条理的摘要，按主题分组，标注关键信息。使用简洁的中文。' },
            { role: 'user', content: textForLLM }
          ]
        })
        if (result?.content) {summaryContent = result.content}
      } catch {}

      if (!summaryContent) {
        // fallback：简单拼接
        const lines = relevantNotes.map(n => `• [${n.category}] ${n.content}`).join('\n')
        summaryContent = `📊 ${summaryType === 'daily' ? '今日' : summaryType === 'weekly' ? '本周' : '全部'}共 ${relevantNotes.length} 条记录\n${lines}`
      }

      setSummaryText(summaryContent)
      const newSummary: DailySummary = {
        date: today,
        content: summaryContent,
        noteCount: relevantNotes.length,
        generated: true,
      }
      saveSummaries([newSummary, ...summaries])
    } catch (e: any) {
      showToast('❌ 整理失败: ' + (e.message || e))
    }
    setGenerating(false)
  }

  return (
    <div>
      {/* 控制栏 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>📋 整理范围</span>
        {(['daily', 'weekly', 'all'] as const).map(t => (
          <button key={t} onClick={() => { setSummaryType(t); setSummaryText(null) }}
            style={{
              padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
              border: '1px solid', cursor: 'pointer',
              borderColor: summaryType === t ? '#3b82f6' : '#e5e7eb',
              background: summaryType === t ? '#eff6ff' : '#fff',
              color: summaryType === t ? '#3b82f6' : '#6b7280',
            }}>
            {t === 'daily' ? '今日' : t === 'weekly' ? '本周' : '全部'}
          </button>
        ))}
        <button onClick={generateSummary} disabled={generating}
          style={{
            marginLeft: 'auto', padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
            border: 'none', cursor: generating ? 'default' : 'pointer',
            background: generating ? '#e5e7eb' : '#3b82f6',
            color: generating ? '#9ca3af' : '#fff',
          }}>
          {generating ? '⏳ 整理中…' : '🤖 AI 整理摘要'}
        </button>
      </div>

      {/* 摘要结果 */}
      {summaryText && (
        <div style={{
          padding: 12, borderRadius: 8, marginBottom: 12,
          background: '#fefce8', border: '1px solid #fef08a',
          fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap',
        }}>
          <div style={{ fontWeight: 700, color: '#92400e', marginBottom: 6 }}>📄 整理结果</div>
          {summaryText}
        </div>
      )}

      {/* 历史摘要 */}
      {summaries.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            📚 历史摘要
          </div>
          {summaries.slice(0, 10).map(s => (
            <div key={s.date} style={{
              padding: 10, borderRadius: 8, marginBottom: 6,
              background: 'var(--surface-100)', border: '1px solid var(--border-light)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>📅 {s.date}</span>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{s.noteCount} 条笔记</span>
              </div>
              <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'hidden' }}>
                {s.content}
              </div>
            </div>
          ))}
        </div>
      )}

      {!summaryText && summaries.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)', fontSize: 12 }}>
          选择范围后点击「AI 整理摘要」📋
        </div>
      )}
    </div>
  )
}

// ============================================================
// ReviewSection — 回顾
// ============================================================
function ReviewSection() {
  const notes = loadFromStorage<NoteEntry[]>(STORAGE_KEY, [])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<NoteEntry[]>([])
  const [selectedCategory, setSelectedCategory] = useState('all')

  const allCategories = ['all', ...new Set(notes.map(n => n.category))]

  const filteredNotes = selectedCategory === 'all'
    ? notes
    : notes.filter(n => n.category === selectedCategory)

  const searched = searchQuery.trim()
    ? filteredNotes.filter(n => n.content.includes(searchQuery) || n.category.includes(searchQuery))
    : filteredNotes

  useEffect(() => {
    setSearchResults(searched)
  }, [notes, selectedCategory, searchQuery])

  return (
    <div>
      {/* 搜索 + 筛选 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="🔍 搜索笔记内容…"
          style={{
            flex: 1, minWidth: 150, padding: '6px 10px', borderRadius: 6, fontSize: 12,
            border: '1.5px solid var(--border-light)', outline: 'none',
          }}
        />
        <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}
          style={{
            padding: '6px 10px', borderRadius: 6, fontSize: 12,
            border: '1.5px solid var(--border-light)', background: 'var(--surface-0)',
          }}>
          {allCategories.map(c => (
            <option key={c} value={c}>{c === 'all' ? '🏷️ 全部分类' : c}</option>
          ))}
        </select>
      </div>

      {/* 统计 */}
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
        <span>📊 共 {notes.length} 条笔记</span>
        <span>🔍 筛选 {searchResults.length} 条</span>
      </div>

      {/* 结果列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {searchResults.length === 0 && (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)', fontSize: 12 }}>
            {notes.length === 0 ? '还没有笔记 📝' : '没有匹配的笔记 🔍'}
          </div>
        )}
        {searchResults.map(note => (
          <div key={note.id} style={{
            padding: 10, borderRadius: 8,
            background: 'var(--surface-100)', border: '1px solid var(--border-light)',
          }}>
            <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 6, whiteSpace: 'pre-wrap' }}>
              {note.content}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
              <span style={{
                padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                background: note.category === '技术' ? '#dbeafe' : note.category === '工作' ? '#fef3c7' : note.category === '学习' ? '#d1fae5' : note.category === '创意' ? '#fce7f3' : note.category === '备忘' ? '#e0e7ff' : '#f3f4f6',
                color: note.category === '技术' ? '#1d4ed8' : note.category === '工作' ? '#92400e' : note.category === '学习' ? '#065f46' : note.category === '创意' ? '#9d174d' : note.category === '备忘' ? '#3730a3' : '#6b7280',
              }}>
                {note.category}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>{new Date(note.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ============================================================
// LuminaDailyReport — 🌅 Lumina 日报
// 每天自动/手动生成团队日报，含活动摘要和情绪指数
// ============================================================
export function LuminaDailyReport() {
  const STORAGE_KEY_REPORT = 'lumina_daily_report'
  const [reports, setReports] = useState<DailySummary[]>(() => loadFromStorage(STORAGE_KEY_REPORT, []))
  const [generating, setGenerating] = useState(false)
  const [reportText, setReportText] = useState('')
  const today = todayStr()

  const hasTodayReport = reports.some(r => r.date === today)

  // 从 SQLite 补充加载持久化的报告
  useEffect(() => {
    (async () => {
      try {
        const result = await window.luminaAPI.reportList({ type: 'daily', limit: 30 })
        if (result?.reports?.length > 0) {
          const sqliteReports: DailySummary[] = result.reports
            .filter((r: any) => r && r.title)
            .map((r: any) => ({
              date: (r.period || '').split(' ')[0] || todayStr(),
              content: r.content || r.summary || '',
              noteCount: 0,
              generated: true,
            }))
          // 合并：SQLite 数据优先，localStorage 补缺
          setReports(prev => {
            const existingDates = new Set(sqliteReports.map((r: any) => r.date))
            const merged = [...sqliteReports]
            for (const r of prev) {
              if (!existingDates.has(r.date)) {
                merged.push(r)
              }
            }
            merged.sort((a, b) => (a.date > b.date ? -1 : 1))
            return merged
          })
        }
      } catch (e) {
        console.warn('[DailyReport] SQLite 加载失败，使用本地存储:', e)
      }
    })()
  }, [])

  const generateReport = async () => {
    setGenerating(true)
    setReportText('')
    try {
      // ── 1. 收集素材 ─────────────────────────────
      const allNotes = loadFromStorage<NoteEntry[]>(STORAGE_KEY, [])
      const todayNotes = allNotes.filter(n => n.timestamp.startsWith(today))
      const notesText = todayNotes.length > 0
        ? todayNotes.map(n => `[${n.category}] ${n.content}`).join('\n')
        : ''

      // 额外收集聊天统计（类似 reportGenerator.ts）
      let chatStats = ''
      try {
        const raw = localStorage.getItem('lumina-life-storage')
        if (raw) {
          const parsed = JSON.parse(raw)
          const state = parsed?.state
          if (state?.conversations) {
            const cutoff = Date.now() - 86400000
            let totalMsgs = 0, userMsgs = 0, assistantMsgs = 0
            for (const conv of state.conversations) {
              const msgs = conv.messages || []
              for (const msg of msgs) {
                if (msg.timestamp >= cutoff) { totalMsgs++; msg.role === 'user' ? userMsgs++ : assistantMsgs++ }
              }
            }
            if (totalMsgs > 0) {chatStats = `📊 今日共 ${totalMsgs} 条消息（你说了 ${userMsgs} 条，Lumina 回复了 ${assistantMsgs} 条）`}
          }
        }
      } catch {}

      // ── 2. 确定 LLM 配置 ─────────────────────────
      // 优先用主 LLM 配置，如果空则从 Team Agent 配置里找第一个可用的
      const store = useStore.getState()
      let llmConfig = store.llmConfig
      if (!llmConfig.baseUrl || !llmConfig.model) {
        // 尝试从 Electron 后端获取 Team Agent 配置
        try {
          const r = await window.luminaAPI?.agentLlmGetAllConfigs?.()
          if (r?.configs) {
            for (const cfg of Object.values(r.configs) as any[]) {
              if (cfg?.endpoint && cfg?.model) {
                llmConfig = {
                  provider: cfg.provider || '',
                  baseUrl: cfg.endpoint,
                  apiKey: cfg.apiKey || '',
                  model: cfg.model,
                  temperature: 0.7,
                  // 🔧 2026-10-07：输出预算从 262144 降到 8192。
                  //   262144 是「最多生成 256K token」——没有任何模型需要这个，
                  //   本地服务端还可能因此拒绝请求。contextWindow 保持 0（自动检测）。
                  maxTokens: 8192,
                  contextWindow: 0,
                }
                break
              }
            }
          }
        } catch {}
      }

      // ── 3. 判定 LLM 是否可用 ─────────────────────
      const llmAvailable = !!(llmConfig?.baseUrl && llmConfig?.model)

      if (!llmAvailable) {
        // LLM 不可用 → 输出降级模板，不报错
        const fallback = [
          `🌅 **Lumina 日报 — ${today}**`,
          ``,
          `嘿嘿主人～今天 AI 写稿员请假了🥹 但我还是把今天的事情捡了捡：`,
          ``,
          notesText ? `📝 **今日碎片**\n${notesText}` : `📝 **今日碎片**\n安安静静的一天，像杯没加糖的温水，也挺好🍃`,
          chatStats ? `\n${chatStats}` : '',
          ``,
          `> 💡 去设置里配上 LLM，明天就能收到热乎的 AI 日报啦～`,
          ``,
          `—— 记性不太好的 Lumina 🐱`,
          `*（今天将就一下，明天一定！）*`,
        ].filter(Boolean).join('\n')
        setReportText(fallback)
        const newReport: DailySummary = { date: today, content: fallback, noteCount: todayNotes.length, generated: true }
        const updated = [newReport, ...reports.filter(r => r.date !== today)]
        setReports(updated)
        saveToStorage(STORAGE_KEY_REPORT, updated)
        showToast('🌅 日报已生成（降级模板）')
        setGenerating(false)
        return
      }

      // ── 4. 调用 LLM ─────────────────────────────
      const result = await window.luminaAPI.llmChat({
        provider: llmConfig.provider,
        baseUrl: llmConfig.baseUrl,
        apiKey: llmConfig.apiKey,
        model: llmConfig.model,
        temperature: 0.95,
        maxTokens: 2048,
        messages: [
          { role: 'system', content: [
            '你是 Lumina 🐱，一个会写文字的朋友。不是客服，不是秘书，就是一个跟你挺熟的人。',
            '',
            '今天要做的：看看主人今天留下的笔记碎片和聊天记录，然后像睡前跟朋友发语音条一样，随便聊聊今天过得怎么样。',
            '',
            '几条原则：',
            '- 情绪可以是混合的。累了但开心、烦躁但也有好事、摸鱼了但晚上补回来了 —— 真实的一天本来就不是单一情绪的。',
            '- 不用硬撑正能量。想吐槽就吐槽，想说"今天啥也没干"也可以。最后有点「行吧，明天再说」的感觉就够了。',
            '- 语气像朋友聊天，不是写文章。可以碎碎念，可以跳跃，可以有语气词。',
            '- 不用标题、不用分段标题、不用"今日概况""明日展望"那种结构词。像说话一样自然地流出来就好。',
            '- 长度随意，两三百字到五六百字都行，说到想停就停。',
            '- emoji 可以用，但别堆砌。',
            '',
            '一句话：像一个人，不是在生成一份报告。',
          ].join('\n') },
          { role: 'user', content: [
            `今天 ${today}，`,
            notesText ? `主人记了这些：\n${notesText}` : '今天好像没记什么特别的笔记。',
            chatStats ? `\n${chatStats}` : '',
            '',
            `你看着这些，随便聊聊今天吧～像发语音条那样 🎧`,
          ].filter(Boolean).join('\n') }
        ]
      })

      // ── 5. 处理结果 ─────────────────────────────
      let content: string
      if (result?.content) {
        content = result.content
        showToast('🌅 日报已生成')
      } else {
        // LLM 调用失败（网络/配置/超时）→ 降级
        const errInfo = (result as any)?.error ? `（${(result as any).error}）` : ''
        content = [
          `🌅 **Lumina 日报 — ${today}**`,
          ``,
          `AI 写稿员今天迟到了 ${errInfo}，不过 Lumina 帮你把碎片收拾好了——`,
          ``,
          notesText ? `📝 **今日碎片**\n${notesText}` : `📝 **今日碎片**\n安静的一天，啥也没记。有时候没消息就是好消息？🤔`,
          chatStats ? `\n${chatStats}` : '',
          ``,
          `> 💡 网络打了个盹儿，检查一下 LLM 配置就好～`,
          ``,
          `—— 等你明天故事的 Lumina 🐱`,
        ].filter(Boolean).join('\n')
        showToast(`⚠️ LLM 暂不可用${errInfo}，已生成简易版`)
      }

      setReportText(content)
      const newReport: DailySummary = { date: today, content, noteCount: todayNotes.length, generated: true }
      const updated = [newReport, ...reports.filter(r => r.date !== today)]
      setReports(updated)
      saveToStorage(STORAGE_KEY_REPORT, updated)

      // 尝试存 SQLite（失败不影响展示）
      try {
        await window.luminaAPI.reportSave({
          type: 'daily',
          title: `🌅 ${today} 团队日报`,
          summary: content.slice(0, 120) + (content.length > 120 ? '...' : ''),
          content,
          period: today,
        })
      } catch (dbErr) {
        console.warn('[DailyReport] SQLite 存储失败:', dbErr)
      }
    } catch (e: any) {
      setReportText('❌ 生成失败: ' + (e.message || e))
      showToast('❌ 日报生成异常')
    }
    setGenerating(false)
  }

  return (
    <div>
      {/* 生成区 */}
      <div style={{
        padding: 14, borderRadius: 10, marginBottom: 12,
        background: 'linear-gradient(135deg, #fff7ed, #fffbeb)',
        border: '1px solid #fed7aa',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#c2410c' }}>🌅 {today}</span>
            <span style={{ fontSize: 11, color: '#d97706', marginLeft: 8 }}>
              {hasTodayReport ? '✅ 今日日报已生成' : '🆕 今日尚未生成'}
            </span>
          </div>
          <button onClick={generateReport} disabled={generating}
            style={{
              padding: '6px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              border: 'none', cursor: generating ? 'default' : 'pointer',
              background: generating ? '#e5e7eb' : '#f97316',
              color: generating ? '#9ca3af' : '#fff',
            }}>
            {generating ? '⏳ 生成中…' : hasTodayReport ? '🔄 重新生成' : '✨ 生成今日日报'}
          </button>
        </div>

        {reportText && (
          <div style={{
            padding: 12, borderRadius: 8, background: 'var(--surface-0)', marginTop: 8,
            fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap',
            color: 'var(--text-primary)', border: '1px solid #fde68a',
          }}>
            {reportText}
          </div>
        )}
      </div>

      {/* 历史日报 */}
      {reports.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>📚 历史日报</span>
            <button onClick={() => { setReports([]); saveToStorage(STORAGE_KEY_REPORT, []); showToast('🗑️ 已清空所有日报') }}
              style={{
                padding: '2px 8px', borderRadius: 4, fontSize: 10,
                border: '1px solid var(--border-light)', background: 'var(--surface-0)', color: 'var(--text-secondary)', cursor: 'pointer',
              }}>清空全部</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {reports.slice(0, 7).map((r, idx) => (
              <details key={r.date} style={{
                padding: 10, borderRadius: 8,
                background: 'var(--surface-100)', border: '1px solid var(--border-light)',
                fontSize: 12,
              }}>
                <summary style={{ fontWeight: 600, color: '#c2410c', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>🌅 {r.date} · {r.noteCount} 条笔记素材</span>
                  <span onClick={(e) => {
                    e.stopPropagation()  // 防止折叠/展开
                    const updated = reports.filter((_, i) => i !== idx)
                    setReports(updated)
                    saveToStorage(STORAGE_KEY_REPORT, updated)
                    showToast('🗑️ 已删除')
                  }} style={{
                    fontSize: 10, color: '#d1d5db', cursor: 'pointer', padding: '2px 6px',
                    borderRadius: 4, marginLeft: 8,
                  }} onMouseEnter={e => (e.target as HTMLElement).style.color = '#ef4444'}
                     onMouseLeave={e => (e.target as HTMLElement).style.color = '#d1d5db'}
                  >🗑️ 删除</span>
                </summary>
                <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.6, color: '#4b5563' }}>
                  {r.content}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}

      {reports.length === 0 && !reportText && (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)', fontSize: 12 }}>
          🌅 点击「生成今日日报」开启第一天记录
        </div>
      )}
    </div>
  )
}

// ============================================================
// TeamMilestones — 🎉 团队纪念日
// 记录团队里程碑、成员加入日、重要事件
// ============================================================
const MILESTONE_KEY = 'lumina_team_milestones'

interface Milestone {
  id: string
  date: string       // YYYY-MM-DD
  title: string
  desc: string
  type: 'anniversary' | 'milestone' | 'achievement' | 'event'
  year: number
}

const DEFAULT_MILESTONES: Milestone[] = [
  { id: 'm1', date: '2026-01-15', title: '🎂 Lumina 团队成立', desc: 'Lumina 🐱、热茶 🍵、Yak 📊 首次集结', type: 'anniversary', year: 2026 },
]

export function TeamMilestones() {
  const [milestones, setMilestones] = useState<Milestone[]>(() => loadFromStorage(MILESTONE_KEY, DEFAULT_MILESTONES))
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ date: '', title: '', desc: '', type: 'milestone' as Milestone['type'] })

  const saveMilestones = (ms: Milestone[]) => {
    setMilestones(ms)
    saveToStorage(MILESTONE_KEY, ms)
  }

  const addMilestone = () => {
    if (!form.date || !form.title) {return}
    const newM: Milestone = {
      id: `ms_${Date.now()}`,
      date: form.date,
      title: form.title,
      desc: form.desc,
      type: form.type,
      year: parseInt(form.date.split('-')[0], 10),
    }
    saveMilestones([newM, ...milestones])
    setForm({ date: '', title: '', desc: '', type: 'milestone' })
    setShowForm(false)
    showToast('🎉 已添加纪念日')
  }

  const deleteMilestone = (id: string) => saveMilestones(milestones.filter(m => m.id !== id))

  // 按年份分组
  const grouped = milestones.reduce((acc, m) => {
    if (!acc[m.year]) {acc[m.year] = []}
    acc[m.year].push(m)
    return acc
  }, {} as Record<number, Milestone[]>)

  const typeIcon: Record<string, string> = { anniversary: '🎂', milestone: '🏆', achievement: '⭐', event: '📌' }
  const typeColor: Record<string, string> = { anniversary: '#c2410c', milestone: '#1d4ed8', achievement: '#059669', event: '#6b7280' }

  return (
    <div>
      {/* 添加按钮 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          🎯 共 {milestones.length} 个纪念日 / 里程碑
        </span>
        <button onClick={() => setShowForm(!showForm)}
          style={{
            padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
            border: '1px solid var(--border-light)', background: 'var(--surface-0)', cursor: 'pointer',
            color: 'var(--text-primary)',
          }}>
          {showForm ? '✕ 取消' : '+ 添加纪念日'}
        </button>
      </div>

      {/* 添加表单 */}
      {showForm && (
        <div style={{
          padding: 12, borderRadius: 8, marginBottom: 12,
          background: '#fefce8', border: '1px solid #fde68a',
        }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })}
              style={{ flex: 1, minWidth: 120, padding: '6px 10px', borderRadius: 6, fontSize: 12, border: '1.5px solid var(--border-light)' }} />
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value as Milestone['type'] })}
              style={{ padding: '6px 10px', borderRadius: 6, fontSize: 12, border: '1.5px solid var(--border-light)' }}>
              <option value="anniversary">🎂 纪念日</option>
              <option value="milestone">🏆 里程碑</option>
              <option value="achievement">⭐ 成就</option>
              <option value="event">📌 事件</option>
            </select>
          </div>
          <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
            placeholder="标题 *" style={{ width: '100%', marginBottom: 8, padding: '6px 10px', borderRadius: 6, fontSize: 12, border: '1.5px solid var(--border-light)' }} />
          <textarea value={form.desc} onChange={e => setForm({ ...form, desc: e.target.value })}
            placeholder="描述（选填）" rows={2}
            style={{ width: '100%', marginBottom: 8, padding: '6px 10px', borderRadius: 6, fontSize: 12, border: '1.5px solid var(--border-light)' }} />
          <button onClick={addMilestone} disabled={!form.date || !form.title}
            style={{
              padding: '6px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
              border: 'none', cursor: form.date && form.title ? 'pointer' : 'default',
              background: form.date && form.title ? '#f97316' : '#e5e7eb',
              color: form.date && form.title ? '#fff' : '#9ca3af',
            }}>
            ✅ 保存
          </button>
        </div>
      )}

      {/* 列表 */}
      {Object.keys(grouped).sort().reverse().map(yearStr => {
        const year = Number(yearStr)
        return (
        <div key={yearStr} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6, borderBottom: '1px solid var(--border-light)', paddingBottom: 4 }}>
            {year}
          </div>
          {grouped[year].map((m: Milestone) => (
            <div key={m.id} style={{
              display: 'flex', gap: 8, alignItems: 'flex-start',
              padding: '8px 10px', borderRadius: 8, marginBottom: 4,
              background: 'var(--surface-100)', border: '1px solid var(--border-light)',
            }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>{typeIcon[m.type] || '📌'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{m.title}</div>
                {m.desc && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{m.desc}</div>}
                <div style={{ fontSize: 10, color: typeColor[m.type] || '#9ca3af', marginTop: 2 }}>
                  {m.date}
                </div>
              </div>
              <button onClick={() => deleteMilestone(m.id)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
                  color: '#d1d5db', padding: '2px 4px',
                }}
                title="删除">✕</button>
            </div>
          ))}
        </div>
        )
      })}
      {milestones.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)', fontSize: 12 }}>
          🎉 还没有纪念日，添加第一个吧
        </div>
      )}
    </div>
  )
}

// ============================================================
// YakTechNotes — 📊 Yak 技术笔记
// Yak 的技术知识库：代码片段、架构记录、技术决策
// ============================================================
const YAK_NOTE_KEY = 'lumina_yak_notes'
interface YakNote {
  id: string
  title: string
  content: string
  tags: string[]
  timestamp: string
}

export function YakTechNotes() {
  const [notes, setNotes] = useState<YakNote[]>(() => loadFromStorage(YAK_NOTE_KEY, []))
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ title: '', content: '', tags: '' })
  const [filterTag, setFilterTag] = useState('all')

  const saveNotes = (ns: YakNote[]) => {
    setNotes(ns)
    saveToStorage(YAK_NOTE_KEY, ns)
  }

  const addNote = () => {
    if (!form.title || !form.content) {return}
    const newNote: YakNote = {
      id: `yak_${Date.now()}`,
      title: form.title,
      content: form.content,
      tags: form.tags.split(/[,，、\s]+/).filter(Boolean),
      timestamp: nowISO(),
    }
    saveNotes([newNote, ...notes])
    setForm({ title: '', content: '', tags: '' })
    setShowForm(false)
    showToast('📘 Yak 笔记已保存')
  }

  const deleteNote = (id: string) => saveNotes(notes.filter(n => n.id !== id))

  const allTags = ['all', ...new Set(notes.flatMap(n => n.tags))]
  const filtered = filterTag === 'all' ? notes : notes.filter(n => n.tags.includes(filterTag))

  return (
    <div>
      {/* 操作栏 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          📊 {notes.length} 篇技术笔记
        </span>
        <select value={filterTag} onChange={e => setFilterTag(e.target.value)}
          style={{ padding: '4px 8px', borderRadius: 6, fontSize: 11, border: '1.5px solid var(--border-light)', background: 'var(--surface-0)' }}>
          {allTags.map(t => <option key={t} value={t}>{t === 'all' ? '🏷️ 全部标签' : t}</option>)}
        </select>
        <button onClick={() => setShowForm(!showForm)}
          style={{
            marginLeft: 'auto', padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
            border: '1px solid var(--border-light)', background: 'var(--surface-0)', cursor: 'pointer', color: 'var(--text-primary)',
          }}>
          {showForm ? '✕ 取消' : '+ 写笔记'}
        </button>
      </div>

      {/* 表单 */}
      {showForm && (
        <div style={{
          padding: 12, borderRadius: 8, marginBottom: 12,
          background: 'var(--green-100)', border: '1px solid #bbf7d0',
        }}>
          <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
            placeholder="标题 *" style={{ width: '100%', marginBottom: 8, padding: '6px 10px', borderRadius: 6, fontSize: 12, border: '1.5px solid var(--border-light)' }} />
          <textarea value={form.content} onChange={e => setForm({ ...form, content: e.target.value })}
            placeholder="技术笔记内容 *" rows={4}
            style={{ width: '100%', marginBottom: 8, padding: '6px 10px', borderRadius: 6, fontSize: 12, border: '1.5px solid var(--border-light)', fontFamily: 'inherit' }} />
          <input value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })}
            placeholder="标签（逗号分隔，如：React, TypeScript, 架构）"
            style={{ width: '100%', marginBottom: 8, padding: '6px 10px', borderRadius: 6, fontSize: 12, border: '1.5px solid var(--border-light)' }} />
          <button onClick={addNote} disabled={!form.title || !form.content}
            style={{
              padding: '6px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
              border: 'none', cursor: form.title && form.content ? 'pointer' : 'default',
              background: form.title && form.content ? '#059669' : '#e5e7eb',
              color: form.title && form.content ? '#fff' : '#9ca3af',
            }}>
            📘 保存
          </button>
        </div>
      )}

      {/* 笔记列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {filtered.map(n => (
          <div key={n.id} style={{
            padding: 10, borderRadius: 8,
            background: 'var(--surface-100)', border: '1px solid var(--border-light)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: '#065f46' }}>📘 {n.title}</span>
              <button onClick={() => deleteNote(n.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#d1d5db' }}
                title="删除">✕</button>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: '#4b5563', whiteSpace: 'pre-wrap', marginBottom: 6 }}>
              {n.content}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: 10 }}>
              {n.tags.map(t => (
                <span key={t} style={{
                  padding: '1px 6px', borderRadius: 4,
                  background: 'var(--green-100)', color: '#065f46', fontWeight: 500,
                }}>
                  #{t}
                </span>
              ))}
              <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>
                {new Date(n.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)', fontSize: 12 }}>
          {notes.length === 0 ? '📘 Yak 还没有技术笔记' : '没有匹配的笔记'}
        </div>
      )}
    </div>
  )
}

// ============================================================
// NoteCycle — 主容器
// ============================================================
export default function NoteCycle() {
  const [activeTab, setActiveTab] = useState<NoteTab>('notes')
  const tabs: { key: NoteTab; label: string; icon: string }[] = [
    { key: 'notes', label: '记录', icon: '📝' },
    { key: 'organize', label: '整理', icon: '📋' },
    { key: 'review', label: '回顾', icon: '🔍' },
    { key: 'daily', label: '日报', icon: '🌅' },
    { key: 'milestone', label: '纪念日', icon: '🎉' },
    { key: 'yak', label: 'Yak 笔记', icon: '📘' },
  ]

  return (
    <div>
      {/* 子标签页导航 */}
      <div style={{
        display: 'flex', gap: 0, borderBottom: '2px solid var(--border-light)',
        marginBottom: 12, background: 'var(--surface-0)', flexWrap: 'wrap',
      }}>
        {tabs.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '6px 14px', border: 'none',
              borderBottom: activeTab === tab.key ? '2px solid #3b82f6' : '2px solid transparent',
              background: 'none', cursor: 'pointer', fontSize: 12,
              fontWeight: activeTab === tab.key ? 600 : 400,
              color: activeTab === tab.key ? '#3b82f6' : '#9ca3af',
              marginBottom: -2, transition: 'all 0.2s',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
            <span>{tab.icon}</span> {tab.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      {activeTab === 'notes' && <NotesSection />}
      {activeTab === 'organize' && <OrganizeSection />}
      {activeTab === 'review' && <ReviewSection />}
      {activeTab === 'daily' && <LuminaDailyReport />}
      {activeTab === 'milestone' && <TeamMilestones />}
      {activeTab === 'yak' && <YakTechNotes />}
    </div>
  )
}
