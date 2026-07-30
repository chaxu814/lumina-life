import React, { useState } from 'react'
import { useStore, type CronTask } from '../stores/appStore'
import { IconPlus, IconPlay, IconPause, IconTrash, IconCheck } from '../components/Icons'

// 人性化 Cron 预设
const CRON_PRESETS = [
  { label: '每分钟', cron: '* * * * *', desc: '不间断执行' },
  { label: '每5分钟', cron: '*/5 * * * *', desc: '高频检查' },
  { label: '每小时', cron: '0 * * * *', desc: '每小时整点' },
  { label: '每天早上 7:00', cron: '0 7 * * *', desc: '早晨提醒' },
  { label: '每天早上 8:00', cron: '0 8 * * *', desc: '早间推送' },
  { label: '每天中午 12:00', cron: '0 12 * * *', desc: '午间执行' },
  { label: '每天晚上 18:00', cron: '0 18 * * *', desc: '晚间简报' },
  { label: '每天晚上 22:00', cron: '0 22 * * *', desc: '睡前总结' },
  { label: '工作日早上 9:00', cron: '0 9 * * 1-5', desc: '仅周一至周五' },
  { label: '每周一早上 8:00', cron: '0 8 * * 1', desc: '每周报告' },
  { label: '每周五晚上 18:00', cron: '0 18 * * 5', desc: '周报生成' },
  { label: '每月 1 日 0:00', cron: '0 0 1 * *', desc: '月度任务' },
]

export default function TasksPanel({ embedded }: { embedded?: boolean } = {}) {
  const cronTasks = useStore((s) => s.cronTasks)
  const addCronTask = useStore((s) => s.addCronTask)
  const removeCronTask = useStore((s) => s.removeCronTask)
  const toggleCronTask = useStore((s) => s.toggleCronTask)
  const addAuditLog = useStore((s) => s.addAuditLog)

  const [form, setForm] = useState({ name: '', cron: '', action: '' })
  const [selectedPreset, setSelectedPreset] = useState('')
  const [formError, setFormError] = useState('')

  const handlePresetSelect = (cron: string) => {
    setSelectedPreset(cron)
    setForm({ ...form, cron })
    setFormError('')
  }

  const handleCreate = () => {
    if (!form.name.trim()) { setFormError('请输入任务名称'); return }
    if (!form.cron.trim()) { setFormError('请选择或输入 Cron 表达式'); return }
    if (!form.action.trim()) { setFormError('请输入任务指令'); return }

    const task: CronTask = {
      id: 'task-' + Date.now(),
      name: form.name.trim(),
      schedule: form.cron.trim(),
      action: form.action.trim(),
      enabled: true,
      type: 'cron',
      nextRun: '计算中…',
    }
    addCronTask(task)
    addAuditLog({
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      action: `✅ 创建任务 — ${task.name} (${task.schedule})`,
      type: 'system',
    })
    setForm({ name: '', cron: '', action: '' })
    setSelectedPreset('')
    setFormError('')
  }

  const handleToggle = (task: CronTask) => {
    toggleCronTask(task.id)
    addAuditLog({
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      action: `${task.enabled ? '⏸ 暂停' : '▶ 恢复'}任务 — ${task.name}`,
      type: 'system',
    })
  }

  const handleDelete = (task: CronTask) => {
    removeCronTask(task.id)
    addAuditLog({
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      action: `🗑 删除任务 — ${task.name}`,
      type: 'system',
    })
  }

  const renderContent = () => (
    <div>
      {!embedded && (
        <div className="panel-header">
          <div className="panel-title">⏰ 定时任务</div>
          <div className="panel-subtitle">{cronTasks.length} 个任务 · Cron 定时调度</div>
        </div>
      )}

      {/* 已有任务列表 */}
      {cronTasks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
          {cronTasks.map((task) => (
            <div key={task.id} className="card" style={{ padding: '12px 18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: task.enabled ? 'var(--green-500)' : 'var(--text-disabled)' }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{task.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
                      {task.schedule} · {task.action}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {task.nextRun && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{task.nextRun}</span>}
                  <button className="btn btn-ghost btn-xs" onClick={() => handleToggle(task)} title={task.enabled ? '暂停' : '启动'}>
                    {task.enabled ? <IconPause size={14} /> : <IconPlay size={14} />}
                  </button>
                  <button className="btn btn-ghost btn-xs" onClick={() => handleDelete(task)} title="删除">
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新建任务 + Cron 参考 */}
      <div className="card-grid card-grid-2">
        {/* Cron 人性化预设 */}
        <div className="card">
          <div className="card-header">
            <span style={{ fontSize: 16 }}>📅</span>
            <span className="card-title">人性化时间选择</span>
          </div>
          <div className="card-desc">点击即可自动填入 Cron 表达式，无需记忆格式</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CRON_PRESETS.map((p) => (
              <button key={p.cron} onClick={() => handlePresetSelect(p.cron)}
                style={{
                  padding: '6px 12px', borderRadius: 'var(--radius-full)', fontSize: 12, fontWeight: 600,
                  border: `1.5px solid ${selectedPreset === p.cron ? 'var(--accent-500)' : 'var(--border-medium)'}`,
                  background: selectedPreset === p.cron ? 'var(--accent-50)' : 'var(--surface-0)',
                  color: selectedPreset === p.cron ? 'var(--accent-600)' : 'var(--text-secondary)',
                  cursor: 'pointer', transition: 'all var(--transition-fast)', textAlign: 'left',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}
                title={p.desc}
              >
                <span>{p.label}</span>
                <span style={{ fontSize: 10, opacity: 0.6, fontFamily: 'var(--font-mono)' }}>{p.cron}</span>
              </button>
            ))}
          </div>
          <div className="divider" />
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.8 }}>
            <b>Cron 格式：</b>分 时 日 月 周<br />
            <code>*</code> = 任意 &nbsp; <code>*/5</code> = 每5 &nbsp; <code>1-5</code> = 周一到周五
          </div>
        </div>

        {/* 新建任务表单 */}
        <div className="card">
          <div className="card-header">
            <span style={{ fontSize: 16 }}>➕</span>
            <span className="card-title">新建任务</span>
          </div>

          <div className="form-group">
            <label className="form-label">任务名称</label>
            <input className="form-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：每日新闻推送" />
          </div>
          <div className="form-group">
            <label className="form-label">Cron 表达式</label>
            <input className="form-input mono" value={form.cron} onChange={(e) => { setForm({ ...form, cron: e.target.value }); setSelectedPreset('') }} placeholder="例如：0 8 * * * (每天8点)" />
          </div>
          <div className="form-group">
            <label className="form-label">执行指令</label>
            <input className="form-input" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} placeholder="例如：获取最新新闻并推送" />
          </div>
          {formError && <div style={{ color: 'var(--red-500)', fontSize: 12, marginBottom: 10 }}>⚠ {formError}</div>}
          <button className="btn btn-primary btn-sm" onClick={handleCreate}>
            <IconPlus size={14} />创建任务
          </button>
        </div>
      </div>
    </div>
  )

  if (embedded) return renderContent()
  return <div className="panel">{renderContent()}</div>
}
