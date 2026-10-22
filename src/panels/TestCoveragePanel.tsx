// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// panels/TestCoveragePanel.tsx — 测试覆盖体系 v1.0
//
// 展示代码测试覆盖情况、运行测试、查看结果
// 集成 Jest 测试运行器
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'

interface TestSummary {
  total: number
  passed: number
  failed: number
  skipped: number
  coverage: number
  duration: number
  suites: Array<{
    name: string
    passed: number
    failed: number
    total: number
    coverage: number
  }>
}

export default function TestCoveragePanel() {
  const [summary, setSummary] = useState<TestSummary | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<string>('')
  const [autoRun, setAutoRun] = useState(false)

  const loadSummary = useCallback(async () => {
    try {
      const s = await window.luminaAPI?.testSummary?.()
      if (s) {setSummary((s as any)?.summary ?? s as any)}
    } catch {}
  }, [])

  useEffect(() => { loadSummary() }, [loadSummary])

  const handleRun = async () => {
    setRunning(true)
    setResult('')
    try {
      const res = await window.luminaAPI?.testRun?.()
      if (res) {
        setSummary((res as any).summary)
        setResult((res as any).output || '')
      }
    } catch (e) {
      setResult(String(e))
    }
    setRunning(false)
  }

  const coverageColor = (pct: number) => {
    if (pct >= 80) {return '#10b981'}
    if (pct >= 50) {return '#f59e0b'}
    return '#ef4444'
  }

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>🧪 测试覆盖体系</h2>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            运行测试、查看覆盖率、确保代码质量
          </p>
        </div>
        <button onClick={handleRun} disabled={running} style={{
          padding: '8px 20px', borderRadius: 6, border: 'none',
          background: running ? '#d1d5db' : '#10b981', color: '#fff',
          cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
        }}>{running ? '⏳ 运行中...' : '▶ 运行测试'}</button>
      </div>

      {/* ── 概览卡片 ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16,
      }}>
        {[
          { label: '测试总数', value: summary?.total ?? 0, color: '#6b7280' },
          { label: '通过', value: summary?.passed ?? 0, color: '#10b981' },
          { label: '失败', value: summary?.failed ?? 0, color: '#ef4444' },
          { label: '覆盖率', value: summary?.coverage ? `${summary.coverage}%` : '--', color: coverageColor(summary?.coverage ?? 0) },
        ].map(item => (
          <div key={item.label} style={{
            padding: 16, borderRadius: 8, textAlign: 'center',
            background: 'var(--surface-0)', border: '1px solid var(--border-light)',
          }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: item.color }}>{item.value}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{item.label}</div>
          </div>
        ))}
      </div>

      {/* ── 测试套件列表 ── */}
      {summary && summary.suites.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>测试套件</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {summary.suites.map(suite => (
              <div key={suite.name} style={{
                padding: '8px 12px', borderRadius: 6,
                background: 'var(--surface-0)', border: '1px solid var(--border-light)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{suite.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {suite.passed}/{suite.total} 通过
                    {suite.failed > 0 && <span style={{ color: '#ef4444' }}> · {suite.failed} 失败</span>}
                  </div>
                </div>
                <div style={{
                  width: 60, height: 6, borderRadius: 3,
                  background: 'var(--border-light)', overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${suite.coverage}%`, height: '100%',
                    background: coverageColor(suite.coverage),
                    borderRadius: 3, transition: 'width 0.5s',
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 运行输出 ── */}
      {result && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>运行输出</div>
          <pre style={{
            padding: 12, borderRadius: 8, fontSize: 10, lineHeight: 1.6,
            background: '#1e1e2e', color: '#cdd6f4', overflow: 'auto',
            maxHeight: 400,
          }}>{result}</pre>
        </div>
      )}

      {/* ── 空状态 ── */}
      {!summary && !running && (
        <div style={{
          textAlign: 'center', padding: 60, color: 'var(--text-secondary)',
          background: 'var(--surface-0)', borderRadius: 12,
        }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🧪</div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>尚未运行测试</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>点击「运行测试」开始</div>
        </div>
      )}

      {/* ── 测试建议 ── */}
      <div style={{
        marginTop: 16, padding: 12, borderRadius: 8,
        background: 'var(--yellow-50)', border: '1px solid #f59e0b', fontSize: 11,
      }}>
        <div style={{ color: '#92400e', marginBottom: 4, fontWeight: 600 }}>💡 测试建议</div>
        <div style={{ color: '#b45309', lineHeight: 1.6 }}>
          • 建议覆盖率达到 80% 以上<br />
          • 每次新增功能时同步编写测试<br />
          • 运行测试前确保已安装依赖：npm install<br />
          • 测试配置文件位于项目根目录 jest.config.js
        </div>
      </div>
    </div>
  )
}
