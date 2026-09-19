// ============================================================
// panels/SkillDevPanel.tsx — 技能开发工作台 v1.0
//
// 提供技能模板生成、导出、文档查看功能
// 让用户可以直接在 Lumina 内创建自定义技能
// ============================================================

import React, { useState } from 'react'

export default function SkillDevPanel() {
  const [skillName, setSkillName] = useState('my_custom_skill')
  const [skillDesc, setSkillDesc] = useState('我的自定义技能')
  const [toolName, setToolName] = useState('my_custom_tool')
  const [author, setAuthor] = useState('')
  const [templateType, setTemplateType] = useState<'basic' | 'advanced'>('basic')
  const [generated, setGenerated] = useState<Record<string, string> | null>(null)
  const [exportMsg, setExportMsg] = useState('')
  const [showHelp, setShowHelp] = useState(false)

  const handleGenerate = async () => {
    setExportMsg('')
    try {
      const result = await window.luminaAPI?.skillSDKGenerate?.({
        skillName: skillName || 'my_skill',
        skillDescription: skillDesc || 'My custom skill',
        toolName: toolName || 'my_tool',
        author: author || 'Anonymous',
        template: templateType,
      })
      if ((result as any)?.files) {
        setGenerated((result as any).files)
      }
    } catch (e) {
      setExportMsg('❌ 生成失败: ' + String(e))
    }
  }

  const handleExport = async () => {
    if (!generated) {return}
    setExportMsg('')
    try {
      const ok = await window.luminaAPI?.skillSDKExport?.(skillName || 'my_skill', generated)
      setExportMsg(ok ? '✅ 已导出到用户数据目录 skill-sdk/' : '❌ 导出失败')
    } catch (e) {
      setExportMsg('❌ 导出失败: ' + String(e))
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db',
    fontSize: 12, boxSizing: 'border-box', marginBottom: 8,
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4, color: 'var(--text-primary)',
  }

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>🔧 技能开发工作台</h2>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            创建属于你自己的 Lumina 技能
          </p>
        </div>
        <button onClick={() => setShowHelp(!showHelp)} style={{
          padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db',
          background: 'var(--surface-0)', cursor: 'pointer', fontSize: 11,
        }}>{showHelp ? '关闭文档' : '📖 SDK 文档'}</button>
      </div>

      {showHelp && (
        <div style={{
          padding: 16, marginBottom: 16, borderRadius: 8,
          background: 'var(--surface-100)', fontSize: 12, lineHeight: 1.8,
          maxHeight: 300, overflowY: 'auto',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>📖 Lumina Skill SDK 快速参考</div>
          <div style={{ color: 'var(--text-secondary)' }}>
            <p><b>1.</b> 填写信息 → 点击生成模板</p>
            <p><b>2.</b> 选择基础（简单）或高级（记忆/事件）模板</p>
            <p><b>3.</b> 点击导出 → 文件生成到 skill-sdk/ 目录</p>
            <p><b>4.</b> 将工具文件拷贝到 <code>electron/tools/impl/</code></p>
            <p><b>5.</b> 在 <code>electron/tools/index.ts</code> 注册</p>
            <hr style={{ margin: '8px 0', border: 'none', borderTop: '1px solid var(--border-light)' }} />
            <p><b>ToolDef 接口：</b> name / description / params / toolsets</p>
            <p><b>可用模块：</b> eventBus, memoryStore, gamification</p>
          </div>
        </div>
      )}

      {/* ── 表单 ── */}
      <div style={{
        padding: 16, borderRadius: 8, marginBottom: 16,
        background: 'var(--surface-0)', border: '1px solid var(--border-light)',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={labelStyle}>技能名称</label>
            <input value={skillName} onChange={e => setSkillName(e.target.value)} placeholder="my_skill" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>工具名称（snake_case）</label>
            <input value={toolName} onChange={e => setToolName(e.target.value)} placeholder="my_tool" style={inputStyle} />
          </div>
        </div>
        <label style={labelStyle}>技能描述</label>
        <input value={skillDesc} onChange={e => setSkillDesc(e.target.value)} placeholder="描述你的技能功能" style={inputStyle} />
        <label style={labelStyle}>作者</label>
        <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="你的名字（可选）" style={inputStyle} />

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
            <input type="radio" checked={templateType === 'basic'} onChange={() => setTemplateType('basic')} /> 基础模板
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
            <input type="radio" checked={templateType === 'advanced'} onChange={() => setTemplateType('advanced')} /> 高级模板（记忆+事件）
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleGenerate} style={{
            padding: '8px 20px', borderRadius: 6, border: 'none',
            background: '#8b5cf6', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
          }}>⚡ 生成模板</button>
          {generated && (
            <button onClick={handleExport} style={{
              padding: '8px 20px', borderRadius: 6, border: '1px solid #d1d5db',
              background: 'var(--surface-100)', cursor: 'pointer', fontSize: 13,
            }}>📦 导出到本地</button>
          )}
        </div>
        {exportMsg && <div style={{ fontSize: 12, marginTop: 8 }}>{exportMsg}</div>}
      </div>

      {/* ── 代码预览 ── */}
      {generated && Object.entries(generated).map(([name, code]) => (
        <div key={name} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: 'var(--text-secondary)' }}>
            📄 {name}
          </div>
          <pre style={{
            padding: 12, borderRadius: 8, fontSize: 10, lineHeight: 1.6,
            background: '#1e1e2e', color: '#cdd6f4', overflowX: 'auto',
            maxHeight: 300, overflowY: 'auto',
          }}>{code}</pre>
        </div>
      ))}
    </div>
  )
}
