// ============================================================
// panels/SkillMarketPanel.tsx — Skill 市场面板 (v3.10 → v2.17 白色主题)
//
// 功能：浏览/搜索/安装/卸载/评分/导入导出
// v2.17: 集成魔搭社区 (ModelScope) 技能仓库
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'
import type { SkillCategory } from '../../electron/skillMarket'

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

interface SkillEntry {
  id: string; name: string; version: string; description: string
  author: string; category: SkillCategory; tags: string[]
  icon?: string; rating: number; ratingCount: number; downloads: number
  installed: boolean; installedAt?: string; enabled?: boolean
  source?: string  // 🔧 v2.17: 来源标记 (local / modelscope / github)
}

interface Review {
  id: string; author: string; rating: number; comment: string; createdAt: string
}

const CATEGORIES: { key: SkillCategory; label: string; emoji: string }[] = [
  { key: 'productivity', label: '生产力', emoji: '⚡' },
  { key: 'coding', label: '编程', emoji: '💻' },
  { key: 'creative', label: '创意', emoji: '🎨' },
  { key: 'data', label: '数据', emoji: '📊' },
  { key: 'automation', label: '自动化', emoji: '🤖' },
  { key: 'entertainment', label: '娱乐', emoji: '🎮' },
  { key: 'education', label: '教育', emoji: '📖' },
  { key: 'finance', label: '金融', emoji: '💰' },
  { key: 'health', label: '健康', emoji: '💪' },
  { key: 'social', label: '社交', emoji: '💬' },
  { key: 'other', label: '其他', emoji: '📦' },
]

const SOURCE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  local: { label: '本地', color: 'var(--text-secondary)', bg: 'var(--border-light)' },
  modelscope: { label: '魔搭', color: '#6366f1', bg: '#eef2ff' },
  github: { label: 'GitHub', color: 'var(--text-primary)', bg: 'var(--border-light)' },
  community: { label: '社区', color: '#10b981', bg: '#ecfdf5' },
}

// ═══════════════════════════════════════════════════════════
// 组件
// ═══════════════════════════════════════════════════════════

export default function SkillMarketPanel() {
  const [tab, setTab] = useState<'installed' | 'market'>('installed')
  const [installed, setInstalled] = useState<SkillEntry[]>([])
  const [marketSkills, setMarketSkills] = useState<SkillEntry[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCategory, setSearchCategory] = useState<SkillCategory | ''>('')
  const [selectedSkill, setSelectedSkill] = useState<SkillEntry | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [installing, setInstalling] = useState<string | null>(null)
  const [notification, setNotification] = useState('')
  const [marketSource, setMarketSource] = useState<'community' | 'modelscope'>('community')  // 🔧 v2.17
  /**
   * 远端注册表健康度。
   * 【为什么必须读它】搜索结果会把远端与静态索引**合并**返回，
   * 所以「远端挂了」在结果里是看不见的 —— 用户只会看到一市场内置技能，
   * 合理地以为「这软件生态不好」，而真实原因（索引 URL 不可达）没人告诉他。
   * 之前我把这个能力做完了（SkillMarket.getRegistryHealth + IPC + preload），
   * 却**没让 UI 读它** —— 又一个「做了但没接线」的死能力。
   */
  const [registryHealth, setRegistryHealth] = useState<{
    reachable: boolean; source: string; detail: string
  } | null>(null)

  // ── 加载已安装 ────────────────────────────────────
  const loadInstalled = useCallback(async () => {
    try {
      const result = await window.luminaAPI?.skillMarketInstalled?.()
      setInstalled(result.map((s: any) => ({ ...s, installed: true, source: 'local' })))
    } catch { setInstalled([]) }
  }, [])

  // ── 搜索市场 ──────────────────────────────────────
  const searchMarket = useCallback(async (query?: string, cat?: string) => {
    const q = query ?? searchQuery
    const c = cat ?? searchCategory
    try {
      const result = await window.luminaAPI?.skillMarketSearch?.(q, c || undefined)
      setMarketSkills(result.skills.map((s: any) => {
        const isInstalled = installed.some(i => i.id === s.id)
        return { ...s, installed: isInstalled, enabled: isInstalled ? installed.find(i => i.id === s.id)?.enabled : false }
      }))
    } catch { setMarketSkills([]) }
  }, [searchQuery, searchCategory, installed])

  // 搜索魔搭社区
  const searchModelScope = useCallback(async (query?: string, cat?: string) => {
    const q = query ?? searchQuery
    const c = cat ?? searchCategory
    try {
      const result = await window.luminaAPI?.skillMarketModelScopeSearch?.(q, c || undefined)
      setMarketSkills(result.skills.map((s: any) => {
        const isInstalled = installed.some(i => i.id === s.id)
        return { ...s, installed: isInstalled, enabled: isInstalled ? installed.find(i => i.id === s.id)?.enabled : false, source: 'modelscope' }
      }))
    } catch { setMarketSkills([]) }
  }, [searchQuery, searchCategory, installed])

  useEffect(() => { loadInstalled() }, [])
  useEffect(() => {
    if (tab === 'market') {
      if (marketSource === 'modelscope') {searchModelScope()}
      else {searchMarket()}
    }
  }, [tab, marketSource])

  // ── 安装 ──────────────────────────────────────────
  const install = async (skillId: string) => {
    setInstalling(skillId)
    try {
      const result = await window.luminaAPI?.skillMarketInstallCommunity?.(skillId)
      if (result.success) {
        showNotif('✅ 安装成功！')
        loadInstalled()
        searchMarket()
      } else {
        showNotif('❌ ' + (result.error || '安装失败'))
      }
    } catch (err: any) {
      showNotif('❌ ' + err.message)
    }
    setInstalling(null)
  }

  // ── 卸载 ──────────────────────────────────────────
  const uninstall = async (skillId: string) => {
    try {
      await window.luminaAPI?.skillMarketUninstall?.(skillId)
      showNotif('🗑️ 已卸载')
      loadInstalled()
      if (selectedSkill?.id === skillId) {setSelectedSkill(null)}
    } catch (err: any) {
      showNotif('❌ ' + err.message)
    }
  }

  // ── 切换启用 ──────────────────────────────────────
  const toggleEnable = async (skillId: string, enabled: boolean) => {
    try {
      await window.luminaAPI?.skillMarketToggle?.(skillId, enabled)
      loadInstalled()
    } catch {}
  }

  // ── 导入本地 ──────────────────────────────────────
  const importLocal = async () => {
    try {
      const result = await window.luminaAPI?.skillMarketInstallLocal?.()
      if (result.success) {showNotif('✅ 导入成功！')}
      else if (result.error !== '用户取消') {showNotif('❌ ' + (result.error || '导入失败'))}
      loadInstalled()
    } catch {}
  }

  // ── 通知 ──────────────────────────────────────────
  const showNotif = (msg: string) => {
    setNotification(msg)
    setTimeout(() => setNotification(''), 3000)
  }

  // ── 搜索后读取注册表健康度 ──────────────────────────
  // 搜索必然触发一次远端拉取，所以顺带拿健康度，零额外开销。
  useEffect(() => {
    let alive = true
    window.luminaAPI?.skillMarketRegistryHealth?.()
      .then((h: any) => {if (alive) {setRegistryHealth(h)}})
      .catch(() => {if (alive) {setRegistryHealth(null)}})
    return () => {alive = false}
  }, [marketSkills])

  // ── 过滤 ──────────────────────────────────────────
  const filteredInstalled = installed.filter(s => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.tags.some(t => t.toLowerCase().includes(q))
    }
    if (searchCategory) {return s.category === searchCategory}
    return true
  })

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>🧩 技能商店</h2>
        <p style={styles.subtitle}>浏览、安装和管理 Lumina 技能</p>
        {notification && <div style={styles.notification}>{notification}</div>}
      </div>

      {/* ═══ Tabs ═══ */}
      <div style={styles.tabs}>
        <button style={{ ...styles.tabBtn, ...(tab === 'installed' ? styles.tabActive : {}) }}
          onClick={() => setTab('installed')}>📦 已安装 ({installed.length})</button>
        <button style={{ ...styles.tabBtn, ...(tab === 'market' ? styles.tabActive : {}) }}
          onClick={() => setTab('market')}>🛒 市场</button>
      </div>

      {/* ⚠️ 注册表降级提示 —— 远端不可达时说清真相 */}
      {/* 【为什么必须有】市场搜索会把远端与静态索引**合并**返回，
          所以「远端挂了」在列表里完全看不见。用户会看到一市场内置技能，
          合理地以为「这软件生态差」—— 而真实原因（索引地址不可达）没人告诉他。
          实测：默认注册表 URL 当前不可达，所以这个提示实际上**总该出现**。 */}
      {tab === 'market' && registryHealth && !registryHealth.reachable && (
        <div style={{
          padding: '8px 10px', marginBottom: 10, borderRadius: 6,
          fontSize: 11, lineHeight: 1.7,
          background: 'var(--yellow-100)', color: 'var(--text-primary)',
        }}>
          ⚠️ 当前只显示**随包内置**的技能：远端注册表不可达（{registryHealth.source}）。<br />
          这不代表生态为空。设置 <code>LUMINA_SKILL_REGISTRY</code> 可指向自建索引。
        </div>
      )}

      {/* 🔧 v2.17: 市场来源切换 */}
      {tab === 'market' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            style={{ ...styles.sourceBtn, ...(marketSource === 'community' ? styles.sourceBtnActive : {}) }}
            onClick={() => setMarketSource('community')}
          >🌐 社区仓库</button>
          <button
            style={{ ...styles.sourceBtn, ...(marketSource === 'modelscope' ? styles.sourceBtnActive : {}) }}
            onClick={() => setMarketSource('modelscope')}
          >🤖 魔搭社区</button>
        </div>
      )}

      {/* ═══ 搜索 + 分类 ═══ */}
      <div style={styles.searchBar}>
        <input
          style={styles.searchInput}
          placeholder="搜索技能..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') {tab === 'market' ? (marketSource === 'modelscope' ? searchModelScope() : searchMarket()) : null} }}
        />
        <select
          style={styles.categorySelect}
          value={searchCategory}
          onChange={e => { setSearchCategory(e.target.value as SkillCategory | ''); if (tab === 'market') {setTimeout(() => marketSource === 'modelscope' ? searchModelScope() : searchMarket(), 50)} }}
        >
          <option value="">全部分类</option>
          {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.emoji} {c.label}</option>)}
        </select>
        <button style={styles.searchBtn} onClick={() => marketSource === 'modelscope' ? searchModelScope() : searchMarket()}>🔍</button>
      </div>

      {/* ═══ 已安装列表 ═══ */}
      {tab === 'installed' && (
        <>
          {filteredInstalled.length === 0 ? (
            <div style={styles.empty}>暂无已安装技能<br/><span style={{ fontSize: 12 }}>从「市场」标签搜索并安装</span></div>
          ) : (
            <div style={styles.list}>
              {filteredInstalled.map(skill => (
                <div
                  key={skill.id}
                  style={{ ...styles.card, ...(selectedSkill?.id === skill.id ? styles.cardSelected : {}) }}
                  onClick={() => setSelectedSkill(skill)}
                >
                  <div style={styles.cardTop}>
                    <span style={styles.cardIcon}>{skill.icon || '🧩'}</span>
                    <div style={styles.cardInfo}>
                      <div style={styles.cardName}>
                        {skill.name}
                        <span style={styles.versionBadge}>v{skill.version}</span>
                        {!skill.enabled && <span style={styles.disabledBadge}>已禁用</span>}
                      </div>
                      <div style={styles.cardDesc}>{skill.description}</div>
                    </div>
                    <div style={styles.cardActions}>
                      <button style={{ ...styles.smallBtn, background: skill.enabled ? '#ef5350' : '#10b981' }}
                        onClick={e => { e.stopPropagation(); toggleEnable(skill.id, !skill.enabled) }}>
                        {skill.enabled ? '禁用' : '启用'}
                      </button>
                    </div>
                  </div>
                  <div style={styles.cardTags}>
                    {skill.tags?.map(t => <span key={t} style={styles.tag}>{t}</span>)}
                    <span style={{ ...styles.tag, background: SOURCE_LABELS[skill.source || 'local'].bg, color: SOURCE_LABELS[skill.source || 'local'].color }}>
                      {SOURCE_LABELS[skill.source || 'local'].label}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button style={styles.importBtn} onClick={importLocal}>📁 导入本地技能包 (.lumskill)</button>
        </>
      )}

      {/* ═══ 市场列表 ═══ */}
      {tab === 'market' && (
        <>
          {marketSkills.length === 0 ? (
            <div style={styles.empty}>
              {marketSource === 'modelscope' ? '在魔搭社区搜索技能...' : '搜索社区技能仓库...'}
              <br/><span style={{ fontSize: 12 }}>输入关键词搜索，或点击「魔搭社区」探索 AI 模型工具</span>
            </div>
          ) : (
            <div style={styles.list}>
              {marketSkills.map(skill => (
                <div
                  key={skill.id}
                  style={{ ...styles.card, ...(selectedSkill?.id === skill.id ? styles.cardSelected : {}) }}
                  onClick={() => setSelectedSkill(skill)}
                >
                  <div style={styles.cardTop}>
                    <span style={styles.cardIcon}>{skill.icon || '🧩'}</span>
                    <div style={styles.cardInfo}>
                      <div style={styles.cardName}>
                        {skill.name}
                        <span style={styles.versionBadge}>v{skill.version}</span>
                        <span style={{ ...styles.installedBadge, opacity: skill.installed ? 1 : 0 }}>已安装</span>
                      </div>
                      <div style={styles.cardDesc}>{skill.description}</div>
                    </div>
                    <div style={styles.cardActions}>
                      {skill.installed ? (
                        <span style={{ fontSize: 11, color: '#10b981' }}>✅</span>
                      ) : (
                        <button
                          style={{ ...styles.installBtn, opacity: installing === skill.id ? 0.6 : 1 }}
                          onClick={e => { e.stopPropagation(); install(skill.id) }}
                          disabled={installing === skill.id}
                        >
                          {installing === skill.id ? '⏳' : '安装'}
                        </button>
                      )}
                      <span style={styles.rating}>⭐ {(skill.rating || 0).toFixed(1)}</span>
                    </div>
                  </div>
                  <div style={styles.cardTags}>
                    {skill.tags?.map(t => <span key={t} style={styles.tag}>{t}</span>)}
                    <span style={{ ...styles.tag, background: SOURCE_LABELS[skill.source || marketSource].bg, color: SOURCE_LABELS[skill.source || marketSource].color }}>
                      {SOURCE_LABELS[skill.source || marketSource].label}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ═══ 详情 ═══ */}
      {selectedSkill && (
        <div style={styles.detailPanel}>
          <div style={styles.detailHeader}>
            <div>
              <div style={styles.detailName}>{selectedSkill.icon || '🧩'} {selectedSkill.name}</div>
              <div style={styles.detailDesc}>{selectedSkill.description}</div>
              <div style={styles.detailMeta}>
                <span>📦 v{selectedSkill.version}</span>
                <span>👤 {selectedSkill.author}</span>
                <span>⭐ {selectedSkill.rating?.toFixed(1)} ({selectedSkill.ratingCount || 0})</span>
                <span>📥 {selectedSkill.downloads || 0}</span>
                <span style={{ background: SOURCE_LABELS[selectedSkill.source || 'local'].bg, color: SOURCE_LABELS[selectedSkill.source || 'local'].color, padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>
                  {SOURCE_LABELS[selectedSkill.source || 'local'].label}
                </span>
              </div>
            </div>
            <button style={styles.closeBtn} onClick={() => setSelectedSkill(null)}>✕</button>
          </div>

          {/* 操作按钮 */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {selectedSkill.installed ? (
              <button style={{ ...styles.actionBtn, background: '#ef5350' }} onClick={() => uninstall(selectedSkill.id)}>🗑️ 卸载</button>
            ) : (
              <button
                style={{ ...styles.actionBtn, background: '#10b981' }}
                onClick={() => install(selectedSkill.id)}
                disabled={installing === selectedSkill.id}
              >{installing === selectedSkill.id ? '⏳ 安装中' : '📥 安装'}</button>
            )}
            {selectedSkill.installed && (
              <button
                style={{ ...styles.actionBtn, background: selectedSkill.enabled ? '#ef5350' : '#10b981' }}
                onClick={() => toggleEnable(selectedSkill.id, !selectedSkill.enabled)}
              >{selectedSkill.enabled ? '禁用' : '启用'}</button>
            )}
          </div>

          {/* 标签 */}
          <div style={{ display: 'flex', gap: 4, marginTop: 10, flexWrap: 'wrap' as const }}>
            {selectedSkill.tags?.map((t: string) => <span key={t} style={styles.tag}>{t}</span>)}
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 样式 (v2.17: 白色主题 → v1.1: CSS 变量支持暗色)
// ═══════════════════════════════════════════════════════════

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, height: '100%', overflow: 'auto', background: 'var(--surface-0)', color: 'var(--text-primary)', fontFamily: 'system-ui' },
  header: { marginBottom: 16 },
  title: { fontSize: 20, margin: 0, fontWeight: 700 },
  subtitle: { fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 12px' },
  tabs: { display: 'flex', gap: 8, marginBottom: 12 },
  tabBtn: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border-light)', cursor: 'pointer', fontSize: 13, background: 'var(--surface-100)', color: 'var(--text-secondary)' },
  tabActive: { background: 'var(--accent-500)', color: '#fff', fontWeight: 600 },
  notification: { padding: '8px 14px', borderRadius: 8, background: 'var(--green-100)', color: 'var(--green-700)', fontSize: 13, marginBottom: 12 },
  list: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 },
  empty: { textAlign: 'center' as const, padding: 40, color: 'var(--text-secondary)' },
  card: { padding: 12, borderRadius: 10, background: 'var(--surface-100)', cursor: 'pointer', border: '2px solid #e5e7eb', transition: 'border 0.2s' },
  cardSelected: { border: '2px solid #6366f1' },
  cardTop: { display: 'flex', alignItems: 'center', gap: 10 },
  cardIcon: { fontSize: 24 },
  cardInfo: { flex: 1, minWidth: 0 },
  cardName: { fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 },
  versionBadge: { fontSize: 10, background: 'var(--border-light)', color: 'var(--text-primary)', padding: '1px 6px', borderRadius: 4 },
  disabledBadge: { fontSize: 10, background: '#ef5350', color: '#fff', padding: '1px 6px', borderRadius: 4 },
  installedBadge: { fontSize: 10, background: '#10b981', color: '#fff', padding: '1px 6px', borderRadius: 4 },
  cardDesc: { fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  cardActions: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  cardTags: { display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' as const },
  tag: { fontSize: 10, background: 'var(--border-light)', color: 'var(--text-secondary)', padding: '2px 7px', borderRadius: 10 },
  smallBtn: { padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-light)', cursor: 'pointer', fontSize: 11, background: 'var(--border-light)', color: 'var(--text-primary)' },
  importBtn: { padding: '10px 20px', borderRadius: 8, border: '2px dashed #d1d5db', cursor: 'pointer', fontSize: 13, background: 'var(--surface-100)', color: 'var(--text-primary)', marginTop: 8 },
  searchBar: { display: 'flex', gap: 8, marginBottom: 12 },
  searchInput: { flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-light)', background: 'var(--surface-100)', color: 'var(--text-primary)', fontSize: 13, outline: 'none' },
  categorySelect: { padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-light)', background: 'var(--surface-100)', color: 'var(--text-primary)', fontSize: 13 },
  searchBtn: { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, background: '#6366f1', color: '#fff' },
  installBtn: { padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, background: '#10b981', color: '#fff' },
  rating: { fontSize: 12, color: '#f59e0b' },
  detailPanel: { marginTop: 16, padding: 16, borderRadius: 12, background: 'var(--surface-100)', border: '1px solid var(--border-light)' },
  detailHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  closeBtn: { padding: '4px 8px', border: 'none', cursor: 'pointer', fontSize: 16, background: 'transparent', color: 'var(--text-secondary)' },
  detailName: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' },
  detailDesc: { fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 },
  detailMeta: { display: 'flex', gap: 16, marginTop: 12, fontSize: 12, color: 'var(--text-secondary)', alignItems: 'center' },
  actionBtn: { padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, color: '#fff' },
  sourceBtn: { padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border-light)', cursor: 'pointer', fontSize: 12, background: 'var(--surface-100)', color: 'var(--text-primary)' },
  sourceBtnActive: { background: '#6366f1', color: '#fff', borderColor: '#6366f1' },
}
