// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// components/ConversationSummary.tsx — 「对话摘要」侧边栏（v03）
//
// 对标豆包桌面端右侧「对话摘要」：自上而下六层
//   对话产物 / 对话资源 / 子智能体 / 任务规划 / 技能 / 最近文件
//
// 数据全部从 taskWorkspaceStore 真实状态派生（见 store 里的纯函数），
// 不写死假数据；每层无数据时显示「暂无内容」。
// ============================================================

import React, { useState } from 'react'
import {
  useTaskWorkspace,
  deriveConversationArtifacts,
  deriveConversationResources,
  deriveRecentFiles,
  deriveTaskPlan,
  deriveUsedSkills,
  deriveSubagentList,
  artifactIconKey,
  detectArtifactKind,
} from '../stores/taskWorkspaceStore'
import type { ArtifactItem, SubagentItem } from '../stores/taskWorkspaceStore'

/** 按产物类型渲染图标（md=M 徽标，html=<> 等） */
function ArtifactIcon({ artifact }: { artifact: ArtifactItem }) {
  const kind = artifact.kind ?? detectArtifactKind(artifact.filename, artifact.content)
  const key = artifactIconKey(kind, artifact.filename)
  if (key === 'md') {
    return <span className="tw-sum-icon tw-sum-icon-md">M</span>
  }
  if (key === 'html') {
    return <span className="tw-sum-icon tw-sum-icon-html">&lt;/&gt;</span>
  }
  if (key === 'image') {
    return <span className="tw-sum-icon tw-sum-icon-img">🖼</span>
  }
  if (key === 'pdf') {
    return <span className="tw-sum-icon tw-sum-icon-pdf">PDF</span>
  }
  if (key === 'json') {
    return <span className="tw-sum-icon tw-sum-icon-json">{ '{ }' }</span>
  }
  if (key === 'code') {
    return <span className="tw-sum-icon tw-sum-icon-code">&lt;/&gt;</span>
  }
  return <span className="tw-sum-icon tw-sum-icon-file">📄</span>
}

/** 一层通用容器：标题行（含右上角 +）+ 内容；空态显示「暂无内容」 */
function Section({
  title,
  action,
  empty = true,
  children,
}: {
  title: string
  action?: React.ReactNode
  empty?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="tw-sum-section">
      <div className="tw-sum-section-head">
        <span className="tw-sum-section-title">{title}</span>
        {action && <span className="tw-sum-section-action">{action}</span>}
      </div>
      {empty ? (
        <div className="tw-sum-empty">暂无内容</div>
      ) : (
        children
      )}
    </div>
  )
}

/** 单个子智能体行：彩色圆点 + 标题，可展开看过程/产出 */
function SubagentRow({ sub }: { sub: SubagentItem }) {
  const [open, setOpen] = useState(false)
  const dotClass =
    sub.status === 'running' ? 'running'
    : sub.status === 'done' ? 'done'
    : sub.status === 'error' ? 'error'
    : 'idle'
  const hasDetail = !!(sub.result || sub.error)
  return (
    <div className="tw-sum-sub">
      <div
        className="tw-sum-sub-row"
        onClick={() => hasDetail && setOpen((o) => !o)}
        style={{ cursor: hasDetail ? 'pointer' : 'default' }}
      >
        <span className={`tw-sum-sub-dot ${dotClass}`} />
        <span className="tw-sum-sub-title">{sub.title || sub.internName || '子任务'}</span>
        {hasDetail && <span className="tw-sum-sub-chevron">{open ? '▾' : '▸'}</span>}
      </div>
      {open && hasDetail && (
        <div className="tw-sum-sub-detail">
          {sub.error ? (
            <div className="tw-sum-sub-err">❌ {sub.error}</div>
          ) : (
            <div className="tw-sum-sub-result">{sub.result || '已完成'}</div>
          )}
        </div>
      )}
    </div>
  )
}

const ConversationSummary: React.FC = () => {
  const artifacts = useTaskWorkspace((s) => s.artifacts)
  const setActiveArtifact = useTaskWorkspace((s) => s.setActiveArtifact)
  const subagents = useTaskWorkspace((s) => s.subagents)
  const tasks = useTaskWorkspace((s) => s.tasks)
  const board = useTaskWorkspace((s) => s.board)
  const toolCalls = useTaskWorkspace((s) => s.toolCalls)

  const docArtifacts = deriveConversationArtifacts(artifacts)
  const resources = deriveConversationResources(artifacts)
  const recentFiles = deriveRecentFiles(artifacts)
  const plan = deriveTaskPlan(board)
  const skills = deriveUsedSkills(toolCalls)
  const subagentList = deriveSubagentList(subagents, tasks)

  const openArtifact = (id: string) => setActiveArtifact(id)

  return (
    <div className="tw-summary">
      {/* 对话产物 */}
      <Section title="对话产物" action={<span className="tw-sum-plus">＋</span>} empty={docArtifacts.length === 0}>
        <div className="tw-sum-list">
          {docArtifacts.map((a) => (
            <div key={a.id} className="tw-sum-row" onClick={() => openArtifact(a.id)} title={a.filename}>
              <ArtifactIcon artifact={a} />
              <span className="tw-sum-row-name">{a.filename}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 对话资源 */}
      <Section title="对话资源" empty={resources.length === 0}>
        <div className="tw-sum-list">
          {resources.map((a) => (
            <div key={a.id} className="tw-sum-row" onClick={() => openArtifact(a.id)} title={a.filename}>
              {a.dataUrl
                ? <img className="tw-sum-thumb" src={a.dataUrl} alt={a.filename} />
                : <ArtifactIcon artifact={a} />}
              <span className="tw-sum-row-name">{a.filename}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 子智能体 */}
      <Section title="子智能体" empty={subagentList.length === 0}>
        <div className="tw-sum-list">
          {subagentList.map((sub) => (
            <SubagentRow key={sub.id} sub={sub} />
          ))}
        </div>
      </Section>

      {/* 任务规划 */}
      <Section title="任务规划" empty={plan.length === 0}>
        <div className="tw-sum-list">
          {plan.map((item) => (
            <div key={item.id} className="tw-sum-row tw-sum-plan">
              <span className={`tw-sum-plan-marker ${item.status}`}>
                {item.status === 'done' ? '✓' : '•'}
              </span>
              <span className="tw-sum-row-name">{item.text}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 技能 */}
      <Section title="技能" empty={skills.length === 0}>
        <div className="tw-sum-skills">
          {skills.map((s) => (
            <span key={s} className="tw-sum-skill-chip">{s}</span>
          ))}
        </div>
      </Section>

      {/* 最近文件 */}
      <Section title="最近文件" empty={recentFiles.length === 0}>
        <div className="tw-sum-list">
          {recentFiles.map((a) => (
            <div key={a.id} className="tw-sum-row" onClick={() => openArtifact(a.id)} title={a.filePath}>
              <ArtifactIcon artifact={a} />
              <span className="tw-sum-row-name">{a.filename}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}

export default ConversationSummary
