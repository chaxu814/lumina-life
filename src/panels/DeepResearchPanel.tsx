// ============================================================
// panels/DeepResearchPanel.tsx — 深度调研面板 (v3.11 → v2.17 白色主题)
// ============================================================

import React, { useState } from 'react'

export default function DeepResearchPanel() {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [report, setReport] = useState<any>(null)
  const [markdown, setMarkdown] = useState('')

  const startResearch = async () => {
    if (!question.trim()) {return}
    setLoading(true)
    setReport(null)
    setMarkdown('')
    setProgress('🔍 启动深度调研...')

    try {
      const result = await (window as any).electron.ipcRenderer.invoke('deep-research:start', question)
      if (result.success) {
        setReport(result.report)
        setMarkdown(result.markdown)
        setProgress('✅ 完成！')
      } else {
        setProgress('❌ ' + (result.error || '调研失败'))
      }
    } catch (err: any) {
      setProgress('❌ ' + err.message)
    }
    setLoading(false)
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>🔬 Deep Research</h2>
        <p style={styles.subtitle}>多轮搜索 → 交叉验证 → 结构化报告</p>
      </div>

      {/* 输入 */}
      <div style={styles.inputArea}>
        <textarea
          style={styles.textarea}
          placeholder="输入你想深入研究的问题...
例如：2025年AI Agent行业的发展趋势是什么？"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startResearch() }
          }}
          rows={3}
        />
        <button
          style={{ ...styles.searchBtn, opacity: loading ? 0.6 : 1 }}
          onClick={startResearch}
          disabled={loading}
        >
          {loading ? '⏳ 研究中...' : '🔍 开始研究'}
        </button>
      </div>

      {/* 进度 */}
      {progress && (
        <div style={styles.progress}>
          {progress}
        </div>
      )}

      {/* 报告 */}
      {report && (
        <div style={styles.reportContainer}>
          {/* 概览 */}
          <div style={styles.overview}>
            <div style={styles.stat}>
              <span style={styles.statLabel}>置信度</span>
              <span style={styles.statValue}>{(report.confidence * 100).toFixed(0)}%</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>发现</span>
              <span style={styles.statValue}>{report.findings.length}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>来源</span>
              <span style={styles.statValue}>{report.sources.length}</span>
            </div>
            <div style={styles.stat}>
              <span style={styles.statLabel}>耗时</span>
              <span style={styles.statValue}>{(report.durationMs / 1000).toFixed(1)}s</span>
            </div>
          </div>

          {/* 摘要 */}
          <div style={styles.section}>
            <h3>📝 摘要</h3>
            <p style={styles.summary}>{report.summary}</p>
          </div>

          {/* 关键发现 */}
          {report.keyInsights.length > 0 && (
            <div style={styles.section}>
              <h3>🔑 关键发现</h3>
              {report.keyInsights.map((insight: string, i: number) => (
                <div key={i} style={styles.insight}>
                  <span style={styles.insightNum}>{i + 1}</span>
                  {insight}
                </div>
              ))}
            </div>
          )}

          {/* 详细发现 */}
          <div style={styles.section}>
            <h3>📊 详细发现</h3>
            {report.findings.map((f: any, i: number) => (
              <div key={i} style={styles.finding}>
                <div style={styles.findingHeader}>
                  <span style={{
                    ...styles.consensusBadge,
                    background: f.consensus === 'confirmed' ? '#166534' : f.consensus === 'disputed' ? '#991b1b' : '#9a3412',
                  }}>
                    {f.consensus === 'confirmed' ? '✅ 已确认' : f.consensus === 'disputed' ? '⚠️ 有争议' : '📌 待验证'}
                  </span>
                  <span style={styles.confidenceBadge}>置信度 {(f.confidence * 100).toFixed(0)}%</span>
                </div>
                <p style={styles.findingText}>{f.claim}</p>
                <div style={styles.sourceList}>
                  {f.sources?.map((s: any, j: number) => (
                    <a key={j} href={s.url} target="_blank" style={styles.sourceLink}>
                      {s.domain} ⭐{s.credibility}
                    </a>
                  ))}
                </div>
                {f.conflictingSources?.length > 0 && (
                  <div style={styles.conflictWarning}>
                    ⚠️ 以下来源持不同观点：
                    {f.conflictingSources.map((s: any, j: number) => (
                      <a key={j} href={s.url} target="_blank" style={styles.conflictLink}>{s.domain}</a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 所有来源 */}
          <div style={styles.section}>
            <h3>📚 所有来源 ({report.sources.length})</h3>
            {report.sources.map((s: any, i: number) => (
              <div key={i} style={styles.sourceItem}>
                <span style={{ ...styles.credibilityDot, background: s.credibility >= 7 ? '#16a34a' : s.credibility >= 5 ? '#ea580c' : '#dc2626' }} />
                <a href={s.url} target="_blank" style={styles.sourceLink}>{s.title}</a>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>⭐{s.credibility}</span>
              </div>
            ))}
          </div>

          {/* Markdown 全文 */}
          {markdown && (
            <div style={styles.section}>
              <h3>📄 完整报告</h3>
              <pre style={styles.markdown}>{markdown}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// 样式 (v2.17: 白色主题)
// ═══════════════════════════════════════════════════════════

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, height: '100%', overflow: 'auto', background: 'var(--surface-0)', color: 'var(--text-primary)', fontFamily: 'system-ui' },
  header: { marginBottom: 16 },
  title: { fontSize: 20, margin: 0, fontWeight: 700 },
  subtitle: { fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' },
  inputArea: { display: 'flex', gap: 8, marginBottom: 12, alignItems: 'flex-end' },
  textarea: { flex: 1, padding: 12, borderRadius: 10, border: '1px solid var(--border-light)', background: 'var(--surface-100)', color: 'var(--text-primary)', fontSize: 14, resize: 'vertical' as const, outline: 'none' },
  searchBtn: { padding: '10px 24px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, background: '#6366f1', color: '#fff', whiteSpace: 'nowrap' as const },
  progress: { padding: '8px 14px', borderRadius: 8, background: '#eef2ff', color: '#6366f1', fontSize: 13, marginBottom: 12 },
  reportContainer: { overflow: 'auto' },
  overview: { display: 'flex', gap: 10, marginBottom: 16 },
  stat: { padding: '10px 20px', borderRadius: 10, background: 'var(--border-light)', textAlign: 'center' as const, minWidth: 80 },
  statLabel: { display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 },
  statValue: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' },
  section: { marginBottom: 16 },
  summary: { fontSize: 14, lineHeight: 1.6, color: 'var(--text-primary)', background: 'var(--surface-100)', padding: 14, borderRadius: 10 },
  insight: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-light)', fontSize: 13, lineHeight: 1.5 },
  insightNum: { background: '#6366f1', color: '#fff', borderRadius: '50%', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 },
  finding: { padding: 14, borderRadius: 10, background: 'var(--surface-100)', marginBottom: 10 },
  findingHeader: { display: 'flex', gap: 8, marginBottom: 8 },
  consensusBadge: { fontSize: 11, padding: '2px 8px', borderRadius: 10, color: '#fff' },
  confidenceBadge: { fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'var(--border-light)', color: 'var(--text-primary)' },
  findingText: { fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)', margin: '8px 0' },
  sourceList: { display: 'flex', gap: 8, flexWrap: 'wrap' as const, marginTop: 6 },
  sourceLink: { fontSize: 11, color: '#6366f1', textDecoration: 'none' },
  conflictWarning: { fontSize: 11, color: '#dc2626', marginTop: 8, padding: 8, background: 'var(--red-100)', borderRadius: 6 },
  conflictLink: { fontSize: 11, color: '#dc2626', marginLeft: 6 },
  sourceItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 },
  credibilityDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  markdown: { background: 'var(--surface-100)', color: 'var(--text-primary)', padding: 16, borderRadius: 8, fontSize: 12, overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap' as const, border: '1px solid var(--border-light)' },
}
