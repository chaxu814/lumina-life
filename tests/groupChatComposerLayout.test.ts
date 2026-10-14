import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(
  path.join(process.cwd(), 'src', 'panels', 'GroupChatView.tsx'),
  'utf-8',
)

describe('群聊输入区快捷模型选择布局', () => {
  const composerStart = src.indexOf('ref={gcTextareaRef}')
  const composerEnd = src.indexOf('{/* ── 功能工具栏', composerStart)
  const composer = src.slice(composerStart, composerEnd)

  it('快捷模型选择器紧挨发送按钮左侧，二者同处输入框右下角控件组', () => {
    expect(composerStart).toBeGreaterThan(-1)
    expect(composer).toMatch(/position:\s*'absolute', right:\s*10, bottom:\s*8/)
    expect(composer).toMatch(/<ModelSelector\s*\/>[\s\S]*?aria-label="发送消息"/)
    expect(composer).toMatch(/display:\s*'flex', gap:\s*7, alignItems:\s*'center'/)
    expect(composer).not.toMatch(/position:\s*'absolute', left:\s*10/)
  })

  it('功能工具栏不再重复显示快捷模型选择器', () => {
    const toolbarStart = src.indexOf('{/* ── 功能工具栏')
    const toolbar = src.slice(toolbarStart, toolbarStart + 700)
    expect(toolbar).not.toMatch(/<ModelSelector\s*\/>/)
  })

  it('输入框初始高度稍微加大，并为底部控件留出空间', () => {
    expect(composer).toMatch(/minHeight:\s*72/)
    expect(composer).toMatch(/paddingBottom:\s*40/)
    expect(composer).toMatch(/paddingRight:\s*224/)
  })

  it('发送控件为圆形上箭头，并按是否有草稿切换明暗/禁用状态', () => {
    expect(composer).toMatch(/aria-label="发送消息"/)
    expect(composer).toMatch(/borderRadius:\s*'50%'/)
    expect(composer).toMatch(/background:\s*input\.trim\(\) \? '#dbeafe' : '#eef0f3'/)
    expect(composer).toMatch(/color:\s*input\.trim\(\) \? '#2563eb' : '#a0a5ae'/)
    expect(composer).toMatch(/disabled=\{sending \|\| !input\.trim\(\)\}/)
    expect(composer).toMatch(/M12 4\.25/)
  })

  it('提示词增强按钮会将结果写回草稿，但不自动触发发送', () => {
    expect(src).toMatch(/luminaAPI\?\.llmEnhancePrompt/)
    expect(src).toMatch(/setInput\(enhanced\)/)
    expect(src).toMatch(/增强提示词/)
    const start = src.indexOf('const enhancePrompt = async')
    const end = src.indexOf('// ═══ v2.7 群聊同步升级', start)
    const fn = src.slice(start, end)
    expect(fn).toContain('请求期间允许用户继续编辑')
    expect(fn).not.toMatch(/\bsend\s*\(/)
    expect(fn).not.toMatch(/agentChat\s*\(/)
  })
})
