// ============================================================
// tests/thinkingCollapse.test.ts
//
// 守思考过程的展开规则：**输出期间默认展开，输出完毕默认收回，任何时候能手动开关。**
//
// 守住的是这几种破法：
//   1. 兜底写死 `?? false` / `?? true` 而不看是否还在输出
//   2. 用一个中间 Set 记录"该展开哪些"，但渲染层根本不读它（死代码）
//   3. userExpandedRef 只读不写 → "用户主动点开过就别弹回去"的守卫是死的
//   4. 自动收回的 setState 写在 setMessages updater 里 → reducer 里改别的
//      state，StrictMode 下跑两次，是 React 明确的反模式
//
// 两个面板都是超大组件（几千行、依赖整个应用运行时），这里做源码级断言，
// 方式和 browserWindow.test.ts 一致。
// ============================================================

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const gcSrc = readFileSync(join(__dirname, '..', 'src', 'panels', 'GroupChatView.tsx'), 'utf-8')
const chatSrc = readFileSync(join(__dirname, '..', 'src', 'panels', 'ChatPanel.tsx'), 'utf-8')
const globalCss = readFileSync(join(__dirname, '..', 'src', 'styles', 'global.css'), 'utf-8')

/** 取出第一个函数体（按大括号配平，忽略字符串里的括号影响不大——这两处都没有） */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `找不到 ${signature}`).toBeGreaterThan(-1)
  let depth = 0
  let began = false
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; began = true }
    else if (src[i] === '}') {
      depth--
      if (began && depth === 0) {return src.slice(start, i + 1)}
    }
  }
  return src.slice(start, start + 4000)
}

describe('群聊：思考过程跟随输出状态', () => {
  it('显式记录优先；没记录过时按"是否还在输出"派生', () => {
    const fn = functionBody(gcSrc, 'const isThinkingCollapsed = (msgId: string')
    // 【v3.34 括号容错】原来是 toContain('if (...) return ...')，eslint 的
    // curly 规则 --fix 会把单行 if 补成 if (...) { return ... }，断言就红了。
    // 「读源码文本」的断言对格式化天然脆弱，这里统一压掉空白并允许可选花括号。
    const flat = fn.replace(/\s+/g, ' ')
    expect(flat).toMatch(/if \(msgId in thinkingCollapsed\) \{?\s*return thinkingCollapsed\[msgId\]/)
    // 还在输出（!_animDone）→ 返回 false = 展开；输出完毕 → true = 收起
    expect(flat).toMatch(/return Boolean\(msg && msg\._animDone\)/)
  })

  it('不能再用写死的 ?? true / ?? false 兜底（那会忽略输出状态）', () => {
    expect(gcSrc).not.toMatch(/thinkingCollapsed\[m\.id\] \?\? (true|false)/)
    expect(gcSrc).not.toMatch(/thinkingCollapsed\[msgId\] \?\? (true|false)/)
  })

  it('aria-expanded 与展开 class 都走同一个判定，不会一处开一处关', () => {
    expect(gcSrc).toContain('aria-expanded={!isThinkingCollapsed(m.id, m)}')
    expect(gcSrc).toContain("className={'thinking-collapse' + (isThinkingCollapsed(m.id, m) ? '' : ' open')}")
  })

  it('toggle 也按当前真实状态翻转（首次点击不会方向反了）', () => {
    const body = functionBody(gcSrc, 'const toggleThinking = useCallback')
    expect(body).toContain('const nowCollapsed = !(msgId in prev ? prev[msgId] : !streaming)')
    // 渲染处把"是否还在输出"传进来
    expect(gcSrc).toContain('toggleThinking(m.id, !m._animDone)')
  })

  it('中间 Set 状态已清掉——渲染层曾经根本不读它', () => {
    // expandedThinking / autoCollapsedThinkingRef 是只写不读的死状态，
    // 展开规则曾经从没真正生效过（注释里提到名字不算）
    expect(gcSrc).not.toContain('setExpandedThinking')
    expect(gcSrc).not.toContain('autoCollapsedThinkingRef')
    expect(gcSrc).not.toMatch(/expandedThinking,\s*setExpandedThinking/)
  })
})

describe('群聊：回复完毕自动收回', () => {
  it('用户主动点开过才不强制收（守卫必须是活的）', () => {
    const toggle = functionBody(gcSrc, 'const toggleThinking = useCallback')
    expect(toggle).toContain('userExpandedRef.current.add(msgId)')
    expect(toggle).toContain('userExpandedRef.current.delete(msgId)')

    // 早前 userExpandedRef 只有读没有写，守卫等于不存在
    const writes = (gcSrc.match(/userExpandedRef\.current\.(add|delete)\(/g) || []).length
    expect(writes).toBeGreaterThanOrEqual(2)
  })

  it('自动收回不写在状态 updater 里（React 反模式）', () => {
    const anim = functionBody(gcSrc, 'if (i >= fullText.length)')
    // 2026-10-10：完成分支的写入已从裸 `setMessages(prev => …)` 收敛到
    //   `commitToSession(sid, prev => …)`（会话安全提交，见 P0-1 修复）。
    //   两者都是「状态 updater」，反模式约束不变：updater 里不得改别的 state。
    const updaterStart = Math.max(
      anim.indexOf('setMessages(prev => {'),
      anim.indexOf('commitToSession(sid, prev => {'),
    )
    const updaterEnd = anim.indexOf('return updated', updaterStart)
    const updater = anim.slice(updaterStart, updaterEnd)

    expect(updaterStart, '没找到完成分支的状态 updater（结构变了？）').toBeGreaterThanOrEqual(0)
    expect(updater.length).toBeGreaterThan(0)
    // reducer 里只允许算 updated / 存盘 / 广播，不能改别的 state
    expect(updater).not.toContain('setThinkingCollapsed')
    expect(updater).not.toContain('setExpandedThinking')

    // 但它必须在 updater 外面还执行一次，否则自动收回就丢了
    expect(anim.slice(updaterEnd)).toContain('setThinkingCollapsed')
    expect(anim.slice(updaterEnd)).toContain('userExpandedRef.current.has(msgId)')
  })

  it('自动收回只做一次，不重复调用', () => {
    const anim = functionBody(gcSrc, 'if (i >= fullText.length)')
    expect((anim.match(/setThinkingCollapsed\(/g) || []).length).toBe(1)
  })
})

describe('单聊：输出中默认展开，输出完毕收回', () => {
  it('liveThinkingExpanded 初始为 true（输出期间默认展开）', () => {
    expect(chatSrc).toContain('const [liveThinkingExpanded, setLiveThinkingExpanded] = useState(true)')
  })

  it('每轮发送重置为展开（上一轮的手动收起不该带到下一轮）', () => {
    expect(chatSrc).toMatch(/setLastAgentEvents\(\[\]\)\s*\n\s*setThinkingExpanded\(false\)\s*\n\s*setLiveThinkingExpanded\(true\)/)
  })

  it('输出完毕转入上轮折叠面板，是收起态', () => {
    // thinkingExpanded 在发送时置 false，且只有用户点标题栏才会变 true
    const panel = functionBody(chatSrc, '{lastAgentEvents.length > 0 && agentEvents.length === 0')
    expect(panel).toContain('aria-expanded={thinkingExpanded}')
    expect(panel).toContain("className={'thinking-collapse' + (thinkingExpanded ? ' open' : '')}")
  })

  it('中断后转入上轮折叠面板，也是收起态', () => {
    const abort = functionBody(chatSrc, 'const handleAbort = () => {')
    expect(abort).toContain('setLiveThinkingExpanded(false)')
    expect(abort).toContain('setThinkingExpanded(false)')
  })

  it('实时面板可折叠，不是写死的展开黄框', () => {
    expect(chatSrc).toContain('aria-controls="live-thinking"')
    expect(chatSrc).toContain("className={'thinking-collapse' + (liveThinkingExpanded ? ' open' : '')}")
    // 旧的写死黄框 + 内联 emoji 渲染已移除
    expect(chatSrc).not.toContain("background: 'var(--yellow-100)', borderRadius: 8")
  })

  it('实时面板复用 ThinkingStepList，三处渲染收敛成一套', () => {
    const panel = chatSrc.slice(chatSrc.indexOf('实时思考过程'), chatSrc.indexOf('实时思考过程') + 2600)
    expect(panel).toContain('<ThinkingStepList steps={currentThinkingSteps} />')
    expect(gcSrc).toContain('<ThinkingStepList steps={m.thinkingSteps} />')                    // 群聊
    expect(chatSrc).toMatch(/<ThinkingStepList\s+steps=\{lastAgentEvents\.map\(/)               // 单聊上轮
  })

  it('收起时仍有"正在思考"的可见提示（脉冲点 + 步数）', () => {
    const panel = chatSrc.slice(chatSrc.indexOf('实时思考过程'), chatSrc.indexOf('实时思考过程') + 2600)
    expect(panel).toContain('thinking-live-dot')
    expect(panel).toContain('思考中')
    expect(panel).toContain('{currentThinkingSteps.length}步')
  })
})

describe('折叠动画与无障碍属性', () => {
  it('thinking-collapse 仍是 0fr → 1fr 的 grid 过渡', () => {
    expect(globalCss).toMatch(/\.thinking-collapse\s*\{[^}]*grid-template-rows:\s*0fr/)
    expect(globalCss).toMatch(/\.thinking-collapse\.open\s*\{[^}]*grid-template-rows:\s*1fr/)
  })

  it('chevron 旋转由 aria-expanded 驱动，折叠时朝右', () => {
    expect(globalCss).toContain('.thinking-toggle[aria-expanded="true"] .thinking-chevron')
  })

  it('减少动效偏好下禁用过渡与脉冲', () => {
    const reduced = globalCss.slice(globalCss.indexOf('prefers-reduced-motion'))
    expect(reduced).toContain('.thinking-collapse')
    expect(reduced).toContain('.thinking-live-dot')
  })
})
