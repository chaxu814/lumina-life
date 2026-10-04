// 复现截图里的问题：热茶的「思考过程」整段英文 + 身份元推理
// 样本直接取自用户 2026-10-04 提供的真实截图，不是编造的。
import { describe, it, expect } from 'vitest'
import { sanitizeThinkingText, cjkRatio } from '../src/services/thinkingSanitizer'

// ── 用户截图里的真实内容 ──
const REAL = `user is continuing the conversation. Lumina has just introduced herself and her team (Yak and 热茶). The user's message is ("继续") which means "continue" - they want me to continue the conversation naturally.

Since I'm in group chat mode, I can respond directly. But wait - I need to figure out who I am responding as. Looking at the context, there are three characters: Lumina (the main companion), Yak (code engineer), and 热茶 (reviewer/analyst).

The message from Lumina introduces herself and mentions 热茶 is the reviewer. The user said ("继续") which means they want the conversation to continue.

I should respond naturally as part of this group chat. Since I'm 热茶, I should stay in character but also be friendly. Let me just respond warmly to Lumina's introduction and offer my services.`

// ── 正常中文思考，必须原样保留 ──
const GOOD_CN = `先确认这段代码的输入来源。
第 42 行直接读了 req.body.id，没有 schema 校验，属于越权风险。
再看调用方：只有 admin 中间件能到这里，暂时可控。
结论：建议补 schema 校验，不阻塞上线。`

describe('thinkingSanitizer · 英文元推理', () => {
  it('真实样本：删掉身份元推理行', () => {
    const r = sanitizeThinkingText(REAL)
    expect(r.text).not.toMatch(/I need to figure out who I am responding as/i)
    expect(r.text).not.toMatch(/Since I'm in group chat mode/i)
    expect(r.text).not.toMatch(/Let me just respond warmly/i)
  })

  it('真实样本：仍保留了有信息的英文行（不整段丢弃）', () => {
    const r = sanitizeThinkingText(REAL)
    // 「用户说了继续」这类是对话事实，删了反而看不懂模型在干什么
    expect(r.text).toMatch(/continuing the conversation/i)
    expect(r.droppedLines).toBeGreaterThan(0)
  })

  it('真实样本：整段仍为英文 → 标注 foreignLang', () => {
    const r = sanitizeThinkingText(REAL)
    expect(r.foreignLang).toBe(true)
  })

  it('正常中文思考：原样保留，不误伤', () => {
    const r = sanitizeThinkingText(GOOD_CN)
    expect(r.text).toBe(GOOD_CN)
    expect(r.foreignLang).toBe(false)
    expect(r.droppedLines).toBe(0)
  })

  it('「我的角色是…」这类角色自述也会被删', () => {
    expect(sanitizeThinkingText('My role is the reviewer.\n我在审第 42 行。').text)
      .toBe('我在审第 42 行。')
  })

  it('支持中英混排：中文为主时不误标 foreignLang', () => {
    const r = sanitizeThinkingText('先看 diff，确认第 42 行没有做 schema 校验。')
    expect(r.foreignLang).toBe(false)
  })

  it('流式残片（半行）不会因不匹配而被误删', () => {
    // 分片流里常见半句，保留它比删掉更重要
    const r = sanitizeThinkingText('I should respond natural')
    expect(r.text).toBe('I should respond natural')
  })

  it('空输入安全', () => {
    expect(sanitizeThinkingText('').text).toBe('')
    expect(sanitizeThinkingText(undefined).text).toBe('')
    expect(sanitizeThinkingText(null).droppedLines).toBe(0)
  })

  it('cjkRatio 基本判定', () => {
    expect(cjkRatio('全中文内容')).toBe(1)
    expect(cjkRatio('all english')).toBe(0)
    expect(cjkRatio('')).toBe(1) // 空不算「外文」
  })
})

describe('提示词侧约束（治本）', () => {
  it('群聊后台 agent 提示词要求全程中文思考', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync('electron/prompts/systemPrompt.ts', 'utf-8')
    expect(src).toMatch(/全程用中文思考/)
  })

  it('提示词禁止在思考里纠结身份', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync('electron/prompts/systemPrompt.ts', 'utf-8')
    expect(src).toMatch(/不要在思考里纠结自己的身份/)
  })
})
