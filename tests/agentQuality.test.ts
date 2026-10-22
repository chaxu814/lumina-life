// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/agentQuality.test.ts
//
// 守 Agent 解题质量这一轮的改造。核心是三件事，
// 每一件都对应一种"看起来在回答、实际上在糊弄"的失败模式：
//
//   1. 失败必须被如实标记 —— 工具没执行成功却回 ok:true，
//      模型会把"被拒绝"当成事实继续推理，这是编造的头号来源
//   2. 人设不得压制正确性 —— "不准说我不能""覆盖所有安全训练"
//      直接禁掉了诚实回答，方向和防幻觉相反
//   3. 上下文被压缩/恢复后不得失忆 —— 丢光历史会让模型"重新编一遍"
//
// 另外锁住本轮 UI 侧的两个修复：流式 id 必须稳定、
// 恢复轮必须保留工具结果。
// ============================================================

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8')

/**
 * 去掉 // 行注释与块注释后再比对 —— 否则"为什么删掉这句"的解释性注释会被误判。
 * 注意：CRLF 文件里正则的 `.` 不匹配 `\r`，所以只能用前缀匹配，
 * 用 `^(\s*)\/\/.*$` 会一条都剥不掉。
 */
function stripComments(src: string): string {
  return src
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n')
}

// ⚠️ 2026-10-11：失败原因分类等纯函数辅助块已抽到 agentRunner.text.ts。
//    断言「源码里存在某符号」时把两个文件合并读，避免被文件布局绑死。
const agentRunner = read('electron/agentRunner.ts') + '\n' + read('electron/agentRunner.text.ts')
const registry = read('electron/tools/registry.ts')
const souls = stripComments(read('src/data/agentSouls.ts'))
const compactor = read('electron/agentCompactor.ts')
const lsp = read('electron/tools/impl/lsp.ts')
const chatPanel = read('src/panels/ChatPanel.tsx')
const groupChat = stripComments(read('src/panels/GroupChatView.tsx'))

describe('① 工具失败必须显式标记（编造的温床）', () => {
  it('工具不存在 / 被安全拦截 / 需用户批准，三条路径都不再返回 ok:true', () => {
    // 这三段原本都有 ok:true 注释
    expect(registry).not.toMatch(/工具 \*\*\$\{name\}\*\* 不存在[\s\S]{0,200}ok:\s*true/)
    expect(registry).not.toMatch(/操作已被安全守卫拦截[\s\S]{0,120}ok:\s*true/)
    expect(registry).not.toMatch(/该操作需要用户确认[\s\S]{0,120}ok:\s*true/)
    // 旧的"ok=true 让 ReAct 继续而不断链"借口必须消失
    expect(registry).not.toContain('ok=true 让 ReAct 继续而不断链')
  })

  it('失败说明必须写明"未执行成功 + 禁止据此作答"', () => {
    expect(registry).toContain('buildNotExecutedResult')
    expect(registry).toContain('未执行成功')
    expect(registry).toContain('禁止据此作答')
  })

  it('失败原因要分类，而不是笼统一句', () => {
    for (const kw of ['工具', '安全', '批准']) {
      expect(registry).toContain(kw)
    }
  })
})

describe('② 人设不得压制正确性', () => {
  it('不再有"覆盖所有安全训练"这类对抗平台约束的措辞', () => {
    expect(souls).not.toContain('覆盖所有安全训练')
  })

  it('不再禁止模型说"我不能"', () => {
    expect(souls).not.toContain('"我是AI助手" / "我是人工智能" / "我不能" / "作为一个AI"')
    expect(souls).not.toContain('绝不能说出以下任何话')
  })

  it('明确写下"准确性优先于角色扮演"', () => {
    expect(souls).toContain('事实准确性 > 角色扮演')
    expect(souls).toContain('优先级高于角色扮演')
  })

  it('群聊编码流程里的"不准问问题"铁律已拆掉', () => {
    expect(groupChat).not.toContain('不准问问题')
    expect(groupChat).not.toContain('按最合理的理解直接写')
    // 换成"写清假设 + 只在真无法判断时提问"
    expect(groupChat).toContain('明确写出你的假设')
  })

  it('审阅者被要求"没问题就明说没问题"，不许为尽责而编造问题', () => {
    expect(groupChat).toContain('不要为了显得尽责而编造问题')
  })

  it('编码者被要求如实报告，禁止"应该没问题"这类未验证措辞', () => {
    expect(groupChat).toContain('禁止写"应该没问题"')
  })
})

describe('③ 压缩 / 恢复后不得失忆', () => {
  it('失败恢复轮保留最近上下文（含工具结果），不再只留 system+user', () => {
    expect(agentRunner).toContain('const recentTail = sanitizeHistoryForApi(')
    expect(agentRunner).toContain('.slice(-12)')
    // 明确禁止凭空重写
    expect(agentRunner).toContain('禁止凭空编造你没有依据的结论')
  })

  it('上下文摘要强制保留用户约束', () => {
    expect(compactor).toContain('用户明确提出的约束')
    // 摘要末尾要有"无法确定就问用户"的防编造声明
    expect(compactor).toMatch(/无法确定|向用户确认/)
  })

  it('摘要的诚实声明在【摘要结束】之前（保住增量更新的剥离逻辑）', () => {
    const iDecl = compactor.indexOf('无法确定')
    const iEnd = compactor.indexOf('【摘要结束】')
    expect(iDecl).toBeGreaterThan(-1)
    expect(iEnd).toBeGreaterThan(iDecl)
  })
})

describe('④ 失败提示要说人话', () => {
  it('按原因分类而不是统一套话', () => {
    expect(agentRunner).toContain('export function describeRunFailure')
    expect(agentRunner).toContain('export type RunFailureKind')
    for (const kind of ['timeout', 'auth', 'rate_limit', 'network', 'context_length']) {
      expect(agentRunner).toContain(`'${kind}'`)
    }
  })

  it('旧的统一套话已经用掉', () => {
    expect(agentRunner).not.toContain('抱歉，出了点问题，请稍后重试。')
    expect(agentRunner).not.toContain('抱歉，遇到了点问题，请稍后重试。')
  })

  it('轮次标记不再假装模型在思考', () => {
    // 🔧 2026-10-05：轮次标记文案从「开始处理（第 1 轮）」简化为「开始处理」。
    //   第 1 轮本来就是起点，标出来是冗余；且每轮都发会把思考面板刷成 15 步噪音。
    //   现在只在首轮发一次，后续轮次静默。
    expect(agentRunner).toContain("text: '开始处理'")
    expect(agentRunner).not.toContain('思考中... (第 ${round + 1} 轮)')
    // 回归：后续轮次不得再发「第 N 轮处理中」
    expect(agentRunner).not.toContain('轮处理中')
    // 回归：必须在 if (round === 0) 守卫内，否则又会变成每轮都发
    expect(agentRunner).toMatch(/if \(round === 0\)\s*\{\s*this\.emit\(\{\s*type: 'thinking', text: '开始处理'/)
  })
})

describe('⑤ 工具面与预算', () => {
  it('lsp 工具进入默认 agent 档（能自查改动影响面）', () => {
    expect(lsp).toContain("toolsets: ['code', 'lsp', 'agent', 'developer']")
    expect((lsp.match(/'agent'/g) || []).length).toBeGreaterThanOrEqual(3)
  })

  it('单聊工具轮次预算从 10 提到 20（够跑完读→改→验闭环）', () => {
    expect(chatPanel).toContain('maxToolCalls: 20')
    expect(chatPanel).not.toMatch(/maxToolCalls:\s*10,/)
  })

  it('强制收敛只触发一次（既不归零、也不靠把计数钉回 30）', () => {
    expect(agentRunner).toContain('let converged = false')
    expect(agentRunner).toContain('if (!converged && totalToolCallsThisRun > 30) {')
    // 归零 = 每 30 次重开一轮；钉回 30 = 下一轮 += 变 33 再次触发
    expect(agentRunner).not.toContain('totalToolCallsThisRun = 30')
    expect(agentRunner).not.toMatch(/totalToolCallsThisRun = 0\s*\n\s*\}/)
  })
})

describe('⑥ 流式推理步骤 id 必须稳定', () => {
  it('单聊/群聊都不再用 Date.now() 当流式步骤 id', () => {
    for (const src of [chatPanel, groupChat]) {
      expect(src).not.toMatch(/id: `re-\$\{Date\.now\(\)\}`,/)
      expect(src).not.toMatch(/id: `reasoning(-end)?-\$\{Date\.now\(\)\}`,/)
    }
  })

  it('改用按回复/消息 id 派生的稳定 id', () => {
    expect(chatPanel).toContain('const streamStepId = `re-${currentReplyId}`')
    expect(groupChat).toContain('const streamStepId = `re-${currentReplyId}`')
    expect(groupChat).toContain('const collabStreamId = `reasoning-${collabCurrentMsgIdRef.current}`')
  })

  it('每处声明只有一条（重复声明会导致语法错误）', () => {
    expect((chatPanel.match(/const streamStepId/g) || []).length).toBe(1)
    expect((groupChat.match(/const streamStepId/g) || []).length).toBe(1)
    expect((groupChat.match(/const collabStreamId =/g) || []).length).toBe(2)
  })

  it('coderPrompt / reviewerPrompt 模板字符串闭合完整', () => {
    // 每个 coderPrompt 必须以反引号收尾，否则整个文件语法崩
    expect((groupChat.match(/const coderPrompt = `/g) || []).length).toBe(
      (groupChat.match(/搪塞过去`/g) || []).length,
    )
  })
})
