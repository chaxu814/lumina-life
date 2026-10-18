import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')

const chatPanel = read('src/panels/ChatPanel.tsx')
const groupChat = read('src/panels/GroupChatView.tsx')
const composer = read('src/components/ChatComposer.tsx')
const composerCss = read('src/styles/composer.css')
const icons = read('src/components/Icons.tsx')
const petHtml = read('electron/pet/pet-chat.html')

// ============================================================
// 一、任务派发中心 / 任务工作区 搬进 Agent 头部栏
// ============================================================
describe('Agent 头部栏承载任务入口', () => {
  it('两个入口都是头部栏胶囊（hd-chip），且各出现一次', () => {
    expect(chatPanel.match(/className=\{'hd-chip'/g)?.length).toBe(2)
    expect(chatPanel).toMatch(/<span className="hd-chip-txt">任务派发中心<\/span>/)
    expect(chatPanel).toMatch(/<span className="hd-chip-txt">任务工作区<\/span>/)
  })

  it('底部那条独立的「任务派发中心」入口已经删掉，不会重复出现', () => {
    expect(chatPanel).not.toContain('{/* ── 📋 任务派发中心入口（工具条下方，与群聊一致） ── */}')
    // 「选择任务类型 → 选择执行者 → 一键派发」这句提示只保留在头部胶囊的 title 里
    expect(chatPanel.match(/选择任务类型 → 选择执行者 → 一键派发/g)?.length).toBe(1)
  })

  it('两个按钮都接上了真实动作', () => {
    expect(chatPanel).toMatch(/onClick=\{\(\) => setShowTaskDispatcher\(true\)\}/)
    expect(chatPanel).toMatch(/onClick=\{toggleTaskPanel\}/)
    // 状态来自同一个 store，与任务工作区面板共享
    expect(chatPanel).toMatch(/useTaskWorkspace\(s => s\.panelOpen\)/)
    expect(chatPanel).toMatch(/useTaskWorkspace\(s => s\.togglePanel\)/)
  })
})

// ============================================================
// 二、静音图标换成线性 SVG
// ============================================================
describe('静音图标现代化', () => {
  it('Icons 里有线性喇叭，静音时画叉、开启时画声波', () => {
    expect(icons).toContain('export const IconSpeaker')
    expect(icons).toMatch(/muted \? \(/)
    expect(icons).toMatch(/M16\.2 9\.6l4 4\.8M20\.2 9\.6l-4 4\.8/)
    expect(icons).toMatch(/M4 9\.5h3L11\.5 6v12L7 14\.5H4z/)
  })

  it('Agent 与团队群聊都用上了，不再有 🔇 / 🔊 emoji', () => {
    expect(chatPanel).toMatch(/<IconSpeaker size=\{17\} muted=\{ttsMuted\} \/>/)
    expect(groupChat).toMatch(/<IconSpeaker size=\{16\} muted=\{ttsMuted\} \/>/)
    expect(chatPanel).not.toContain('\u{1F507}')
    expect(chatPanel).not.toContain('\u{1F50A}')
    expect(groupChat).not.toContain('\u{1F507}')
  })

  it('去掉了 emoji 时代的粉框，静音只用图标颜色区分', () => {
    expect(chatPanel).toMatch(/ttsMuted\s*\?\s*'#ef4444'/)
    expect(chatPanel).toMatch(/border: '1px solid transparent'/)
    expect(groupChat).toMatch(/color: ttsMuted \? '#ef4444' : 'var\(--text-secondary\)'/)
  })
})

// ============================================================
// 三、桌宠 AI 消息要有看得见的气泡
// ============================================================
describe('桌宠 AI 消息气泡', () => {
  // 同一个选择器在这个文件里出现过多次（后一处覆盖前一处），所以断言必须取
  // **最后一条**——取第一条会测到早已被覆盖的死规则。这个坑就是「气泡加了但看不见」的成因。
  const lastRule = (selector: string) => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const all = [...petHtml.matchAll(new RegExp(esc + ' \\{([\\s\\S]*?)\\}', 'g'))]
    return all.length ? all[all.length - 1][1] : ''
  }

  it('AI 气泡有明确的浅色底和描边（不再是白底叠白底）', () => {
    const bubble = lastRule('#chat-panel .cp-bubble')
    expect(bubble).toBeTruthy()
    expect(bubble).toMatch(/background:\s*#f4f7fc/)
    expect(bubble).toMatch(/border:\s*1px solid rgba\(86,120,180,0\.16\)/)
    expect(bubble).not.toMatch(/rgba\(255,255,255,0\.9\)/)
  })

  it('最终生效的 .cp-msg.pet 允许透明，但底色必须由 .cp-bubble 承接', () => {
    const pet = lastRule('#chat-panel .cp-msg.pet')
    expect(pet).toBeTruthy()
    // 容器透明 + 子层 .cp-bubble 有底色 = 正确结构；
    // 两边都没有底色才是「气泡消失」的回归。
    const bubble = lastRule('#chat-panel .cp-bubble')
    const containerHasBg = !/background:\s*transparent/.test(pet)
    const bubbleHasBg = /background:\s*#f4f7fc/.test(bubble)
    expect(containerHasBg || bubbleHasBg).toBe(true)
  })

  it('用户气泡右侧对齐，两者能一眼分开', () => {
    const user = lastRule('#chat-panel .cp-msg.user')
    expect(user).toBeTruthy()
    expect(user).toMatch(/align-self: flex-end/)
    expect(user).toMatch(/background:/)
  })
})

// ============================================================
// 四、Lucky Agent 快捷选择栏
// ============================================================
describe('Lucky Agent 快捷选择', () => {
  it('四个模式平铺成一排，点一下就到，不用连点', () => {
    expect(petHtml).toContain('id="lucky-quick"')
    for (const p of ['off', 'default', 'goal', 'mission']) {
      expect(petHtml).toContain(`data-lucky="${p}"`)
    }
    expect(petHtml).toMatch(/popMore\.addEventListener\('click'[\s\S]{0,400}closest\('\.cp-quick-btn'\)/)
  })

  it('点快捷按钮会真的下发 preset，并同步高亮', () => {
    expect(petHtml).toMatch(/ipc\.send\('pet:ui:action', \{ kind: 'lucky-preset', preset: preset \}\)/)
    const fn = petHtml.slice(petHtml.indexOf('function applyLucky'), petHtml.indexOf('function insertCapsule'))
    expect(fn).toMatch(/data-lucky'\) === _luckyPreset/)
  })

  it('快捷栏有样式，且选中态可辨', () => {
    expect(petHtml).toMatch(/#chat-panel \.cp-quick-btn\.on \{[\s\S]{0,120}background: #eff6ff/)
  })
})

// ============================================================
// 五、删除对话弹窗标题带上主体名
// ============================================================
describe('删除对话弹窗', () => {
  it('标题写明是 Lumina Agent 的对话', () => {
    expect(petHtml).toMatch(/选择要删除的对话 <em class="cp-dialog-sub">Lumina Agent<\/em>/)
    expect(petHtml).toMatch(/#chat-panel \.cp-dialog-sub \{/)
  })
})

// ============================================================
// 六、统一输入栏（+ / 更多）
// ============================================================
describe('统一输入栏', () => {
  it('「+」里有上传与截图，没有云盘 / 共享屏幕', () => {
    expect(composer).toContain('上传文件或图片')
    expect(composer).toContain('截图提问')
    expect(composer).not.toMatch(/云盘|共享屏幕/)
  })

  it('「更多」里是 Lumina 本体那套功能', () => {
    expect(composer).toContain('cc-pop-row')
    expect(composer).toContain('cc-quick')
    expect(composer).toMatch(/className=\{'cc-sw' \+ \(item\.toggle\.on \? ' on' : ''\)\}/)
  })

  it('两个界面都用同一个组件，参数各自接自己的状态', () => {
    expect(chatPanel).toMatch(/<ChatComposer[\s\S]{0,1800}onPickFiles=\{\(\) => fileInputRef\.current\?\.click\(\)\}/)
    expect(groupChat).toMatch(/<ChatComposer[\s\S]{0,1800}onPickFiles=\{\(\) => fileInputRef\.current\?\.click\(\)\}/)
    // Agent 多了「对话 ›」胶囊，群聊没有
    expect(chatPanel).toContain('convSlot={(')
    expect(groupChat).not.toContain('convSlot={(')
  })

  it('右下角保留模型选择器 + 圆形发送（不被新结构顶掉）', () => {
    expect(composer).toMatch(/\{modelSlot\}/)
    expect(composerCss).toMatch(/\.cc-send-wrap/)
    expect(composerCss).toMatch(/\.cc-send \{[\s\S]{0,120}border-radius: 50%/)
  })

  it('样式与桌宠小窗同源：20px 圆角、聚焦蓝色微光', () => {
    expect(composerCss).toMatch(/\.cc-card \{[\s\S]{0,200}border-radius: 20px/)
    expect(composerCss).toMatch(/\.cc-card:focus-within \{[\s\S]{0,120}rgba\(74, 158, 255, 0\.55\)/)
  })

  it('增强提示词在 Agent 侧也接上了，且不会自动发送', () => {
    expect(chatPanel).toMatch(/luminaAPI\?\.llmEnhancePrompt/)
    const start = chatPanel.indexOf('const handleEnhancePrompt')
    const fn = chatPanel.slice(start, start + 1800)
    expect(fn).toContain('请求期间用户可能继续编辑')
    expect(fn).not.toMatch(/handleSendWithText\s*\(/)
  })

  it('截图附件会把落盘路径一起交给 agent', () => {
    expect(chatPanel).toMatch(/agentScreenshot\?\.\(\)/)
    expect(chatPanel).toMatch(/路径: \$\{a\.path\}/)
    expect(groupChat).toMatch(/路径: \$\{a\.path\}/)
  })
})

// ============================================================
// 七、Agent 聊天界面向团队群聊看齐
// ============================================================
describe('Agent 消息渲染对齐团队群聊', () => {
  const block = chatPanel.slice(
    chatPanel.indexOf('{messages.map((msg, i) => {'),
    chatPanel.indexOf('{/* ── v2.7: 审批卡片'),
  )

  it('名字与时间在气泡上方，不在气泡里', () => {
    expect(block).toMatch(/formatDateLabel\(msg\.timestamp\)/)
    const nameIdx = block.indexOf('profile.nickname || \'你\'')
    const bubbleIdx = block.indexOf('borderRadius: 10, padding: \'9px 14px\'')
    expect(nameIdx).toBeGreaterThan(-1)
    expect(bubbleIdx).toBeGreaterThan(-1)
    expect(nameIdx).toBeLessThan(bubbleIdx)
  })

  it('气泡尺寸 / 圆角 / 字号与团队群聊一致', () => {
    expect(block).toMatch(/maxWidth: '72%'/)
    expect(block).toMatch(/borderRadius: 10, padding: '9px 14px'/)
    expect(block).toMatch(/fontSize: 14, lineHeight: 1\.7/)
  })

  it('头像 32px 圆形浅底 + 角色色描边', () => {
    expect(block).toMatch(/width: 32, height: 32, borderRadius: 16/)
    expect(block).toMatch(/background: isUser \? 'var\(--accent-50\)' : 'var\(--surface-50\)'/)
    expect(block).toMatch(/getAgentRole\(selectedRole\)\.color\}33/)
  })

  it('操作按钮挪到气泡下方，不再挤在气泡右下角', () => {
    const bubbleEnd = block.indexOf('{msg.debateResult && (<DecisionDebateCard')
    const actions = block.indexOf('内联操作按钮（移到气泡下方')
    expect(bubbleEnd).toBeGreaterThan(-1)
    expect(actions).toBeGreaterThan(bubbleEnd)
  })
})
