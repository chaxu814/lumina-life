// ============================================================
// chatQualityFixes.test.ts — 聊天质量审计 20 项修复的回归守卫
//
// 【来源】docs/Lumina-聊天质量审计-20261010.md（2×P0 + 6×P1 + 12×P2）
//
// 【为什么用源码不变式】
//   这些修复大多落在「需要真跑 Electron + 真调 LLM 才能验证」的路径上，
//   vitest 里没有端到端环境。源码不变式能守住「修复不被回退」，
//   而**纯函数部分另有真行为测试**（tokenEstimateParity / agentChatConcurrency
//   / imeComposing / petChatOrchestrator）。
//   每一条都写明「若回退会怎样」，便于后来者判断能否删。
// ============================================================

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf-8')

/**
 * 去掉行注释与块注释后的源码。
 *
 * 为什么需要：修复时会在注释里**引用被删掉的旧代码**（便于后来者理解为什么改），
 * 若 `not.toMatch(旧代码)` 直接扫全文，会被自己的注释误判成「旧代码还在」。
 * 断言「某段代码已不存在」时一律用这个版本。
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i)
      i = j < 0 ? n : j
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2)
      i = j < 0 ? n : j + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      out += c; i++
      while (i < n) {
        out += src[i]
        if (src[i] === '\\') { out += src[i + 1] ?? ''; i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    out += c; i++
  }
  return out
}

/** 只含代码、不含注释的源码 */
const readCode = (rel: string) => stripComments(read(rel))

describe('P0-1 · 群聊生成中切会话不再丢回复 / 覆盖存档', () => {
  const src = read('src/panels/GroupChatView.tsx')

  it('存在会话安全写入 helper commitToSession', () => {
    expect(src).toMatch(/const commitToSession = useCallback\(/)
    // 已切走时只写发起会话的存档，不碰当前视图
    expect(src).toMatch(/loadGCMessages\(sessionId\)/)
  })

  it('send 捕获发起会话 sessionAtSend', () => {
    expect(src).toMatch(/const sessionAtSend = activeSessionRef\.current/)
  })

  it('send 内不再出现「用闭包 activeSessionId 保存当前视图」的写法', () => {
    // 若回退：会把**当前**会话的消息写进发起会话的存档 → 静默数据损坏
    expect(readCode('src/panels/GroupChatView.tsx')).not.toMatch(/saveGCMessages\(activeSessionId, prev\)/)
  })

  it('animateTyping 接受可选 sessionId 并按会话提交', () => {
    // 参数名是 fullTextRaw（2026-10-13 起在函数内做空文本兜底），语义不变
    expect(src).toMatch(/const animateTyping = useCallback\(\(msgId: string, fullTextRaw: string, sessionId\?: string\)/)
    expect(src).toMatch(/const sid = sessionId \|\| activeSessionRef\.current/)
    expect(src).toMatch(/commitToSession\(sid,/)
  })

  it('用户消息与占位消息都立即落盘（生成中崩溃也不丢提问）', () => {
    expect(src).toMatch(/if \(activeSessionRef\.current === sessionAtSend\) \{saveGCMessages\(sessionAtSend, updated\)\}/)
  })
})

describe('P0-2 · 普通聊天回复归属发起会话', () => {
  const src = read('src/panels/ChatPanel.tsx')

  it('send 捕获 convAtSend，且所有回复写入都用它', () => {
    expect(src).toMatch(/const convAtSend = useStore\.getState\(\)\.activeConversationId \|\| activeConversationId/)
    // 若回退：回复会落到用户切换后的会话，原会话那条提问永远等不到回答
    expect(src).not.toMatch(/const finalConvId = useStore\.getState\(\)\.activeConversationId \|\| activeConversationId/)
    expect(src).toMatch(/const finalConvId = convAtSend/)
  })

  it('发给模型的历史也用发起会话（而非当前会话）', () => {
    expect(src).toMatch(/const latestConvId = convAtSend/)
  })

  it('打字机浮层只在仍停留在发起会话时播放', () => {
    expect(src).toMatch(/useStore\.getState\(\)\.activeConversationId === convAtSend/)
  })
})

describe('P1-1 · 群聊超时不再被 || 吃成 300s', () => {
  const src = read('electron/agentRunner.ts')

  it('社交模式用显式大值哨兵，而不是 falsy 的 0', () => {
    // 若回退：`isSocialMode ? 0 : ...` 会被 `|| 300` 吃掉落回 300s，
    //         群聊反而比普通聊天更容易超时
    expect(src).toMatch(/SOCIAL_MODE_TIMEOUT_SEC/)
    expect(readCode('electron/agentRunner.ts')).not.toMatch(/isSocialMode \? 0 :/)
  })

  it('超时文案按实际时长展示，且列出多个真实成因', () => {
    expect(src).toMatch(/timeoutLabel/)
    expect(src).toMatch(/本地模型正在被后台任务占用算力/)
  })
})

describe('P1-2 · 主动中止不再产出「我没能给出有效回复」', () => {
  const runner = read('electron/agentRunner.ts')
  const gc = read('src/panels/GroupChatView.tsx')

  it('后端：中止时跳过空结果恢复与兜底文案', () => {
    expect(runner).toMatch(/const _abortedByUser = !!this\.abortController\?\.signal\?\.aborted/)
    expect(runner).toMatch(/跳过空结果恢复与兜底文案/)
  })

  it('前端群聊：拿到结果后有 abortRef 守卫', () => {
    // 若回退：点「中断」后仍会渲染兜底文案，并可能触发链式火花
    expect(gc).toMatch(/if \(abortRef\.current\) \{\s*commitToSession\(sessionAtSend, prev => prev\.filter\(m => m\.id !== replyId\)\)/)
  })
})

describe('P1-3 · 用户设置的上下文窗口不再被 profile 覆盖', () => {
  const src = read('electron/agentRunner.ts')

  it('仅当用户没填（<=0）时才用 profile 推测值', () => {
    expect(src).toMatch(/const userCtx = Number\(\(this\.config as any\)\.contextWindow\) \|\| 0/)
    expect(src).toMatch(/userCtx > 0\s*\?\s*userCtx/)
    // 若回退：本地兜底档案的 256000 会把用户填的 8192/32768 丢掉
    expect(src).not.toMatch(/const ctx = profile\.model\.maxContextTokens \|\| 256_000\s*\n\s*;\(this\.config as any\)\.contextWindow = ctx/)
  })
})

describe('P1-4 · compactedContext 真正被使用', () => {
  const src = read('electron/agentRunner.ts')

  it('setHistory 暂存摘要，而不是丢弃', () => {
    expect(src).toMatch(/private _pendingCompactedContext: string = ''/)
    expect(src).toMatch(/this\._pendingCompactedContext = \(compactedContext \|\| ''\)\.trim\(\)/)
  })

  it('摘要在 initSystemPrompt() 之后注入（否则会被替换掉）', () => {
    // 若放在 0 号位：initSystemPrompt 会把 messages[0] 整体替换成系统提示词 → 摘要丢失
    expect(src).toMatch(/this\.messages\.splice\(1, 0, \{\s*role: 'system',\s*content: '\[历史摘要·非用户发言\]/)
    expect(src).toMatch(/this\._pendingCompactedContext = ''/)
  })
})

describe('P1-5 · token 估算统一（不再有 /4、/3.5）', () => {
  it('群聊历史预算改用 estimateTokens', () => {
    const gc = read('src/panels/GroupChatView.tsx')
    expect(gc).toMatch(/import \{ estimateTokens \} from '\.\.\/lib\/tokenEstimate'/)
    expect(gc).not.toMatch(/text\.length \/ 4/)
    expect(gc).not.toMatch(/content\.length \/ 4/)
  })

  it('agentRunner 的 token 上报改用 TokenEstimator', () => {
    const src = read('electron/agentRunner.ts')
    expect(src).not.toMatch(/completionText\.length \/ 3\.5/)
    expect(src).toMatch(/_tokEst\.estimate\(completionText\)/)
  })
})

describe('P1-6 · 本地端点探测降频（不再每条消息 +2s）', () => {
  const src = read('electron/ipc/agentIpc.ts')

  it('有 TTL 缓存，探通后一段时间内跳过', () => {
    expect(src).toMatch(/LOCAL_PROBE_TTL_MS/)
    expect(src).toMatch(/localEndpointRecentlyReachable/)
    expect(src).toMatch(/&& !localEndpointRecentlyReachable\(runConfig\.baseUrl\)/)
    // 探通要写缓存，失败要每次都探（保证自愈）
    expect(src).toMatch(/localProbeOkAt\.set\(runConfig\.baseUrl, Date\.now\(\)\)/)
  })
})

describe('P2-1 · 事件按请求归属，后台事件不外发', () => {
  const src = read('electron/ipc/agentIpc.ts')

  it('后台任务不订阅事件回调', () => {
    expect(src).toMatch(/if \(!isBackground\) \{\s*agent\.setEventCallback\(/)
    expect(src).toMatch(/后台任务事件不外发/)
  })

  it('前台事件回显 config.requestId', () => {
    expect(src).toMatch(/const reqId = \(params\.config as any\)\?\.requestId/)
    expect(src).toMatch(/reqId \? \{ \.\.\.ev, requestId: reqId \} : ev/)
  })

  it('前端按 requestId 过滤', () => {
    expect(read('src/panels/GroupChatView.tsx')).toMatch(/ev\.requestId !== requestId/)
    expect(read('src/panels/ChatPanel.tsx')).toMatch(/\(ev as any\)\.requestId !== reqId/)
  })
})

describe('P2-3 / P2-4 / P2-5 · 前端体验修复', () => {
  it('P2-3：打字机播放期间隐藏列表里那条重复回复', () => {
    const src = read('src/panels/ChatPanel.tsx')
    expect(src).toMatch(/msg\.content === fullResponseRef\.current/)
  })

  it('P2-4：群聊超时文案用常量而非硬编码 300', () => {
    const src = read('src/panels/GroupChatView.tsx')
    expect(src).not.toMatch(/群聊回复超时（300秒）/)
    expect(src).toMatch(/Math\.round\(GC_CHAT_HARD_MS \/ 1000\)/)
  })
})

describe('P2-6 / P2-7 / P2-8 / P2-9 · 主进程上下文修复', () => {
  const runner = read('electron/agentRunner.ts')

  it('P2-6：超预算时保留身份 system + 用户问题（不再丢 persona，也不再丢问题）', () => {
    // 🔧 2026-10-12：裁剪决策已抽到纯函数模块 electron/agent/contextBudget.ts
    //   （行为测试见 tests/contextBudget.test.ts）。这里只钉住"取哪些"的契约。
    const budget = read('electron/agent/contextBudget.ts')
    expect(runner).toContain("from './agent/contextBudget'")
    // 保留首条 system（身份/工具说明）
    expect(budget).toMatch(/const keepSys = sysMsgs\.length > 0 \? \[sysMsgs\[0\]\] : \[\]/)
    // 超预算时也必须带上**用户本轮的问题** —— 旧实现只留最后 3 条非 system，
    //   而问题不在其中，模型会回「这是我们的第一次对话」（实测 2026-10-12）
    expect(budget).toContain('otherMsgs.indexOf(mustKeep)')
    // 旧写法（只留最后一条 system + 最后 3 条非 system）必须彻底消失
    expect(budget).not.toMatch(/return \[\.\.\.sysMsgs\.slice\(-1\), \.\.\.otherMsgs\.slice\(-3\)\]/)
    expect(runner).not.toMatch(/return \[\.\.\.keepSys, \.\.\.otherMsgs\.slice\(-3\)\]/)
  })

  it('P2-7：内部摘要不再拼进用户可见回复', () => {
    expect(readCode('electron/agentRunner.ts')).not.toMatch(/finalText_ = this\._compressedSummary \+ '\\n\\n'/)
    // 改为作为总结轮的上下文注入
    expect(runner).toMatch(/\[历史摘要·非用户发言\] 以下是更早对话的压缩摘要/)
  })

  it('P2-8：压缩保留段只取非 system（否则 system 会出现两份）', () => {
    const src = read('electron/agentCompactor.ts')
    expect(src).toMatch(/const nonSystemMsgs = messages\.filter\(m => m\.role !== 'system'\)/)
    expect(src).toMatch(/const recentMsgs = nonSystemMsgs\.slice\(-COMPACTOR_RECENT_PAIRS\)/)
  })

  it('P2-9：首条消息也参与去重（不再要求 length>=2）', () => {
    expect(runner).not.toMatch(/if \(this\.messages\.length >= 2\) \{\s*\n\s*const last = this\.messages\[this\.messages\.length - 1\]/)
    expect(runner).toMatch(/if \(this\.messages\.length >= 1\) \{/)
  })
})

describe('P2-10 / P2-11 · 桌宠编排器', () => {
  const src = read('src/lib/petChatOrchestrator.ts')

  it('P2-10：续轮指令不再被持久化成 user 消息', () => {
    // 若回退：这条内部指令会混进主窗桌宠历史并被回推给桌宠窗
    expect(src).not.toMatch(/this\.deps\.addMessage\('user', continuationText\)/)
    expect(src).toMatch(/\.\.\.this\.deps\.getHistory\(\),\s*\n\s*\{ role: 'user', content: continuationText \}/)
  })

  it('P2-10：移除「空实现」的 removeLastAssistantPlaceholder', () => {
    expect(src).not.toMatch(/removeLastAssistantPlaceholder/)
  })

  it('P2-11：占位判定对强/弱信号统一施加 ≤80 字门槛', () => {
    // 若回退：长回复也会被判为占位 → 白多打一轮 LLM
    expect(src).toMatch(/if \(t\.length > 80\) \{return false\}/)
  })
})

describe('P2-12 · llmRetry 不再有「空桩心跳」', () => {
  const src = read('electron/llmRetry.ts')

  it('空桩实现与死代码已删除', () => {
    expect(src).not.toMatch(/function setupStreamHeartbeat/)
    expect(src).not.toMatch(/export async function fetchStreamingWithHeartbeat/)
    expect(src).not.toMatch(/async function fetchWithIdleTimeout/)
    expect(src).not.toMatch(/STREAM_HEARTBEAT_INTERVAL/)
  })

  it('保留真正在用的 fetchWithRetry，且其超时正常生效', () => {
    expect(src).toMatch(/export async function fetchWithRetry/)
    expect(src).toMatch(/const timeoutId = setTimeout\(\(\) => controller\.abort\(\), currentTimeout\)/)
    expect(src).toMatch(/这里提供接口框架/)   // 说明块里引用了原自述，便于追溯
  })
})

describe('运行时验证追加修复 · 上下文窗口一致性（2026-10-10 实测）', () => {
  const runner = readCode('electron/agentRunner.ts')

  it('callLLM 的 maxContextTokens 必须优先取已解析的有效窗口（而非只看 profile）', () => {
    // 若回退：日志与「预检超预算」都按 profile 的 256000 判断，
    //         对 32K 模型永远不会告警 → 超长 prompt 直接发出 → prefill 卡死
    expect(runner).toMatch(/this\._effectiveContextWindow/)
    expect(runner).not.toMatch(/String\(profile\?\.model\.maxContextTokens \|\| 256_000\),/)
  })

  it('构造器的 profile 兜底不得覆盖用户/能力画像已算好的 contextWindow', () => {
    // 若回退：_applyAgentLlmConfig 刚按用户配置算出的窗口会被 profile 的 256000 冲掉
    expect(runner).toMatch(/const userCtx = Number\(\(this\.config as any\)\.contextWindow\) \|\| 0/)
  })

  it('Agent 配置的 maxContextTokens 映射到 contextWindow，而不是 maxTokens', () => {
    const ac = readCode('electron/agentConfig.ts')
    expect(ac).toMatch(/contextWindow: cfg\.maxContextTokens \|\| 0/)
    expect(ac).not.toMatch(/maxTokens: cfg\.maxContextTokens/)
  })
})
