import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(
  path.join(process.cwd(), 'src', 'panels', 'GroupChatView.tsx'),
  'utf-8',
)

// 2026-10-18：输入区拆成了共享组件 ChatComposer（Agent / 团队群聊共用一套观感），
// 所以「模型选择器紧挨圆形发送」这类结构断言要看组件本身；群聊这边只剩传参。
const composerSrc = fs.readFileSync(
  path.join(process.cwd(), 'src', 'components', 'ChatComposer.tsx'),
  'utf-8',
)
const composerCss = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'composer.css'),
  'utf-8',
)

describe('群聊输入区快捷模型选择布局', () => {
  it('快捷模型选择器紧挨发送按钮左侧，二者同处输入框右下角控件组', () => {
    expect(src).toMatch(/<ChatComposer[\s\S]*?modelSlot=\{<ModelSelector \/>\}/)
    // 控件组固定在输入框右下角：modelSlot 在前，发送按钮在后
    expect(composerSrc).toMatch(/className="cc-send-wrap"[\s\S]{0,80}\{modelSlot\}/)
    expect(composerCss).toMatch(/\.cc-send-wrap\s*\{[^}]*position:\s*absolute;[^}]*right:\s*0;[^}]*bottom:\s*0;/)
  })

  it('功能工具栏不再重复显示快捷模型选择器', () => {
    // 整个群聊文件里只应出现一次 ModelSelector（作为 modelSlot 传入）
    const hits = src.match(/<ModelSelector\s*\/>/g) || []
    expect(hits.length).toBe(1)
  })

  it('输入框初始高度稍微加大，并为右下角控件留出空间', () => {
    expect(src).toMatch(/minHeight=\{72\}/)
    expect(composerCss).toMatch(/\.cc-input\s*\{[^}]*padding:\s*0 216px 0 0;/)
  })

  it('发送控件为圆形上箭头，并按是否有草稿切换明暗/禁用状态', () => {
    expect(composerSrc).toMatch(/aria-label="发送消息"/)
    expect(composerCss).toMatch(/\.cc-send\s*\{[^}]*border-radius:\s*50%;/)
    expect(composerCss).toMatch(/\.cc-send-on\s*\{[^}]*background:\s*#dbeafe;[^}]*color:\s*#2563eb;/)
    expect(composerSrc).toMatch(/disabled=\{!sendable\}/)
    expect(composerSrc).toMatch(/M12 4\.25/)
    // 群聊把「有没有草稿」算好再传进去
    expect(src).toMatch(/canSend=\{!sending && !!input\.trim\(\)\}/)
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
