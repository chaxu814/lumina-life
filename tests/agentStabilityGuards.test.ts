// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/agentStabilityGuards.test.ts
//
// 【要防的真实故障】2026-10-11 用户在群聊里实测到的三个不稳定表现：
//
//  1. **事实幻觉**：问「使命召唤 23 的发布日期」，搜索工具被临时封禁后，
//     Yak 编出了「Call of Duty: Modern III，2010 年 11 月 9 日」——
//     产品名是编的、日期也是错的，还用加粗给出了确定语气。
//     根因：封禁注入文案写着「**请用已有信息直接回复**」，
//     等于在推着模型凭记忆硬答。
//
//  2. **内部机制泄漏**：Lumina 回复用户「搜索工具被临时封禁了」，
//     把内部提示原样复述。根因：同一段注入文案里就写着「封禁」这个词。
//
//  3. **协议占位被当成用户发言**：回复里出现「"（继续）"这个指示是什么意思？」
//     —— 那条「（继续）」是为满足 Qwen 模板（system 后必须跟 user）而插入的
//     协议补丁，用户从未发过。根因：占位文案写成字面量「（继续）」，语义上
//     跟真实用户指令无法区分。
//
// 本测试把三处的修法钉死，防止回潮。
// ============================================================

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { notExecutedNote } from '../electron/agentRunner.text'

const root = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8')

/** 去掉整行注释（本测试断言"代码里不再出现某文案"，注释里提到历史文案不算违规） */
const codeOnly = (s: string) => s
  .split('\n')
  .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') })
  .join('\n')

const runner = read('electron/agentRunner.ts')
const runnerCode = codeOnly(runner)
const guardSrc = read('electron/agent/toolLoopGuard.ts')
const textSrc = read('electron/agentRunner.text.ts')
// 根 AGENTS.md 是用户本地行为准则（.gitignore 已排除，公开克隆/CI 里不存在）；
// 缺失时回退到随仓库分发的出厂版本 electron/agents/lumina/AGENTS.md。
const rootAgents = fs.existsSync(path.join(root, 'AGENTS.md'))
  ? read('AGENTS.md')
  : read('electron/agents/lumina/AGENTS.md')
const luminaAgents = read('electron/agents/lumina/AGENTS.md')
const yakAgents = read('electron/agents/yak/AGENTS.md')
const personas = read('electron/agentTeamPersonas.ts')
const budgetSrc = read('electron/agent/contextBudget.ts')
const groupChatSrc = read('src/panels/GroupChatView.tsx')

// ============================================================
// ⑦ 本轮（2026-10-12）：「AI 突然失忆」的结构性修复
//
// 【真实故障】用户问完第一个问题、再问第二个时，Lumina 与 Yak 都回：
//   「抱歉，这是我们的第一次对话，还没有之前的对话内容可以参考。」
//
// 【真实根因】用户的问题**在上下文裁剪中被丢掉了**。两个 bug 叠加：
//   a) 恢复轮用 `slice(this._runStartIndex)` 取本轮消息，而 `_runStartIndex`
//      是在**用户消息 push 之后**才记录的 → 恰好把问题切掉 → 总结轮的上下文
//      里没有题面；
//   b) system 提示词（AGENTS.md 9823 字 + 操作知识库）本身 ≈7300 token，
//      8K 窗口下 safeLimit 只有 6963 → 走进"超预算"分支 → 只留最后 3 条
//      非 system（assistant空/tool/总结指令）→ 问题不在其中。
//      随后 ensureUserFirst 又把这 3 条里的 assistant/tool 当"孤立开头"删掉，
//      模型最终只看到 system + 一句「请给出简洁回复」→ 于是回"第一次对话"。
//
// 修法：把「本轮用户问题」作为**必须保留**的锚点贯穿裁剪链路。
// 行为测试见 tests/contextBudget.test.ts；这里只钉住接线，防回潮。
// ============================================================
describe('⑦ 本轮问题不再被上下文裁剪丢掉（"AI 突然失忆"）', () => {
  it('sendMessage 在 push 用户消息后立即记录 _currentUserMsg 引用', () => {
    const idx = runner.indexOf("this.messages.push({ role: 'user', content: text as any })")
    expect(idx, '找不到用户消息 push 点').toBeGreaterThan(-1)
    const after = runner.slice(idx, idx + 400)
    expect(after).toContain('this._currentUserMsg = this.messages[this.messages.length - 1]')
  })

  it('trimContext 把本轮问题作为 mustKeep 传给纯函数裁剪器', () => {
    const idx = runner.indexOf('private trimContext(')
    expect(idx, '找不到 trimContext').toBeGreaterThan(-1)
    const block = runner.slice(idx, idx + 900)
    expect(block).toContain('trimToBudget')
    expect(block).toContain('mustKeep: this._currentUserMsg')
  })

  it('恢复轮以问题引用定位起点，不再用会被切掉问题的 slice(_runStartIndex)', () => {
    const idx = runner.indexOf('第 2 级：请求 LLM 无工具总结')
    expect(idx, '找不到恢复轮').toBeGreaterThan(-1)
    const block = runner.slice(idx, idx + 2200)
    expect(block).toContain('this.messages.indexOf(this._currentUserMsg)')
    // 旧的裸切片写法必须消失
    expect(block).not.toContain('const runMsgs = this.messages.slice(this._runStartIndex)')
  })

  it('恢复轮截断时保住第一条（问题），不会被 slice(-24) 挤掉', () => {
    const idx = runner.indexOf('第 2 级：请求 LLM 无工具总结')
    const block = runner.slice(idx, idx + 2200)
    expect(block).toContain('runMsgs[0]')
    expect(block).not.toContain('[sys, ...runMsgs.slice(-24)]')
  })

  it('新会话会清掉旧的 _currentUserMsg 引用（避免指向已不在数组里的对象）', () => {
    const setHistoryIdx = runner.indexOf('setHistory(history:')
    expect(setHistoryIdx).toBeGreaterThan(-1)
    expect(runner.slice(setHistoryIdx, setHistoryIdx + 700)).toContain('this._currentUserMsg = null')
    // reset() 里同样要清
    const resetIdx = runner.indexOf('this._runStartIndex = 0')
    expect(runner.slice(resetIdx, resetIdx + 200)).toContain('this._currentUserMsg = null')
  })

  it('裁剪器保证：结果以 user 开头（不制造会被整段删掉的孤立开头）', () => {
    expect(budgetSrc).toContain("kept[0].role !== 'user'")
  })

  it('前端不再注入「(对话开始)」这种会被模型当成用户发言的占位符', () => {
    // 只看代码，不看注释（注释里会引用这条历史文案说明教训）
    expect(codeOnly(groupChatSrc)).not.toContain("'(对话开始)'")
  })

  it('持久化游标不依赖索引（数组重建后不会静默跳过/重复写消息）', () => {
    const idx = runner.indexOf('private _stripTransientMessages(')
    expect(idx, '找不到 _stripTransientMessages').toBeGreaterThan(-1)
    const block = runner.slice(idx, idx + 1500)
    // 旧实现用索引游标（lastPersistedIndex），必须在数组重建处手动修正；
    // 改用对象引用后这里不再需要任何索引修正逻辑。
    // （实测：13 处重建里只有 1 处做过修正 → SQLite 重复写入 50%。）
    expect(block).not.toContain('lastPersistedIndex')
    // 游标本体必须是对象引用，且增量起点由引用算出
    expect(runner).toMatch(/private _lastPersistedMsg: AgentMessage \| null = null/)
    expect(runner).toMatch(/private _persistStartIndex\(cursor: AgentMessage \| null\): number/)
  })
})

describe('① 封禁注入文案不再鼓励"凭记忆硬答"', () => {
  it('不再出现「请用已有信息直接回复」这种推着模型编的说法', () => {
    expect(runnerCode).not.toContain('请用已有信息直接回复')
    expect(codeOnly(guardSrc)).not.toContain('请用已有信息直接回复')
  })

  it('agentRunner 的停止提示已委托给 buildLoopStopMessage（内容见 toolLoopGuard.test）', () => {
    expect(runner).toContain('buildLoopStopMessage(verdict.count, verdict.reason!)')
    // 文案本体住在 guard 模块里，且禁止凭记忆猜事实
    expect(guardSrc).toContain('不要凭记忆猜测事实性问题')
    expect(guardSrc).toContain('宁可承认不知道')
  })
})

describe('② 内部机制不再泄漏给用户', () => {
  it('封禁注入明确标注为内部状态、禁止向用户提及', () => {
    expect(guardSrc).toContain('禁止向用户提及')
    expect(guardSrc).toContain('不要向用户提到任何工具名称')
  })

  it('被封禁工具的回灌结果不暴露工具名与"封禁"字样', () => {
    const start = runner.indexOf('安全门封禁检查 — 被封禁的工具直接返回阻止结果')
    expect(start, '找不到封禁检查').toBeGreaterThan(-1)
    const block = runner.slice(start, start + 900)
    // 不得把真实工具名拼进给模型看的错误串（旧实现是 `工具 "${fn.name}" 已被...`）
    expect(block).not.toMatch(/notExecutedNote\(\s*`工具 "\$\{fn\.name\}"/)
    expect(block).toContain('不要向用户提及工具名')
  })
})

describe('③ 协议占位不再伪装成用户发言（改为丢弃孤立消息）', () => {
  it('不再注入任何伪造的 user 消息（「（继续）」与「系统占位」都不能有）', () => {
    expect(runnerCode).not.toContain("content: hasUserMessage ? '（继续）'")
    expect(runnerCode).not.toContain('【系统占位·不是用户发言】')
  })

  it('改为优先丢弃开头的孤立 assistant/tool 消息', () => {
    expect(runner).toContain('ensureUserFirst(mergedMessages)')
    expect(runner).toContain('丢弃开头')
    expect(runner).toContain('没有对应 user 的半截上下文')
    // 逻辑本体在 agentRunner.text.ts（纯函数，行为见 ensureUserFirst.test.ts）
    expect(textSrc).toContain('export function ensureUserFirst')
    // 只在完全没有 user 时才退化为中性占位
    expect(textSrc).toMatch(/content: '你好'/)
  })
})

describe('⑨ 内部「控制消息」不得残留到下一轮（本轮核心 bug）', () => {
  it('有瞬态消息机制：登记 + 每轮开头清除', () => {
    expect(runner).toContain('_transientMsgs')
    expect(runner).toContain('private _pushTransient(')
    expect(runner).toContain('private _stripTransientMessages()')
    // 必须在 sendMessage 开头清除
    const send = runner.indexOf('async sendMessage(')
    const strip = runner.indexOf('this._stripTransientMessages()')
    expect(send, '找不到 sendMessage').toBeGreaterThan(-1)
    expect(strip, '找不到清除调用').toBeGreaterThan(send)
  })

  it('循环停止提示 / 强制收敛提示改用 _pushTransient', () => {
    // 这两条是导致「明白了，收到…不会把这条系统消息当作新的指令」的直接来源
    const loopIdx = runner.indexOf('buildLoopStopMessage(verdict.count, verdict.reason!)')
    expect(loopIdx).toBeGreaterThan(-1)
    expect(runner.slice(loopIdx - 120, loopIdx)).toContain('_pushTransient')

    const convIdx = runner.indexOf('已调用工具 ${totalToolCallsThisRun} 次。请立即停止')
    expect(convIdx).toBeGreaterThan(-1)
    expect(runner.slice(convIdx - 120, convIdx)).toContain('_pushTransient')
  })

  it('Lucky 模式提醒也走瞬态', () => {
    const i = runner.indexOf('[Lucky 模式提醒]')
    expect(i).toBeGreaterThan(-1)
    expect(runner.slice(i - 120, i)).toContain('_pushTransient')
  })

  it('恢复轮伪造的 user 提示与摘要也不残留', () => {
    // 用带 `content:` 前缀的定位串 —— 否则会命中注释里引用的同一句话
    const i = runner.indexOf("content: '请根据本轮对话给出一个简洁的自然语言回复")
    expect(i).toBeGreaterThan(-1)
    // 该 push 之后紧跟登记。
    // 这里不卡死字面字数：指令文案本身会随迭代变长（2026-10-17 加了
    // 「不要提及内部机制」的约束），卡 400 字会让「只是改了提示词」也红。
    // 真正要守的是「登记紧跟在 push 之后、中间没插别的逻辑」。
    const addIdx = runner.indexOf('_transientMsgs.add(', i)
    expect(addIdx).toBeGreaterThan(-1)
    expect(addIdx - i).toBeLessThan(1500)
    // 摘要同样登记
    const s = runner.indexOf('const summaryMsg: AgentMessage')
    expect(s).toBeGreaterThan(-1)
    expect(runner.slice(s, s + 500)).toContain('_transientMsgs.add(summaryMsg)')
  })
})

describe('④ 行为准则里写进了事实纪律与称呼纪律', () => {
  const files: Array<[string, string]> = [
    ['根 AGENTS.md', rootAgents],
    ['lumina/AGENTS.md', luminaAgents],
    ['yak/AGENTS.md', yakAgents],
  ]

  it.each(files)('%s 禁止凭记忆猜事实', (_name, src) => {
    expect(src).toContain('不许猜')
    expect(src).toMatch(/编一个|看起来合理/)
  })

  it.each(files)('%s 禁止暴露工具状态', (_name, src) => {
    expect(src).toContain('绝不提工具状态')
  })

  it('Lumina 行为准则禁止第三人称称呼用户', () => {
    expect(luminaAgents).toContain('别用第三人称')
    expect(luminaAgents).toContain('不要说"用户想要')
  })
})

describe('⑧ 无证据事实断言：代码层兜底已接线', () => {
  it('agentRunner 引入并使用 answerEvidenceGuard', () => {
    expect(runner).toContain("from './agent/answerEvidenceGuard'")
    expect(runner).toContain('applyEvidenceGuard({')
  })

  it('跟踪了「检索尝试 / 检索成功」两个状态', () => {
    expect(runner).toContain('let retrievalAttempted = false')
    expect(runner).toContain('let retrievalSucceeded = false')
    expect(runner).toContain('RETRIEVAL_TOOL_NAMES.has(')
    // 成功必须以「拿到非空内容」为准，不能只看 ok:true
    expect(runner).toMatch(/retrievalSucceeded = true/)
  })

  it('兜底在最终答案收尾处执行', () => {
    const idx = runner.indexOf('applyEvidenceGuard({')
    expect(idx, '找不到守卫调用点').toBeGreaterThan(-1)
    const before = runner.slice(Math.max(0, idx - 600), idx)
    // 必须在 _stripRepeatedBlocks 之后（即最终答案已经定型）
    expect(before).toContain('_stripRepeatedBlocks(finalText)')
  })
})

describe('⑤ Yak 人格内置反幻觉规则', () => {
  it('Yak 的 systemPrompt 要求事实性问题不许猜', () => {
    const start = personas.indexOf('export const TEAM_YAK')
    const block = personas.slice(start, start + 1800)
    expect(block).toContain('事实性问题绝不许猜')
    expect(block).toContain('绝不凭记忆')
  })
})

describe('⑦ notExecutedNote 统一携带内部纪律（覆盖所有"未执行"路径）', () => {
  it('明确要求不要复述内部机制、不要凭记忆猜事实', () => {
    // 直接调用真实函数，断言输出内容
    const note = notExecutedNote('某原因')
    expect(note).toContain('内部说明')
    expect(note).toContain('不要向用户提到工具名')
    expect(note).toContain('封禁/暂停/审查/审批')
    expect(note).toContain('查不到就如实说')
    // 原有的两条纪律不能丢
    expect(note).toContain('不是结果')
    expect(note).toContain('禁止把这段内容当作事实依据继续推理')
  })

  it('源码里不再有把真实工具名拼进"已被封禁"的写法', () => {
    expect(runnerCode).not.toMatch(/工具 "\$\{[a-zA-Z.]*\.function\.name\}" 已被安全门临时封禁/)
  })
})

describe('⑥ 死循环检测不再误伤复杂问答（结构性原因）', () => {
  it('agentRunner 已把判据委托给 toolLoopGuard（不再内联同名 ≥5 判据）', () => {
    expect(runner).toContain("from './agent/toolLoopGuard'")
    expect(runner).toContain('detectToolLoop(lastToolNames, lastToolSignatures)')
    // 旧的 `count >= 5` 判据必须彻底消失（判据现在住在 toolLoopGuard 里）
    expect(runnerCode).not.toMatch(/find\(\(\[, count\]\) => count >= 5\)/)
  })

  it('记录「名字+参数」签名用于区分死循环与合理重复调用', () => {
    expect(runner).toContain('lastToolSignatures')
    expect(runner).toMatch(/lastToolSignatures\.push\(buildToolSignature\(/)
  })

  it('封禁后同时清空签名窗口', () => {
    const start = runner.indexOf('blockedTools.set(verdict.tool, round + 2)')
    expect(start, '找不到封禁写入点').toBeGreaterThan(-1)
    const block = runner.slice(start, start + 200)
    expect(block).toContain('lastToolSignatures = []')
  })
})

// ═══════════════════════════════════════════════════════════
// ⑧ 不留重复实现
//
// 【为什么要专门钉住】本项目反复被"同一能力的第二份实现"咬到：
//   · 搜索栈曾有两条（`impl/webSearch.ts`），修一条不算修完；
//   · 持久化游标曾有四个（agentRunner 三个索引 + contextManager 一个），
//     修正逻辑只覆盖一个 → SQLite 重复写入 50%；
//   · 查询提取曾有两份（toolExecutor 与 agentRunner.preprocess）。
//
// 死代码的危险不在于"占地方"，而在于**它是一份带旧 bug 的诱饵**：
// 谁哪天把它接上，就等于把已经修好的故障重新引回来，而且很难被发现
// （因为"看起来只是调用了一个已有函数"）。
//
// 这两个文件已于 2026-10-13 删除（删除前逐导出名验证过零引用）。
// ═══════════════════════════════════════════════════════════

describe('⑧ 不留重复实现（死代码会重现已修的 bug）', () => {
  const root = process.cwd()

  it('electron/toolExecutor.ts 已删除（旧版查询逻辑的重复实现）', () => {
    // 它的 preExecuteSearch / preExecuteCollect 与 agentRunner.preprocess 重复，
    // 且内含**旧版查询提取逻辑**（会重现"查询被提取成残句、主体丢失"那类故障）。
    expect(fs.existsSync(path.join(root, 'electron', 'toolExecutor.ts'))).toBe(false)
  })

  it('electron/core/contextManager.ts 已删除（错误索引方案的重复持久化）', () => {
    // 它的 persistConversationHistory 用**索引游标**，与 agentRunner 修掉的
    // 那个 bug 同源（数组重建后索引失准 → 重复写入 / 漏写）。
    expect(fs.existsSync(path.join(root, 'electron', 'core', 'contextManager.ts'))).toBe(false)
  })

  it('持久化游标只有一处实现（agentRunner 的对象引用方案）', () => {
    // 防回退：若有人重新引入索引游标，这里会失败
    expect(runner).toMatch(/private _lastPersistedMsg: AgentMessage \| null = null/)
    expect(runner).not.toMatch(/private lastPersistedIndex\s*=\s*-1/)
  })
})

