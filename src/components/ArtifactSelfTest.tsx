// ============================================================
// components/ArtifactSelfTest.tsx — 产物渲染器 dev-only 自检组件
//
// 仅在 import.meta.env.DEV 时渲染（生产构建 import.meta.env.DEV=false
// 整棵子树被 tree-shake，且所有 fixture 资源均为动态 import，
// 生产 bundle 不包含任何自检代码或示例数据）。
//
// 提供三个按钮：
//   加载示例产物  — 把 8 种合成示例产物加入 taskWorkspaceStore.artifacts
//   逐一预览      — 依次切换 activeArtifactId，每种停留 2s，便于截图
//   清空示例      — 移除所有自检产物
// ============================================================

import React, { useState } from 'react'
import { useTaskWorkspace, detectLanguage, detectArtifactKind } from '../stores/taskWorkspaceStore'
import type { ArtifactItem } from '../stores/taskWorkspaceStore'

/** 自检产物前缀，便于清空时识别 */
const SELFTEST_PREFIX = 'selftest-'

/** 构造一个 ArtifactItem */
function makeItem(
  filename: string,
  content: string,
  opts: { dataUrl?: string; size?: number; mtime?: number } = {},
): ArtifactItem {
  return {
    id: SELFTEST_PREFIX + filename,
    taskId: '__selftest__',
    filename,
    language: detectLanguage(filename),
    content,
    createdAt: Date.now(),
    kind: detectArtifactKind(filename, content),
    size: opts.size ?? content.length,
    mtime: opts.mtime ?? Date.now(),
    ...(opts.dataUrl ? { dataUrl: opts.dataUrl } : {}),
  }
}

const ArtifactSelfTest: React.FC = () => {
  const addArtifact = useTaskWorkspace((s) => s.addArtifact)
  const setActiveArtifact = useTaskWorkspace((s) => s.setActiveArtifact)
  const artifacts = useTaskWorkspace((s) => s.artifacts)
  const [busy, setBusy] = useState(false)

  // 非 dev 环境绝不渲染（生产构建此分支被静态替换为 false）
  if (!import.meta.env.DEV) return null

  /** 加载全部 8 种示例产物（全部动态 import，生产不打包） */
  const loadSamples = async () => {
    setBusy(true)
    try {
      // 文本类 + 二进制 base64：全部动态 import，生产环境不会加载
      const [code, md, json, csv, log, binData] = await Promise.all([
        import('../../tests/fixtures/artifacts/sample-code.ts?raw'),
        import('../../tests/fixtures/artifacts/sample-doc.md?raw'),
        import('../../tests/fixtures/artifacts/sample-data.json?raw'),
        import('../../tests/fixtures/artifacts/sample-table.csv?raw'),
        import('../../tests/fixtures/artifacts/sample-log.txt?raw'),
        import('../../tests/fixtures/artifacts/sample-binary-data'),
      ])
      const { SAMPLE_PNG_B64, SAMPLE_PDF_B64, SAMPLE_BIN_B64 } = binData
      const now = Date.now()
      const items: ArtifactItem[] = [
        makeItem('sample-code.ts', code.default),
        makeItem('sample-doc.md', md.default),
        makeItem('sample-data.json', json.default),
        makeItem('sample-table.csv', csv.default),
        makeItem('sample-log.txt', log.default),
        // 二进制类：dataUrl 直给，走 image/pdf/binary 渲染分支
        makeItem('sample-image.png', '', {
          dataUrl: `data:image/png;base64,${SAMPLE_PNG_B64}`,
          size: Math.round(SAMPLE_PNG_B64.length * 3 / 4),
          mtime: now,
        }),
        makeItem('sample.pdf', '', {
          dataUrl: `data:application/pdf;base64,${SAMPLE_PDF_B64}`,
          size: Math.round(SAMPLE_PDF_B64.length * 3 / 4),
          mtime: now,
        }),
        makeItem('sample-unknown.bin', '', {
          dataUrl: `data:application/octet-stream;base64,${SAMPLE_BIN_B64}`,
          size: Math.round(SAMPLE_BIN_B64.length * 3 / 4),
          mtime: now,
        }),
      ]
      for (const it of items) addArtifact(it)
    } finally {
      setBusy(false)
    }
  }

  /** 逐一预览：依次切换 activeArtifactId，每种停留 2s */
  const cyclePreview = async () => {
    const selftest = artifacts.filter((a) => a.id.startsWith(SELFTEST_PREFIX))
    if (selftest.length === 0) {
      await loadSamples()
    }
    const list = useTaskWorkspace.getState().artifacts.filter((a) => a.id.startsWith(SELFTEST_PREFIX))
    setBusy(true)
    try {
      for (const it of list) {
        setActiveArtifact(it.id)
        // 等待渲染 + 截图时机
        await new Promise((r) => setTimeout(r, 2000))
      }
    } finally {
      setBusy(false)
    }
  }

  /** 清空所有自检产物 */
  const clearSamples = () => {
    const state = useTaskWorkspace.getState()
    const selftestIds = state.artifacts.filter((a) => a.id.startsWith(SELFTEST_PREFIX)).map((a) => a.id)
    for (const id of selftestIds) state.closeArtifact(id)
    // 把激活产物切回 null，避免预览区残留
    if (selftestIds.includes(state.activeArtifactId || '')) state.setActiveArtifact(null)
  }

  return (
    <div className="tw-selftest-bar" style={{
      display: 'flex', gap: 6, padding: '4px 10px',
      borderTop: '1px dashed var(--border-light)',
      background: 'var(--surface-50)', flexShrink: 0,
    }}>
      <span style={{ fontSize: 10, color: 'var(--text-tertiary)', alignSelf: 'center' }}>
        自检(DEV)
      </span>
      <button className="tw-artifact-btn" onClick={loadSamples} disabled={busy}>加载示例产物</button>
      <button className="tw-artifact-btn" onClick={cyclePreview} disabled={busy}>逐一预览</button>
      <button className="tw-artifact-btn" onClick={clearSamples} disabled={busy}>清空示例</button>
    </div>
  )
}

export default ArtifactSelfTest
