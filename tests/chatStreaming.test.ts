// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/chatStreaming.test.ts
//
// 守本轮四个修复，全部对应用户实际报的现象：
//
//   1. 思考文字不是实时"打印"，而是最后才一并出现
//      → 每个推理 token 都在 setState，主线程被占满，渲染排队
//      → 必须用 rAF 合帧，一帧最多渲染一次
//   2. 每次打开 Lumina，聊天界面第一条思考过程默认展开
//      → 历史消息缺 _animDone，被当成"还在输出"
//      → loadGCMessages 必须把历史归一为已完成
//   3. 输出时用滚轮翻历史"卡手"，很难拖上拖下
//      → 自动滚底挂在 [messages] 上且用 behavior:'smooth'，
//        流式时每秒最多发起 60 次平滑滚动，动画被反复打断重定向
//      → 必须有"用户在不在底部"的判断 + rAF 合帧 + auto 定位
//   4. 收尾时拿到过期快照（await 之后闭包里的 state 早就不是最新了）
//
// 两个面板都是超大组件，这里做源码级断言，方式同 browserWindow /
// thinkingCollapse 两个测试文件。
// ============================================================

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const chatSrc = readFileSync(join(__dirname, '..', 'src', 'panels', 'ChatPanel.tsx'), 'utf-8')
const gcSrc = readFileSync(join(__dirname, '..', 'src', 'panels', 'GroupChatView.tsx'), 'utf-8')
const sharedSrc = readFileSync(join(__dirname, '..', 'src', 'chat', 'chatShared.ts'), 'utf-8')

describe('思考过程实时打印：流式合帧', () => {
  it('单聊：推理/事件更新走 rAF 合帧，不再逐 token setState', () => {
    expect(chatSrc).toContain('const scheduleThinking = () => {')
    expect(chatSrc).toMatch(/thinkingRaf = window\.requestAnimationFrame\(flushThinking\)/)
    // upsert 路径不再直接 setState
    const upsert = chatSrc.slice(chatSrc.indexOf('const upsertThinkingStep'), chatSrc.indexOf('const upsertThinkingStep') + 900)
    expect(upsert).toContain('scheduleThinking()')
    expect(upsert).not.toMatch(/setCurrentThinkingSteps\(\[/)
  })

  it('单聊：高频 token_update / text 也走同一条合帧路径', () => {
    const handler = chatSrc.slice(chatSrc.indexOf('// 其他事件正常推入'), chatSrc.indexOf('// 工具事件 → ThinkingStep'))
    expect(handler).toContain('scheduleThinking()')
    // 不能在这里逐事件直写两遍 state
    expect(handler).not.toMatch(/setAgentEvents\(\[/)
  })

  it('群聊：thinkingSteps 按 messageId 合帧，4 条热路径都换掉了', () => {
    expect(gcSrc).toContain('const pushThinking = useCallback((msgId: string, steps: ThinkingStep[]) => {')
    expect(gcSrc).toMatch(/thinkRafRef\.current = requestAnimationFrame\(flushThinking\)/)
    // 逐 token 的老写法不许再出现在 upsert 里
    expect(gcSrc).not.toMatch(/setMessages\(prev => prev\.map\(m => m\.id === (currentMsgId|currentReplyId|decMsgId)\s*\r?\n\s*\? \{ \.\.\.m, thinkingSteps/)
  })

  it('群聊：合帧不会用旧快照覆盖收尾直写的完整数据', () => {
    const flush = gcSrc.slice(gcSrc.indexOf('const flushThinking = useCallback'), gcSrc.indexOf('const pushThinking = useCallback'))
    expect(flush).toContain('if ((m.thinkingSteps?.length ?? 0) > steps.length) {return m}')
  })

  it('两端都在卸载时取消未落地的帧', () => {
    expect(chatSrc).toContain('cancelAnimationFrame(scrollRafRef.current)')
    expect(gcSrc).toMatch(/cancelAnimationFrame\(thinkRafRef\.current\)/)
    expect(gcSrc).toMatch(/cancelAnimationFrame\(scrollRafRef\.current\)/)
  })
})

describe('滚轮不再"卡手"', () => {
  it('单聊：补上了"用户是否在底部"的判断', () => {
    expect(chatSrc).toContain('const isUserAtBottomRef = useRef(true)')
    expect(chatSrc).toContain('const handleChatScroll = useCallback(')
    // 滚动容器要真的挂上 ref + onScroll，否则判断永远为 true
    expect(chatSrc).toContain('<div ref={chatScrollRef} onScroll={handleChatScroll}')
    expect(chatSrc).toContain('scrollHeight - el.scrollTop - el.clientHeight < 80')
  })

  it('两端都不再对每个 token 做 smooth 滚动', () => {
    expect(chatSrc).not.toMatch(/useEffect\(\(\) => \{ bottomRef\.current\?\.scrollIntoView\(\{ behavior: 'smooth' \}\) \}, \[messages/)
    expect(chatSrc).toMatch(/bottomRef\.current\?\.scrollIntoView\(\{ behavior: 'auto' \}\)/)
    expect(gcSrc).toMatch(/bottomRef\.current\?\.scrollIntoView\(\{ behavior: 'auto' \}\)/)
  })

  it('用户离开底部后不再被拽回（判断在滚动之前）', () => {
    const chatScroll = chatSrc.slice(chatSrc.indexOf('// ── 自动滚底 ──'), chatSrc.indexOf('// 注入情绪条 CSS 动画'))
    expect(chatScroll).toContain('if (!isUserAtBottomRef.current) {return}')
    // 合帧回调里要再判一次：排队期间用户可能已经往上翻了
    expect(chatScroll).toMatch(/if \(!isUserAtBottomRef\.current\) \{return\}/)

    const gcScroll = gcSrc.slice(gcSrc.indexOf('// 只在用户处于底部时自动滚底'), gcSrc.indexOf('// 跟踪用户是否在底部'))
    expect(gcScroll).toContain('if (!isUserAtBottomRef.current) {return}')
  })
})

describe('启动后历史消息不再默认展开', () => {
  it('从存储读回的消息一律按"已完成"归一', () => {
    expect(sharedSrc).toContain('_animDone: true')
    expect(sharedSrc).toMatch(/msgs\.map\(m => \(m\._animDone === true \? m : \{ \.\.\.m, _animDone: true \}\)\)/)
  })

  it('归一后不再靠 !_animDone 保留空气泡（有思考步骤的仍保留）', () => {
    const load = sharedSrc.slice(sharedSrc.indexOf('export function loadGCMessages'), sharedSrc.indexOf('export function saveGCMessages'))
    expect(load).not.toContain('!m._animDone')
    expect(load).toContain('m.thinkingSteps && m.thinkingSteps.length > 0')
  })

  it('渲染层仍然按 _animDone 判定展开与否', () => {
    expect(gcSrc).toContain('return Boolean(msg && msg._animDone)')
    expect(gcSrc).toContain('toggleThinking(m.id, !m._animDone)')
  })
})

describe('收尾拿到的是最新快照，不是过期闭包', () => {
  it('单聊：本轮累积器挂在 ref 上', () => {
    expect(chatSrc).toContain('const thinkingAccumRef = useRef<ThinkingStep[]>([])')
    expect(chatSrc).toContain('const eventLogRef = useRef<any[]>([])')
    expect(chatSrc).toContain('const eventLog = (eventLogRef.current = [] as any[])')
    expect(chatSrc).toContain('const thinkingAccum = (thinkingAccumRef.current = [] as ThinkingStep[])')
  })

  it('正常结束 / 异常 / 中断三条收尾路径都改读 ref', () => {
    const sites = (chatSrc.match(/setLastAgentEvents\(\[\.\.\.eventLogRef\.current/g) || []).length
    expect(sites).toBe(3)
  })

  it('收尾前先把没落地的合帧刷出来', () => {
    expect(chatSrc).toContain('const flushThinkingNow = () => {')
    // 正常结束 + 异常 两条 await 之后的收尾路径
    expect((chatSrc.match(/flushThinkingNow\(\)/g) || []).length).toBe(2)
    // 中断路径通过 ref 调用
    expect(chatSrc).toContain('thinkingFlushRef.current?.()')
  })
})

describe('思考开关', () => {
  it('单聊默认开启，且真正接到后端（之前是个装饰按钮）', () => {
    expect(chatSrc).toContain('const [thinkingMode, setThinkingMode] = useState(true)')
    expect(chatSrc).toContain('trackReasoning: thinkingModeRef.current')
    // handleSendWithText 没有依赖数组，必须走 ref 才读得到最新值
    expect(chatSrc).toContain('const thinkingModeRef = useRef(thinkingMode)')
  })
})
