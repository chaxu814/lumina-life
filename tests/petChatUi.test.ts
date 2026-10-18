// ============================================================
// petChatUi.test.ts — Live2D 聊天窗 UI 行为（2026-10-05）
//
// 【锁定的三个真实问题】
// 1. 聊天窗「只能在 Live2D 窗口内拖动」
// 2. 点完 A/B/C 选项后不收起，一直留在界面上
// 3. 思考过程显示「第 N 轮处理中」等轮次噪音，15 步里一半是重复
//
// 【为什么用「读 HTML 源码断言」而不是 DOM 测试】
// pet-chat.html 是一个单文件内联页面，不走打包产物；
// ThinkingStepList 的过滤逻辑是纯函数但组件本身是 TSX。
// 读源码断言的价值：它直接锁住「那段 CSS/JS 有没有还在」，
// 而这正是回归时最容易被改回去的地方（例如有人又把 .cp-log 设回 drag）。
// ============================================================

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const PET_HTML = path.join(process.cwd(), 'electron', 'pet', 'pet-chat.html')
const THINKING_TSX = path.join(process.cwd(), 'src', 'components', 'ThinkingStepList.tsx')
const RUNNER = path.join(process.cwd(), 'electron', 'agentRunner.ts')
const CSS = path.join(process.cwd(), 'src', 'styles', 'thinking.css')

const read = (p: string) => fs.readFileSync(p, 'utf-8')

describe('Live2D 聊天窗 · 拖拽行为', () => {
  const html = read(PET_HTML)

  it('聊天记录区【不再】是 drag 区（这是「只能窗内拖」的根因）', () => {
    // -webkit-app-region 是继承的：.cp-log 一旦是 drag，正文里所有东西都不能交互
    expect(html).not.toMatch(/\.cp-log\s*\{[^}]*-webkit-app-region:\s*drag/)
    expect(html).toMatch(/\.cp-log\s*\{[^}]*-webkit-app-region:\s*no-drag/)
  })

  it('标题栏仍是 drag 区（保留最基本的拖窗入口）', () => {
    expect(html).toMatch(/\.cp-head\s*\{[^}]*-webkit-app-region:\s*drag/)
  })

  it('存在底部拖动手柄（不用瞄准细标题栏也能自由拖窗）', () => {
    expect(html).toMatch(/\.cp-drag-handle\s*\{/)
    expect(html).toMatch(/class="cp-drag-handle"/)
    expect(html).toMatch(/按住拖动窗口/)
  })

  it('拖动手柄在 HTML 结构里（不只是 CSS 写了）', () => {
    // 手柄必须真实存在，否则是「写了样式没插入元素」的半成品
    const handleIdx = html.indexOf('class="cp-drag-handle"')
    // 断言它出现在**第一个 <script> 之前**（即属于结构而非脚本生成的）
    // 原来锚在 '</div>\n\n<script'，2026-10-18 在 <script> 前插了
    // pet-md.js 的 <script src>，那个字面量不再成立
    const scriptIdx = html.indexOf('<script')
    expect(handleIdx).toBeGreaterThan(-1)
    expect(scriptIdx).toBeGreaterThan(-1)
    expect(handleIdx).toBeLessThan(scriptIdx)
  })

  it('正文恢复可选中（拖拽区不再吞掉文本选择）', () => {
    expect(html).toMatch(/\.cp-msg\s*\{[^}]*user-select:\s*text/)
  })
})

describe('Live2D 聊天窗 · A/B/C 选项行为', () => {
  const html = read(PET_HTML)

  it('选项组【容器】声明了 no-drag（继承会导致点击失效）', () => {
    // 这是「点了没反应」的真正根因：父级 drag 时，子元素不声明就是 drag
    expect(html).toMatch(/\.cp-msg-options\s*\{[^}]*-webkit-app-region:\s*no-drag/)
  })

  it('点击选项后会替换成「已选」回看条（而非直接消失）', () => {
    expect(html).toMatch(/function buildChosenBar/)
    expect(html).toMatch(/wrap\.replaceWith\(buildChosenBar\(list, i\)\)/)
  })

  it('回看条可再次展开/收起（需求：后期还能打开查看）', () => {
    expect(html).toMatch(/bar\.classList\.contains\('open'\)/)
    expect(html).toMatch(/bar\.classList\.toggle|bar\.classList\.add\('open'\)/)
    expect(html).toMatch(/点击展开这轮的全部选项/)
  })

  it('选择后仍会发出消息（收起不能影响正常对话）', () => {
    // 顺序很重要：先换回看条，再 sendText
    const idx = html.indexOf('buildChosenBar(list, i)')
    const sendIdx = html.indexOf('sendText(o)', idx)
    expect(idx).toBeGreaterThan(-1)
    expect(sendIdx).toBeGreaterThan(idx)
  })

  it('同一时刻只保留一组选项（旧实现会累积多组）', () => {
    expect(html).toMatch(/let _activeOptions/)
    expect(html).toMatch(/addChatOptions[\s\S]{0,400}clearChatOptions\(\)/)
  })

  it('回看条有对应样式（不是无样式的裸文本）', () => {
    expect(html).toMatch(/\.cp-msg-chosen\s*\{/)
  })
})

describe('思考过程 · 去轮次噪音', () => {
  const tsx = read(THINKING_TSX)
  const runner = read(RUNNER)
  const css = read(CSS)

  it('主进程只在第 1 轮发轮次标记（不再每轮都发）', () => {
    // 旧实现：每轮 emit `第 ${round+1} 轮处理中` → 15 步里一半是它
    expect(runner).not.toMatch(/第 \$\{round \+ 1\} 轮处理中/)
    expect(runner).toMatch(/if \(round === 0\)\s*\{\s*this\.emit\(\{ type: 'thinking', text: '开始处理' \}\)/)
  })

  it('组件层过滤掉轮次标记（双保险）', () => {
    expect(tsx).toMatch(/isRoundMarker/)
    expect(tsx).toMatch(/开始处理（第\\s\*\\d\+\\s\*轮）/)
    expect(tsx).toMatch(/第\\s\*\\d\+\\s\*轮处理中/)
  })

  it('连续重复的 label 只保留一条', () => {
    expect(tsx).toMatch(/deduped/)
    expect(tsx).toMatch(/stripEmoji\(prev\.label\) === stripEmoji\(s\.label\)/)
  })

  it('默认只展示前 6 条，其余折叠', () => {
    expect(tsx).toMatch(/MAX_VISIBLE = 6/)
    expect(tsx).toMatch(/visible\.slice\(0, MAX_VISIBLE\)/)
  })

  it('折叠部分可一键展开（简化 ≠ 删除）', () => {
    expect(tsx).toMatch(/还有 \{hidden\} 条/)
    expect(tsx).toMatch(/点击展开完整过程/)
    expect(tsx).toMatch(/收起（已显示全部/)
  })

  it('展开入口有样式', () => {
    expect(css).toMatch(/\.tsl-more\s*\{/)
  })

  it('工具调用的关键信息未被删掉（可核查性必须保留）', () => {
    // 简化只针对轮次噪音，下列信息必须仍在渲染里
    expect(tsx).toMatch(/step\.tool && <span className="tsl-tag">/)
    expect(tsx).toMatch(/step\.durationMs != null/)
    expect(tsx).toMatch(/入参/)
    expect(tsx).toMatch(/isError/)
  })
})

// ─────────────────────────────────────────────────────────────
// petChatUi.test.ts — 2026-10-13 新增
//
// 【锁定的真实问题】点 Live2D 角色头顶搭话卡片的 A/B/C 选项后，
// 聊天小窗里没有任何"正在思考"动画，用户以为程序卡死。
//
// 【根因】聊天窗的 `pet:sync-reply` 处理**无条件** showTyping(false)。
//   · 输入框 / 聊天窗内选项走 sendText()，它自己已 showTyping(true)，看不出问题；
//   · 但卡片选项在 Live2D 渲染页（pet-live2d.html 的 replyProactive），
//     它只能靠 ipc 把用户气泡推给聊天窗 → 收到 role:'user' 时反被关掉动画，
//     于是整轮对话从头到尾都是"静止"的。
//
// 【为什么断言写在源码上】pet-chat.html 是单文件内联页面，不参与打包，
// 无法 import 逻辑做 DOM 测试 —— 与本文档其它用例保持同一口径。
// ⚠️ 定位串必须选**注释里不会出现**的结构（我在注释里提到了 showTyping(false)），
//    所以下面用带 if/else 结构的整段正则，而不是裸的字符串包含判断。
// ─────────────────────────────────────────────────────────────

describe('Live2D 聊天窗 · 从角色头顶卡片选项发起对话时的加载反馈', () => {
  const html = read(PET_HTML)
  const petWindowSrc = read(path.join(process.cwd(), 'electron', 'pet', 'petWindow.ts'))

  it('收到「用户消息」回显时进入等待态（而不是把动画关掉）', () => {
    // 2026-10-17：分支里多了一段注释（说明此处为何不能 traceClear），
    //   断言放宽到「user 分支 → beginWait() 之间只有注释」。
    expect(html).toMatch(/if \(data && data\.role === 'user'\)\s*\{(?:[^}]*?)\bbeginWait\(\)/)
    // 反例守卫：user 分支绝不能直接关动画
    const userBranch = html.slice(
      html.indexOf("if (data && data.role === 'user')"),
      html.indexOf("if (data && data.role === 'user')") + 400,
    )
    expect(userBranch).not.toContain('showTyping(false)')
  })

  it('助手回复到达时才结束等待态', () => {
    // 2026-10-17：结束等待前先收推理面板（traceFinish），再 endWait()。
    expect(html).toMatch(/\}\s*else\s*\{\s*traceFinish\(true\);\s*endWait\(\);\s*\}/)
  })

  it('等待态用计数而非布尔（排队时不会提前收掉动画）', () => {
    // 桌宠侧串行排队：前一条回复到达时若直接关动画，排队中的后一条就全程没反馈
    expect(html).toMatch(/let _pendingReplies = 0/)
    expect(html).toMatch(/function beginWait\(\) \{ _pendingReplies\+\+; showTyping\(true\); \}/)
    expect(html).toMatch(/if \(_pendingReplies === 0\) showTyping\(false\)/)
  })

  it('输入框 / 聊天窗内选项路径不受影响（sendText 仍自行开动画）', () => {
    expect(html).toMatch(/function sendText[\s\S]{0,400}beginWait\(\)/)
  })

  it('聊天窗页面未加载完时，回复延迟到 did-finish-load 再发（不静默丢失）', () => {
    // 首次点卡片选项时聊天窗可能刚被 openPetChatWindow() 创建，
    // loadFile 还没跑完 → 直接 send 会打到一个没注册 ipc.on 的页面。
    expect(petWindowSrc).toMatch(/const sendWhenReady = \(win: BrowserWindow/)
    expect(petWindowSrc).toMatch(/wc\.isLoading\(\)[\s\S]{0,200}did-finish-load/)
    expect(petWindowSrc).toMatch(/sendWhenReady\(petChatWindow, 'pet:sync-reply'/)
  })
})
