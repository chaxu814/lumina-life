// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/answerIntegrity.test.ts
//
// 守「用户会不会看到尴尬 / 错误 / 被截断却不知道的答案」这个维度的四个修复：
//
//   1. 压缩的 LLM 分支必须和规则分支一样，保留用户约束 + 防编造声明
//      （否则对话一长，用户中途说的"不要用 emoji / 用表格"突然失效且无人察觉）
//   2. 记忆召回按 confidence 排序 + 有纠正入口
//      （否则模型上周编的结论永远压过用户今天亲口说的）
//   3. 子 agent 结果被截断时必须显式标注；0 成功 / 空结果必须报失败
//      （否则主 agent 会把残缺报告当完整结论转述给用户）
//   4. 流式超时返回半截答案时要标 truncated，且不能丢掉已累积的 toolCalls
//   5. 裸思维链不得直接当成最终答案显示给用户
//
// 注：agentCompactor 的导入链会拉起 electron（app.getPath / 工具注册表），
// 所以这里的跨文件断言一律走源码级读取，只有纯函数的抽取器直接 import。
// ============================================================

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { extractUserConstraints, SUMMARY_DISCLAIMER } from '../electron/agentCompactor'

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')
const compactorSrc = src('electron/agentCompactor.ts')
const providerSrc = src('electron/core/llmProvider.ts')
const runnerSrc = src('electron/agentRunner.ts')
const memoryStoreSrc = src('electron/memory/memoryStore.ts')
const memoryV2Src = src('electron/tools/impl/memory_v2.ts')
const teamCollabSrc = src('electron/tools/impl/teamCollab.ts')
const workerSrc = src('electron/team/dynamicWorker.ts')

describe('① 两条压缩路径都必须保留约束与免责声明', () => {
  it('LLM 压缩分支走的是共用组装函数（约束+声明都在里面）', () => {
    // 关键回归：LLM 分支曾经直接拼裸 llmSummary，绕过约束抽取与免责声明，
    // 结果是「对话一长就丢约束」，且模型毫无察觉。
    expect(compactorSrc).toContain('export function buildLLMCompressedSummary')
    expect(compactorSrc).toContain('buildLLMCompressedSummary(llmSummary, midMsgs)')
    // 共用函数内部确实做了这两件事
    const fn = compactorSrc.slice(
      compactorSrc.indexOf('export function buildLLMCompressedSummary'),
      compactorSrc.indexOf('export function buildLLMCompressedSummary') + 2500,
    )
    expect(fn).toContain('extractUserConstraints')
    expect(fn).toContain('SUMMARY_DISCLAIMER')
  })

  it('规则分支同样保留（防止修 LLM 分支时把规则分支弄丢）', () => {
    expect(compactorSrc).toContain('extractUserConstraints')
    expect(compactorSrc).toContain('SUMMARY_DISCLAIMER')
  })

  it('免责声明排在【摘要结束】之前（增量更新靠它剥离尾部）', () => {
    // 每一处 push 声明的位置都必须在 push「【摘要结束】」之前
    const declIdx = compactorSrc.indexOf('parts.push(`\\n${SUMMARY_DISCLAIMER}`)')
    expect(declIdx).toBeGreaterThan(-1)
    const firstEnd = compactorSrc.indexOf("parts.push('\\n【摘要结束】')")
    expect(firstEnd).toBeGreaterThan(-1)
    expect(declIdx).toBeLessThan(firstEnd)
  })

  it('抽取器确实能识别中途给出的硬约束', () => {
    const c = extractUserConstraints(['不要用 emoji', '输出用表格', '文件是 K:\\2\\a.ts'])
    const text = JSON.stringify(c)
    expect(text).toContain('emoji')
    expect(text).toContain('表格')
  })

  it('免责声明内容包含"不确定就问用户"', () => {
    expect(SUMMARY_DISCLAIMER).toContain('确认')
    expect(SUMMARY_DISCLAIMER).toContain('假设')
  })
})

describe('② 记忆召回质量', () => {
  it('recall 按 confidence 优先排序', () => {
    // ORDER BY id DESC 会让最新的低置信度结论压过用户亲口确认的
    expect(memoryStoreSrc).toMatch(/ORDER BY\s+confidence\s+DESC,\s*id\s+DESC/i)
  })

  it('memory_save 提供纠正入口', () => {
    expect(memoryV2Src).toContain('correct_id')
  })
})

describe('③ 子 agent 结果不得静默截断', () => {
  it('截断标记常量与标注函数都在', () => {
    expect(teamCollabSrc).toContain('WORKER_TRUNCATION_MARK')
    expect(teamCollabSrc).toContain('export function truncateWorkerResult')
  })

  it('截断后带明确标记与完整字数', () => {
    expect(teamCollabSrc).toMatch(/\$\{WORKER_TRUNCATION_MARK\}[^\n]*\$\{text\.length\}/)
  })

  it('旧的"无标记硬切"写法已经不在', () => {
    expect(teamCollabSrc).not.toMatch(/\.slice\(0, 1500\)/)
  })

  it('汇总会区分"成功"与"有有效内容"', () => {
    // 曾经无条件 return ok(...)，0 成功也报成功 → 模型把空信封当"查到了"
    expect(teamCollabSrc).toContain('const usable =')
    expect(teamCollabSrc).toContain('worker 未产出任何文本')
    // 截断函数在汇总里真的被用上了
    expect(teamCollabSrc).toMatch(/truncateWorkerResult\(/)
  })

  it('worker 空产出在源头就转成失败', () => {
    expect(workerSrc).toMatch(/if \(!String\(result \|\| ''\)\.trim\(\)\)/)
    expect(workerSrc).toContain('worker 未产出任何文本')
  })
})

describe('④ 流式超时：半截答案必须标记，且不丢工具调用', () => {
  it('返回 truncated 标记', () => {
    expect(providerSrc).toContain('truncated')
  })

  it('旧的"只回 text+usage、丢掉 toolCalls"写法已不在', () => {
    expect(providerSrc).not.toMatch(/return \{ text: partialText, usage: streamUsage \}/)
  })
})

describe('⑤ 裸思维链不得当成最终答案', () => {
  it('reasoning 兜底不是裸顶替', () => {
    expect(providerSrc).not.toMatch(/^\s*streamText = this\.reasoningAccum\s*$/m)
    expect(providerSrc).toMatch(/truncated|未返回正式回答|推理过程/)
  })

  it('agentRunner 侧只在无工具调用时才用 reasoning 兜底', () => {
    expect(runnerSrc).toMatch(/else if \(!msg\.tool_calls\?\.length && typeof msg\.reasoning_content/)
  })

  it('content 判空不能用真值判断（空串会掉进 reasoning）', () => {
    expect(runnerSrc).toContain(
      "const hasContent = typeof msg.content === 'string' && msg.content.length > 0",
    )
  })
})
