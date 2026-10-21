import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8')

const hero = read('src/components/ChatHero.tsx')
const heroCss = read('src/styles/chat-hero.css')
const composerCss = read('src/styles/composer.css')
const groupChat = read('src/panels/GroupChatView.tsx')
const chatPanel = read('src/panels/ChatPanel.tsx')
const recBar = read('src/components/RecommendationBar.tsx')

describe('空会话落地页（2026-10-21 对齐豆包）', () => {
  it('Hero 结构：大标题 + 分段控件 + 内容列', () => {
    expect(hero).toContain('className="ch-root"')
    expect(hero).toContain('className="ch-title"')
    expect(hero).toContain('className="ch-seg"')
    expect(hero).toContain("'ch-seg-btn' + (on ? ' on' : '')")
    expect(hero).toContain('role="tablist"')
  })

  it('版式与豆包一致：标题 30px、分段 360px、内容贴底', () => {
    expect(heroCss).toMatch(/\.ch-title \{[\s\S]{0,160}font-size: 30px/)
    expect(heroCss).toMatch(/\.ch-seg \{[\s\S]{0,200}width: 360px/)
    // 用 margin-top:auto 贴底（而不是 justify-content:flex-end——内容超高时会把标题顶出可滚区）
    expect(heroCss).toMatch(/\.ch-title \{[\s\S]{0,80}margin: auto 0 0/)
    expect(heroCss).not.toContain('justify-content: flex-end')
    // 不再固定 720px：左右边界要和输入卡片对齐
    expect(heroCss).not.toMatch(/\.ch-root \{[\s\S]{0,120}max-width: 720px/)
  })

  it('团队群聊：对话/工作映射到 chat/work 任务类型', () => {
    expect(groupChat).toContain("import ChatHero from '../components/ChatHero'")
    expect(groupChat).toMatch(/tabs=\{\[\{ key: 'chat', label: '对话' \}, \{ key: 'work', label: '工作' \}\]\}/)
    expect(groupChat).toContain("onTabChange={(k) => setSelectedRole(k as TaskType)}")
    // 推荐栏已移进落地页，不再钉在输入框上方
    expect(groupChat).not.toContain('aboveCard={')
  })

  it('单聊：对话/工作映射到 general/colleague，并复用统一切角色函数', () => {
    expect(chatPanel).toContain("import ChatHero from '../components/ChatHero'")
    expect(chatPanel).toMatch(/tabs=\{\[\{ key: 'general', label: '对话' \}, \{ key: 'colleague', label: '工作' \}\]\}/)
    expect(chatPanel).toContain('const selectAgentRole = (roleId: string)')
    expect(chatPanel).not.toContain('aboveCard={')
  })

  it('推荐胶囊：豆包同款圆角胶囊，且紧凑版隐藏徽章', () => {
    expect(composerCss).toMatch(/\.cc-rec \{[\s\S]{0,260}border-radius: 999px/)
    expect(composerCss).toMatch(/\.cc-rec \{[\s\S]{0,260}padding: 9px 16px/)
    expect(recBar).toContain('compact?: boolean')
    expect(recBar).toContain('{!compact && topicLabel &&')
    expect(recBar).toContain('{!compact && smart &&')
  })

  it('推荐栏不再常驻刷新按钮（hover 才出现）', () => {
    expect(composerCss).toMatch(/\.cc-recs-refresh \{[\s\S]{0,120}opacity: 0/)
    expect(composerCss).toContain('.cc-recs:hover .cc-recs-refresh')
  })
})
