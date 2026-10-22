// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// petChatDuplicateAndTrace.test.ts — 桌宠聊天的两个真实故障
//
// 【故障一】点 Live2D 头顶搭话卡片的 A/B/C，冒出**两个一模一样的用户气泡**
//
//   根因（两条路径撞在一起，不是"重复发送"）：
//     ① pet-live2d.html 的 replyProactive 先发 `pet:sync-send` —— 主窗口
//        PetChatSync 立刻把这句话写进 store 并开跑 Agent；
//     ② 紧接着它又发 `pet:sync-reply {role:'user'}` 把用户气泡"回显"到聊天窗，
//        而这条走 sendWhenReady，要等 did-finish-load 才真正送达。
//   新窗口加载时会先拉一次历史 —— 此时 ① 早已把这句话写进 store，
//   于是历史回放里**已经有它**；随后 ② 的延迟回显到达，又画一遍。
//
//   所以修法在渲染层（pet-chat.html 的 addChatMsg）：相邻 + 同角色 + 同文本
//   + 3 秒内 → 判为重复丢弃。不能简单删掉 ② —— 窗口本来就开着时不会拉历史，
//   ② 是唯一的渲染者。
//
// 【故障二】桌宠聊天只有"三个点"，看不到推理与工具调用
//
//   `agent:event` 是 `event.sender.send(...)`，只发给**发起 agent:chat 的窗口**
//   （主窗口）。桌宠聊天窗是独立 BrowserWindow，一条也收不到。
//   修法：主窗口 PetChatSync 订阅事件、按 requestId 过滤，经 `pet:chat-trace`
//   中转给聊天窗，渲染成可折叠的推理链。
//
// 【为什么单测】两个故障都不报错、不崩溃：一个只是多画一个气泡，
//   一个是"少显示"信息。只能靠把规则抽出来跑 / 锁住接线来防回退。
// ============================================================

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const root = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8')

const petChatHtml = read(path.join('electron', 'pet', 'pet-chat.html'))
const petLive2dHtml = read(path.join('electron', 'pet', 'pet-live2d.html'))
const petWindowTs = read(path.join('electron', 'pet', 'petWindow.ts'))
const preloadTs = read(path.join('electron', 'preload.ts'))
const petChatSync = read(path.join('src', 'components', 'PetChatSync.tsx'))

/**
 * 把 pet-chat.html 里的「相邻重复判定」原样取出来求值。
 *
 * 为什么这么测而不是重写一份规则：重写一份就等于测了个仿制品 ——
 * 页面里那份写错了照样绿。这里直接跑**页面真正会执行的那段源码**。
 */
function loadDedupe() {
  const start = petChatHtml.indexOf('const DEDUPE_WINDOW_MS')
  expect(start).toBeGreaterThan(-1)
  const endMarker = 'function resetMsgDedupe()'
  const markerAt = petChatHtml.indexOf(endMarker, start)
  expect(markerAt).toBeGreaterThan(start)
  // 必须切到行尾 —— 只切到 `()` 会留下一句没有函数体的声明，求值时直接 SyntaxError
  const lineEnd = petChatHtml.indexOf('\n', markerAt)
  expect(lineEnd).toBeGreaterThan(markerAt)
  const src = petChatHtml.slice(start, lineEnd)

  const factory = new Function(`
    ${src}
    return { isDuplicateMsg, resetMsgDedupe, DEDUPE_WINDOW_MS };
  `)
  return factory() as {
    isDuplicateMsg: (role: string, text: string) => boolean
    resetMsgDedupe: () => void
    DEDUPE_WINDOW_MS: number
  }
}

describe('故障一：用户气泡被画两次', () => {
  it('同一句话紧跟着再来一次 → 判为重复', () => {
    const { isDuplicateMsg, resetMsgDedupe } = loadDedupe()
    resetMsgDedupe()
    expect(isDuplicateMsg('user', '让我帮你整理这部剧的资料吧')).toBe(false)
    expect(isDuplicateMsg('user', '让我帮你整理这部剧的资料吧')).toBe(true)
  })

  it('角色不同不算重复（用户和 Lumina 说了同一句话是正常的）', () => {
    const { isDuplicateMsg, resetMsgDedupe } = loadDedupe()
    resetMsgDedupe()
    expect(isDuplicateMsg('user', '好的')).toBe(false)
    expect(isDuplicateMsg('pet', '好的')).toBe(false)
  })

  it('文本不同不算重复', () => {
    const { isDuplicateMsg, resetMsgDedupe } = loadDedupe()
    resetMsgDedupe()
    expect(isDuplicateMsg('user', '第一句')).toBe(false)
    expect(isDuplicateMsg('user', '第二句')).toBe(false)
  })

  it('清空/历史回填后必须重置，否则历史的第一条会被误吞', () => {
    const { isDuplicateMsg, resetMsgDedupe } = loadDedupe()
    resetMsgDedupe()
    expect(isDuplicateMsg('user', '同一句')).toBe(false)
    resetMsgDedupe()
    expect(isDuplicateMsg('user', '同一句')).toBe(false)
  })

  it('去重窗口不超过 5 秒（太宽会吞掉用户真的重发）', () => {
    const { DEDUPE_WINDOW_MS } = loadDedupe()
    expect(DEDUPE_WINDOW_MS).toBeGreaterThanOrEqual(1000)
    expect(DEDUPE_WINDOW_MS).toBeLessThanOrEqual(5000)
  })

  it('addChatMsg 第一件事就是查重（否则等于没接上）', () => {
    const fnStart = petChatHtml.indexOf('function addChatMsg(role, text) {')
    expect(fnStart).toBeGreaterThan(-1)
    const body = petChatHtml.slice(fnStart, fnStart + 2600)
    const guard = body.indexOf('isDuplicateMsg(role, text)')
    expect(guard).toBeGreaterThan(-1)
    // 必须早于真正建 DOM 的那一行
    expect(guard).toBeLessThan(body.indexOf("document.createElement('div')"))
  })

  it('历史回填前重置去重状态', () => {
    const i = petChatHtml.indexOf("ipc.on('pet:sync-history-reply'")
    expect(i).toBeGreaterThan(-1)
    const seg = petChatHtml.slice(i, i + 700)
    expect(seg).toContain('resetMsgDedupe()')
  })

  it('不靠"删掉回显"来修 —— 卡片路径的回显必须保留（窗口已开时它是唯一渲染者）', () => {
    expect(petLive2dHtml).toMatch(/ipc\.send\('pet:sync-reply', \{ text, role: 'user' \}\)/)
  })
})

describe('故障二：桌宠聊天看不到推理过程', () => {
  it('preload 暴露 petSyncTrace → pet:chat-trace', () => {
    expect(preloadTs).toMatch(/petSyncTrace:\s*\(payload/)
    expect(preloadTs).toMatch(/ipcRenderer\.send\('pet:chat-trace', payload\)/)
  })

  it('主进程把 pet:chat-trace 中转到聊天窗（且只发聊天窗）', () => {
    expect(petWindowTs).toMatch(/ipcMain\.on\('pet:chat-trace'/)
    const i = petWindowTs.indexOf("ipcMain.on('pet:chat-trace'")
    const seg = petWindowTs.slice(i, i + 2200)
    expect(seg).toContain("wc.send('pet:chat-trace', data)")
    // 桌宠窗没有聊天流，不该收到
    expect(seg).not.toContain('petWindow,')
  })

  it('聊天窗加载期间先缓冲、加载完一次补发（首轮推理不能丢，也不能堆监听器）', () => {
    const i = petWindowTs.indexOf("ipcMain.on('pet:chat-trace'")
    const seg = petWindowTs.slice(i, i + 2200)
    expect(seg).toContain('wc.isLoading()')
    expect(seg).toContain('traceBuffer.push(data)')
    expect(seg).toContain('traceFlushHooked')
    // 关窗要清缓冲，否则新窗口会补发上一轮的旧思考
    expect(petWindowTs).toMatch(/traceBuffer = \[\]/)
  })

  it('PetChatSync 给每次请求打 requestId，并按它过滤事件', () => {
    expect(petChatSync).toMatch(/requestId:\s*reqId/)
    expect(petChatSync).toMatch(/ev\?\.requestId !== activeReqId/)
    // 事件必须真的转发出去
    expect(petChatSync).toMatch(/api\.petSyncTrace\?\./)
    expect(petChatSync).toMatch(/unsubAgentEvents\?\.\(\)/)
  })

  it('四种推理事件都有映射（思考 / 工具开始 / 工具结束 / 错误）', () => {
    for (const t of ["case 'thinking'", "case 'thinking_stream'", "case 'tool_start'", "case 'tool_end'", "case 'error'"]) {
      expect(petChatSync).toContain(t)
    }
  })

  it('聊天窗监听并渲染推理链', () => {
    expect(petChatHtml).toMatch(/ipc\.on\('pet:chat-trace'/)
    expect(petChatHtml).toContain('function tracePush(')
    expect(petChatHtml).toContain('function traceFinish(')
    expect(petChatHtml).toContain('.cp-trace')
    // 思考 / 工具 / 完成 三种图标都要有（完成态按成败二选一）
    expect(petChatHtml).toContain("tracePush('💭'")
    expect(petChatHtml).toContain("tracePush('🔧'")
    expect(petChatHtml).toMatch(/tracePush\(data\.ok === false \? '⚠️' : '✅'/)
  })

  it('回复到达时收起推理面板（否则面板会一直占着屏幕）', () => {
    const i = petChatHtml.indexOf("ipc.on('pet:sync-reply'")
    expect(i).toBeGreaterThan(-1)
    const seg = petChatHtml.slice(i, i + 1200)
    expect(seg).toContain('traceFinish(true)')
    expect(seg).toContain('endWait()')
  })

  it('收尾后断开引用 —— 下一轮要新建一块，而不是接到旧面板尾巴上', () => {
    const i = petChatHtml.indexOf('function traceFinish(')
    expect(i).toBeGreaterThan(-1)
    const seg = petChatHtml.slice(i, i + 500)
    expect(seg).toMatch(/_trace = null/)
  })

  it('流式推理原地更新，不是每 180ms 新起一行', () => {
    expect(petChatHtml).toMatch(/streamLine/)
    const i = petChatHtml.indexOf('function tracePush(')
    const seg = petChatHtml.slice(i, i + 1200)
    expect(seg).toMatch(/if \(isStream && tr\.streamLine\)/)
  })
})
