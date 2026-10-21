import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8')

const composerCss = read('src/styles/composer.css')
const groupChat = read('src/panels/GroupChatView.tsx')
const chatPanel = read('src/panels/ChatPanel.tsx')
const recBar = read('src/components/RecommendationBar.tsx')

describe('空会话首屏（2026-10-21 二次修正：保留 Lumina 原欢迎屏）', () => {
  it('两处都保留原来的「XX 已就绪」欢迎屏', () => {
    expect(groupChat).toContain('{card.name} 已就绪')
    expect(groupChat).toContain('readyPop 0.6s')
    expect(chatPanel).toContain('{getAgentRole(selectedRole).name} 已就绪')
    expect(chatPanel).toContain('welcomePop 0.5s')
  })

  it('不再引入 ChatHero / 大标题 / 对话-工作分段', () => {
    expect(groupChat).not.toContain('ChatHero')
    expect(chatPanel).not.toContain('ChatHero')
    expect(existsSync(resolve(process.cwd(), 'src/components/ChatHero.tsx'))).toBe(false)
    expect(groupChat).not.toContain('有什么我能帮你的吗')
    expect(chatPanel).not.toContain('有什么我能帮你的吗')
  })

  it('「为你推荐」留在消息区内部，不挂回输入框上方', () => {
    expect(groupChat).not.toContain('aboveCard={')
    expect(chatPanel).not.toContain('aboveCard={')
    // 欢迎屏之后紧跟推荐栏（同一段空状态 JSX 内）
    expect(groupChat).toMatch(/已就绪[\s\S]{0,2600}<RecommendationBar/)
    expect(chatPanel).toMatch(/welcomeMsg[\s\S]{0,1600}<RecommendationBar/)
    expect(groupChat).toContain('compact')
    expect(chatPanel).toContain('compact')
  })

  it('推荐胶囊仍是豆包同款：999px 圆角、随文字宽度', () => {
    expect(composerCss).toMatch(/\.cc-rec \{[\s\S]{0,260}border-radius: 999px/)
    expect(composerCss).toMatch(/\.cc-rec \{[\s\S]{0,260}padding: 8px 15px/)
    expect(recBar).toContain('compact?: boolean')
  })

  it('刷新按钮不常驻（hover 才出现）', () => {
    expect(composerCss).toMatch(/\.cc-recs-refresh \{[\s\S]{0,120}opacity: 0/)
    expect(composerCss).toContain('.cc-recs:hover .cc-recs-refresh')
  })
})
