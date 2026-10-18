import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')

const icons = read('src/components/Icons.tsx')
const composer = read('src/components/ChatComposer.tsx')
const composerCss = read('src/styles/composer.css')
const chatPanel = read('src/panels/ChatPanel.tsx')
const groupChat = read('src/panels/GroupChatView.tsx')
const settingsModal = read('src/components/SettingsModal.tsx')
const moreSettings = read('src/components/MoreSettingsModal.tsx')
const userPanel = read('src/components/SidebarUserPanel.tsx')
const luckySelector = read('src/components/LuckyModeSelector.tsx')
const petHtml = read('electron/pet/pet-chat.html')

// 只关心「图标」emoji，排除内容型（Agent 头像、表情选择器、提示文案）
const EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF]/u

// ============================================================
// 一、图标库：新增线性图标，统一 1.7 描边
// ============================================================
describe('线性图标库', () => {
  it('新增了界面里被 emoji 顶替的那批图标', () => {
    const required = [
      'IconSparkles', 'IconBrain', 'IconPaperclip', 'IconMonitor', 'IconLeaf',
      'IconClipboard', 'IconFlower', 'IconPin', 'IconPanelLeft', 'IconExternalLink',
      'IconColumns', 'IconMinus', 'IconList', 'IconScissors', 'IconHourglass',
      'IconPalette', 'IconCompass', 'IconLink', 'IconMobile', 'IconPuzzle',
      'IconScale', 'IconTarget',
    ]
    for (const name of required) {
      expect(icons, `缺少图标 ${name}`).toContain(`export const ${name}`)
    }
  })

  it('线性图标统一走 SvgLine（1.7 描边 + currentColor）', () => {
    expect(icons).toContain('const SvgLine')
    expect(icons).toMatch(/strokeWidth=\{1\.7\}/)
    expect(icons).toMatch(/stroke="currentColor"/)
  })
})

// ============================================================
// 二、输入栏菜单：icon 从 emoji 字符串改为 ReactNode
// ============================================================
describe('输入栏「更多」菜单图标', () => {
  it('ComposerMenuItem.icon 是 ReactNode，不是 string', () => {
    expect(composer).toMatch(/icon: React\.ReactNode/)
    expect(composer).not.toMatch(/icon: string/)
  })

  it('两个面板的菜单项都用 <Icon… size={16} />，不再有 emoji 图标', () => {
    for (const src of [chatPanel, groupChat]) {
      expect(src).toMatch(/key: 'enhance', icon: <IconSparkles size=\{16\} \/>/)
      expect(src).toMatch(/key: 'lucky', icon: <IconLeaf size=\{16\} \/>/)
      expect(src).toMatch(/key: 'thinking', icon: <IconBrain size=\{16\} \/>/)
      expect(src).toMatch(/key: 'emoji', icon: <IconSmile size=\{16\} \/>/)
      expect(src).toMatch(/key: 'file', icon: <IconPaperclip size=\{16\} \/>/)
      expect(src).toMatch(/key: 'voice', icon: <IconMic size=\{16\} \/>/)
      expect(src).toMatch(/key: 'cu', icon: <IconMonitor size=\{16\} \/>/)
      expect(src).toMatch(/key: 'capsule', icon: <IconHourglass size=\{16\} \/>/)
    }
  })

  it('「+」弹层里的上传 / 截图也是 SVG，不再是 ⬆ / ✂ 字符', () => {
    expect(composer).toContain('<IconUpload size={16} />')
    expect(composer).toContain('<IconScissors size={16} />')
    expect(composer).not.toContain('>⬆<')
    expect(composer).not.toContain('>✂<')
  })

  it('附件类型图标由 emoji 换成线性图标', () => {
    expect(composer).toMatch(/function fileIcon\(name: string\): React\.ReactNode/)
    expect(composer).not.toContain("return '🖼️'")
    expect(composer).not.toContain("return '📁'")
  })

  it('图标容器居中，SVG 不会被拉伸', () => {
    expect(composerCss).toMatch(/\.cc-pop-ico \{[\s\S]{0,200}align-items: center/)
    expect(composerCss).toMatch(/\.cc-chip-ico \{[\s\S]{0,200}align-items: center/)
  })
})

// ============================================================
// 三、其它界面 chrome 的 emoji 图标
// ============================================================
describe('界面图标全局线性化', () => {
  it('Agent 头部栏两个任务胶囊用 SVG', () => {
    expect(chatPanel).toContain('<IconClipboard size={15} />')
    expect(chatPanel).toContain('<IconFolder size={15} />')
    expect(chatPanel).not.toContain('<span className="hd-chip-ico">📋</span>')
  })

  it('群聊三个标签页用 SVG', () => {
    expect(groupChat).toMatch(/label: '群聊', icon: <IconMessageCircle size=\{15\} \/>/)
    expect(groupChat).toMatch(/label: '任务', icon: <IconClipboard size=\{15\} \/>/)
    expect(groupChat).toMatch(/label: '朋友圈', icon: <IconFlower size=\{15\} \/>/)
  })

  it('设置弹窗导航项不再有 emoji', () => {
    const navBlock = settingsModal.slice(
      settingsModal.indexOf('const SIDEBAR_ITEMS'),
      settingsModal.indexOf('] as const'),
    )
    expect(navBlock).not.toMatch(/icon: *'[^']*[\u{1F000}-\u{1FAFF}]/u)
    expect(navBlock).toContain('<IconBot size={16} />')
    expect(navBlock).toContain('<IconBrain size={16} />')
  })

  it('更多设置导航项不再有 emoji', () => {
    const navBlock = moreSettings.slice(
      moreSettings.indexOf('const SIDEBAR_ITEMS'),
      moreSettings.indexOf('] as const'),
    )
    expect(navBlock).not.toMatch(/icon: *'[^']*[\u{1F000}-\u{1FAFF}]/u)
    expect(navBlock).toContain('<IconPuzzle size={16} />')
  })

  it('侧栏用户面板菜单项用 SVG', () => {
    expect(userPanel).not.toMatch(/itemRow\('[^']*[\u{1F000}-\u{1FAFF}]/u)
    expect(userPanel).toContain('<IconSun size={14} />')
    expect(userPanel).toContain('<IconBrain size={14} />')
  })

  it('Lucky 预设图标线性化，且补上了 mission 项', () => {
    expect(luckySelector).not.toMatch(/icon: '[^']*[\u{1F000}-\u{1FAFF}]/u)
    expect(luckySelector).toMatch(/id: 'mission'/)
  })
})

// ============================================================
// 四、桌宠窗：图标精灵表 + AI 气泡
// ============================================================
describe('桌宠聊天窗', () => {
  it('页面顶部有图标精灵表，弹层用 <use> 引用', () => {
    expect(petHtml).toContain('<svg class="cp-sprite"')
    expect(petHtml).toContain('<symbol id="i-spark"')
    expect(petHtml).toContain('<use href="#i-spark"/>')
    expect(petHtml).not.toMatch(/<span class="cp-pop-ico">[\u{1F000}-\u{1FAFF}]/u)
  })

  it('快捷语 chips 用线性图标而不是 emoji', () => {
    const quickBlock = petHtml.slice(
      petHtml.indexOf('<div class="cp-quick" id="chat-quick">'),
      petHtml.indexOf('<div class="cp-emoji-panel"'),
    )
    expect(quickBlock).not.toMatch(EMOJI)
    expect(quickBlock).toContain('<use href="#i-bubble"/>')
    expect(quickBlock).toContain('<use href="#i-hand"/>')
  })

  it('AI 消息外面真的有一层 .cp-bubble（渲染层）', () => {
    expect(petHtml).toMatch(/bubble\.className = 'cp-bubble'/)
    expect(petHtml).toMatch(/bubble\.appendChild\(body\)/)
    expect(petHtml).toMatch(/d\.appendChild\(av\)/)
  })

  it('气泡底色由 .cp-bubble 承接（容器本身透明是允许的）', () => {
    // 结构是 .cp-msg.pet（透明行）> avatar + .cp-bubble（有底色）。
    // 关键是「必须真的存在 .cp-bubble 这一层」——上一版把底色写在容器上，
    // 结果被后一处同选择器定义覆盖成 transparent，气泡整个消失。
    const blocks = [...petHtml.matchAll(/#chat-panel \.cp-msg\.pet \{([\s\S]*?)\}/g)]
    expect(blocks.length).toBeGreaterThan(0)
    const bubble = petHtml.match(/#chat-panel \.cp-bubble \{([\s\S]*?)\}/)?.[1] ?? ''
    expect(bubble).toMatch(/background:\s*#f4f7fc/)
  })

  it('.cp-bubble 有可见底色 / 描边 / 圆角', () => {
    const block = petHtml.match(/#chat-panel \.cp-bubble \{([\s\S]*?)\}/)?.[1] ?? ''
    expect(block).toContain('#f4f7fc')
    expect(block).toMatch(/border: 1px solid/)
    expect(block).toMatch(/border-radius: 12px/)
  })
})
