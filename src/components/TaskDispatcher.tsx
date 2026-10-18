// ============================================================
// components/TaskDispatcher.tsx — 团队任务派发中心
//
// 功能：
//   1. 展示 7 种任务类型卡片（对应 Lumina Agent 的 7 个角色）
//   2. 选择任务类型后，展示可选的执行者（团队成员）
//   3. 支持"自动分配"和"手动指定"两种模式
//   4. 确认派发后，将任务发送到群聊并路由给指定 Agent
//   5. 挂载/卸载带 opacity + translateY 淡入淡出（CSS animation，见 app.css）
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { IconClipboard } from './Icons'
import {
  TASK_TYPE_CARDS,
  TEAM_MEMBERS,
  TaskType,
  getRecommendedAgent,
  getAvailableAgents,
} from '../data/agentRoles'

interface TaskDispatcherProps {
  onDispatch: (taskType: TaskType, agentId: string, prompt: string) => void
  onClose: () => void
}

export default function TaskDispatcher({ onDispatch, onClose }: TaskDispatcherProps) {
  const [selectedType, setSelectedType] = useState<TaskType | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<string>('auto')
  const [customPrompt, setCustomPrompt] = useState('')
  // 卸载由父组件控制，所以关闭时先播 exit 动画，结束后才真正通知父组件卸载
  const [exiting, setExiting] = useState(false)
  const closedRef = useRef(false)

  const requestClose = useCallback(() => { setExiting(true) }, [])

  const finishClose = useCallback(() => {
    if (closedRef.current) { return }
    closedRef.current = true
    onClose()
  }, [onClose])

  // 兜底：动画被 prefers-reduced-motion 关掉、或某些环境不派发 animationend 时仍能关闭
  useEffect(() => {
    if (!exiting) { return }
    const t = setTimeout(finishClose, 320)
    return () => clearTimeout(t)
  }, [exiting, finishClose])

  const handleOverlayAnimEnd = (e: React.AnimationEvent<HTMLDivElement>) => {
    // 只在退场时才关闭：入场动画结束同样会派发 animationend，否则弹窗会被打开后立刻关掉
    if (!exiting) { return }
    if (e.target !== e.currentTarget) { return } // 只认遮罩层自己的动画，忽略卡片冒泡上来的
    finishClose()
  }

  const selectedCard = selectedType ? TASK_TYPE_CARDS.find(c => c.id === selectedType) : null
  const recommendedAgent = selectedType ? TEAM_MEMBERS.find(m => m.id === getRecommendedAgent(selectedType)) : null

  const handleDispatch = () => {
    if (!selectedType) {return}

    const agentId = selectedAgent === 'auto'
      ? getRecommendedAgent(selectedType)
      : selectedAgent

    const prompt = customPrompt || selectedCard?.quickPrompts[0] || ''

    onDispatch(selectedType, agentId, prompt)
    requestClose()
  }

  return (
    <div
      className={`task-dispatcher-overlay${exiting ? ' is-exiting' : ''}`}
      onAnimationEnd={handleOverlayAnimEnd}
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) {requestClose()} }}
    >
      <div className="task-dispatcher-card" style={{
        background: 'white',
        borderRadius: 14,
        padding: 18,
        width: 440,
        maxHeight: '85vh',
        overflow: 'auto',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {/* ═══ 标题栏 ═══ */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-lg)', display: 'flex', alignItems: 'center', gap: 6 }}><IconClipboard size={17} />任务派发中心</h3>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginTop: 2 }}>选择任务类型 → 选择执行者 → 一键派发</div>
          </div>
          <button
            onClick={requestClose}
            style={{
              width: 28, height: 28, borderRadius: 6,
              border: 'none', background: 'var(--surface-200)',
              cursor: 'pointer', fontSize: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>

        {/* ═══ 步骤1：选择任务类型 ═══ */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            ① 选择任务类型
          </div>
          {/* 两行布局：上4下3，居中对齐 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            {/* 任务卡片：4+3 居中，OtterLife 马卡龙风格 */}
            {[0, 4].map(startIdx => (
              <div key={startIdx} style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                {TASK_TYPE_CARDS.slice(startIdx, startIdx === 0 ? 4 : 7).map(card => (
                  <div
                    key={card.id}
                    onClick={() => { setSelectedType(card.id); setSelectedAgent('auto'); setCustomPrompt('') }}
                    style={{
                      width: 92,
                      padding: '12px 6px',
                      borderRadius: 16,
                      border: selectedType === card.id
                        ? `2px solid ${card.color}`
                        : '2px solid #F0ECF9',
                      background: selectedType === card.id
                        ? `linear-gradient(135deg, ${card.color}10 0%, ${card.color}20 100%)`
                        : '#FAFAFF',
                      cursor: 'pointer',
                      textAlign: 'center',
                      transition: 'all 0.2s',
                    }}
                  >
                    <div style={{ fontSize: 22 }}>{card.icon}</div>
                    <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, marginTop: 4, color: selectedType === card.id ? card.color : 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                      {card.name}
                    </div>
                    <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--text-secondary)', marginTop: 2, whiteSpace: 'nowrap' }}>
                      {card.desc.split('、')[0]}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* ═══ 步骤2：选择执行者（选择任务类型后显示） ═══ */}
        {selectedType && selectedCard && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              ② 选择执行者
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {/* 自动分配按钮 */}
              <div
                onClick={() => setSelectedAgent('auto')}
                style={{
                  padding: '8px 14px',
                  borderRadius: 20,
                  border: selectedAgent === 'auto'
                    ? '2px solid #7c5cfc'
                    : '2px solid #F0ECF9',
                  background: selectedAgent === 'auto' ? '#7c5cfc15' : '#FAFAFF',
                  cursor: 'pointer',
                  fontSize: 'var(--font-size-sm)',
                  fontWeight: selectedAgent === 'auto' ? 600 : 400,
                  color: selectedAgent === 'auto' ? 'var(--accent, #7c5cfc)' : 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  transition: 'all 0.15s',
                }}
              >
                🤖 自动分配
              </div>

              {/* 团队成员按钮 */}
              {getAvailableAgents(selectedType).map(member => (
                <div
                  key={member.id}
                  onClick={() => setSelectedAgent(member.id)}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 20,
                    border: selectedAgent === member.id
                      ? `2px solid ${member.color}`
                      : '2px solid #F0ECF9',
                    background: selectedAgent === member.id
                      ? `linear-gradient(135deg, ${member.color}08 0%, ${member.color}15 100%)`
                      : '#FAFAFF',
                    cursor: 'pointer',
                    fontSize: 'var(--font-size-sm)',
                    fontWeight: selectedAgent === member.id ? 600 : 400,
                    color: selectedAgent === member.id ? member.color : 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    transition: 'all 0.15s',
                  }}
                >
                  {member.icon} {member.name}
                </div>
              ))}
            </div>

            {/* 推荐说明 */}
            {selectedAgent === 'auto' && recommendedAgent && (
              <div style={{
                fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginTop: 8,
                padding: '7px 12px',
                background: '#FAFAFF',
                borderRadius: 8,
                border: '1px solid #F0ECF9',
              }}>
                💡 系统将自动选择最合适的团队成员：
                <span style={{ fontWeight: 600, color: recommendedAgent.color }}>
                  {recommendedAgent.icon} {recommendedAgent.name}
                </span>
              </div>
            )}
          </div>
        )}

        {/* ═══ 步骤3：自定义任务描述（可选） ═══ */}
        {selectedType && selectedCard && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              ③ 任务描述 <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', fontWeight: 400 }}>（可选）</span>
            </div>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder={`例如：${selectedCard.quickPrompts[0]}`}
              style={{
                width: '100%',
                height: 56,
                padding: 10,
                borderRadius: 10,
                border: '1.5px solid #F0ECF9',
                background: '#FAFAFF',
                resize: 'none',
                fontSize: 'var(--font-size-base)',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
                outline: 'none',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#7c5cfc50' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#F0ECF9' }}
            />
            {/* 快捷提问 */}
            <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
              {selectedCard.quickPrompts.map((prompt, i) => (
                <span
                  key={i}
                  onClick={() => setCustomPrompt(prompt)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 14,
                    background: customPrompt === prompt ? `${selectedCard.color}15` : '#F0ECF9',
                    border: customPrompt === prompt ? `1.5px solid ${selectedCard.color}40` : '1.5px solid transparent',
                    fontSize: 'var(--font-size-xs)',
                    cursor: 'pointer',
                    color: customPrompt === prompt ? selectedCard.color : 'var(--text-secondary)',
                    transition: 'all 0.15s',
                  }}
                >
                  {prompt}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ═══ 派发按钮 ═══ */}
        <button
          onClick={handleDispatch}
          disabled={!selectedType}
          style={{
            width: '100%',
            padding: '12px 0',
            borderRadius: 12,
            border: 'none',
            background: selectedType
              ? 'linear-gradient(135deg, #7c5cfc 0%, #a78bfa 100%)'
              : 'var(--border-light)',
            color: selectedType ? 'white' : 'var(--text-secondary)',
            fontSize: 'var(--font-size-lg)',
            fontWeight: 600,
            cursor: selectedType ? 'pointer' : 'not-allowed',
            transition: 'all 0.2s',
            boxShadow: selectedType ? '0 4px 16px rgba(124,92,252,0.35)' : 'none',
          }}
        >
          🚀 派发任务
        </button>
      </div>
    </div>
  )
}
