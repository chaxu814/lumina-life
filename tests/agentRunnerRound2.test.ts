// ============================================================
// tests/agentRunnerRound2.test.ts
//
// 守第二轮 agent 质量改造。每条都对应一个"用户能看到错答案"的失败模式：
//
//   1. 流式工具参数：早前 JSON.parse 在参数流中途成功就判定"完整"，
//      后续补齐的字段被去重丢弃，工具以**残缺参数**执行完
//   2. reasoning_content 优先级：非流式分支曾经 reasoning 优先
//      → 用户直接看到思维链；降级分支只读 content
//      → R1/QwQ 这类模型返回空 → 触发空回复恢复
//   3. 参数解析失败用 {} 继续跑工具 → securityGuard 基于真实参数做的
//      危险判定等于被整个跳过
//   4. 团队角色统一：热茶=程序员、Yak=分析/审查（同名反向职责已修）
//   5. 所有"没执行"路径统一走 notExecutedNote
// ============================================================

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8')

const runner = read('electron/agentRunner.ts')
const provider = read('electron/core/llmProvider.ts')
const personas = read('electron/agentTeamPersonas.ts')
const souls = read('src/data/agentSouls.ts')
const yakSoul = read('electron/agents/yak/SOUL.md')
const yakAgents = read('electron/agents/yak/AGENTS.md')
const rechaSoul = read('electron/agents/recha/SOUL.md')
const rechaAgents = read('electron/agents/recha/AGENTS.md')
const luminaAgents = read('electron/agents/lumina/AGENTS.md')

describe('① 流式工具参数必须用完整参数', () => {
  it('不再有"中途判定完整"的快照列表', () => {
    // 允许注释里提到这个名字（说明为什么删掉），但代码里不能再有
    const code = runner.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    expect(code).not.toContain('completedToolCalls')
    expect(code).not.toContain('READONLY_EARLY_TOOLS')
  })

  it('不再用半截参数提前执行只读工具', () => {
    expect(runner).not.toMatch(/executeToolWithRetry\(acc\.name!, JSON\.parse\(acc\.args\)\)/)
  })

  it('最终工具列表只从 toolCallAccum 构建一次', () => {
    expect(runner).toContain('const tcs: LLMToolCall[] = []')
    expect(runner).not.toContain('const completedIds = new Set(')
  })

  it('流结束时参数仍不合法 → 如实计数上报，不拿半截参数跑', () => {
    expect(runner).toContain('let malformedToolArgs = 0')
    expect(runner).toContain('malformedToolArgs++')
    expect(runner).toContain('参数不是合法 JSON')
  })

  it('参数累积期间只做 UI 提示，不推入工具列表', () => {
    expect(runner).toContain('const announcedToolIds = new Set<string>()')
    expect(runner).toContain("this.emit({ type: 'incremental_tool', toolCall: completeCall })")
  })
})

describe('② reasoning_content 优先级：content 优先', () => {
  it('llmProvider 非流式分支改成 content 优先', () => {
    expect(provider).toContain(
      "text: (choice.message?.content || choice.message?.reasoning_content || '').trimStart()",
    )
    expect(provider).not.toContain(
      "text: (choice.message?.reasoning_content || choice.message?.content || '').trimStart()",
    )
  })

  it('agentRunner 降级分支同样 content 优先、reasoning 兜底', () => {
    expect(runner).toMatch(
      /const hasContent = typeof msg\.content === 'string' && msg\.content\.length > 0\s*\r?\n\s*if \(hasContent\) \{streamText = msg\.content\}/,
    )
  })
})

describe('③ 参数解析失败不得跳过安全检查', () => {
  it('解析失败直接阻断并如实告知，不再 catch {} 拿 {} 跑', () => {
    expect(runner).toContain('let argsParseFailed = false')
    expect(runner).toContain('if (argsParseFailed) {')
    expect(runner).toContain('参数不是合法 JSON，无法解析，未执行')
    // 老的静默兜底不能回来
    expect(runner).not.toMatch(/try \{ args = JSON\.parse\(fn\.arguments\) \} catch \{\}/)
  })

  it('参数非法时不执行工具，且发出 tool_start/tool_end 事件对', () => {
    expect(runner).toMatch(/argsParseFailed\)[\s\S]{0,600}this\.emit\(\{ type: 'tool_start'/)
    expect(runner).toMatch(/argsParseFailed\)[\s\S]{0,900}this\.emit\(\{\s*type: 'tool_end'/)
  })

  it('参数非法时**保留原始坏参数**，绝不洗成 {}（否则下游保护形同虚设）', () => {
    // 回归：曾经把 args 洗成 '{}'，下游 JSON.parse 必然成功 → 工具带着空参数
    // 真的执行了，参数级安全检查被整个跳过。
    const start = runner.indexOf('let malformedToolArgs = 0')
    const seg = runner.slice(start, start + 900)
    expect(seg).not.toMatch(/args\s*=\s*'\{\}'/)
    expect(seg).toContain('malformedToolArgs++')
    expect(seg).toContain('将阻断执行')
  })
})

describe('②b 思维链不得被当成正式回答', () => {
  it('只认非空字符串的 content，空串/null 不触发 reasoning 兜底', () => {
    expect(runner).toContain(
      "const hasContent = typeof msg.content === 'string' && msg.content.length > 0",
    )
  })

  it('有工具调用时绝不用 reasoning 顶替（那会让用户看到裸思维链）', () => {
    expect(runner).toMatch(/else if \(!msg\.tool_calls\?\.length && typeof msg\.reasoning_content/)
  })
})

describe('②c 强制收敛不得每轮重复触发', () => {
  it('用独立 converged 标记，而不是把计数钉回 30', () => {
    expect(runner).toContain('let converged = false')
    expect(runner).toContain('if (!converged && totalToolCallsThisRun > 30) {')
    // 旧的"钉回 30"写法会因下一轮 += 变成 33 而再次触发
    expect(runner).not.toContain('totalToolCallsThisRun = 30')
  })
})

describe('②d 主路径的 API 协议合法性', () => {
  it('合并相邻 assistant 时保留 tool_calls（否则 tool 消息变孤儿 → 400）', () => {
    expect(runner).toContain('last.tool_calls = [...(last.tool_calls || []), ...m.tool_calls]')
  })

  it('合并后统一走协议清洗', () => {
    expect(runner).toMatch(/const cleaned = sanitizeHistoryForApi\(mergedMessages\)/)
  })

  it('systemPrompt 里的 SOUL 加载路径确实命中项目根的 SOUL_*.md', () => {
    // 回归：上一轮误以为 SOUL_YAK.md / SOUL_RECHA.md 不存在，只改了兜底文案，
    // 而真正被加载的是项目根目录下这两个文件 —— 角色统一等于没做。
    const sp = read('electron/prompts/systemPrompt.ts')
    expect(sp).toContain("loadMdFile(root, 'SOUL_YAK.md')")
    expect(sp).toContain("loadMdFile(root, 'SOUL_RECHA.md')")
  })
})

describe('④ 团队角色统一：热茶=程序员，Yak=分析/审查', () => {
  it('后台团队：Yak 不再自称代码工程师', () => {
    expect(personas).toContain('TEAM_YAK')
    expect(personas).toContain('数据分析师兼审查员')
    // 旧的 Yak=工程师描述不能残留
    expect(personas).not.toContain('专业的代码工程师。只写代码、调试 bug')
  })

  it('后台团队：热茶是代码工程师', () => {
    expect(personas).toContain('TEAM_RECHA')
    expect(personas).toMatch(/TEAM_RECHA[\s\S]{0,400}代码工程师/)
  })

  it('Lumina 的委派路由已对调：写代码→热茶，审查→Yak', () => {
    expect(personas).toContain('写代码 / 调试 bug / 重构 → 委托给**热茶**')
    expect(personas).toContain('审查代码 / 挑错 / 从反面论证 / 风险评估 → 委托给**Yak**')
    // 旧的反向路由不能残留
    expect(personas).not.toContain('写代码/调试 bug → 委托给 Yak')
  })

  it('身份文件与后台团队一致', () => {
    expect(yakSoul).toContain('数据分析师兼审查员')
    expect(yakSoul).toContain('**不写代码**')
    expect(yakAgents).toContain('数据分析师兼审查员')
    expect(yakAgents).toContain('绝对不能写代码')

    expect(rechaSoul).toContain('专业**代码工程师**')
    expect(rechaSoul).toContain('不做审查')
    expect(rechaAgents).toContain('专业代码工程师')
    expect(rechaAgents).toContain('绝对不能做审查')
  })

  it('与群聊人设（agentSouls）方向一致，没有反向', () => {
    expect(souls).toContain('天才程序员')          // 热茶在群聊里是程序员
    expect(souls).toContain('数据分析师')          // Yak 在群聊里是分析师
    // 后台团队必须跟群聊一致，不能再出现 Yak=工程师 / 热茶=审查员
    expect(personas).not.toMatch(/TEAM_RECHA[\s\S]{0,200}严格的审查员/)
  })

  it('Lumina 身份文件里的委托规则也已对调', () => {
    expect(luminaAgents).toContain('写代码 / 调试 bug / 重构 → 委托给**热茶**')
    expect(luminaAgents).toContain('→ 委托给**Yak**')
    expect(luminaAgents).not.toContain('委托给 Yak\n2. 需要自我否定')
  })
})

describe('⑤ 所有"没执行"路径统一措辞', () => {
  it('notExecutedNote 存在且写明"未执行成功 + 禁止据此作答"', () => {
    expect(runner).toContain('export function notExecutedNote')
    expect(runner).toContain('未执行成功')
    expect(runner).toContain('禁止把这段内容当作事实依据继续推理')
  })

  it('旧的三种裸文本失败提示都不在了', () => {
    expect(runner).not.toContain('已被安全门临时封禁（至第 ${unblockRound} 轮），请改用其他工具或直接回复。`')
    expect(runner).not.toContain('content: `⛔ 安全审查阻止: ${guardResult.summary}`')
    expect(runner).not.toContain('content: `🔐 ${tc.function.name} 需要审批: ${guardResult.summary}`')
  })

  it('并行情形的三条失败路径都改用 notExecutedNote', () => {
    expect(runner).toContain('notExecutedNote(`工具 "${tc.function.name}" 已被安全门临时封禁')
    expect(runner).toContain('notExecutedNote(`安全审查阻止了 ${tc.function.name}')
    expect(runner).toContain('notExecutedNote(`${tc.function.name} 需要审批但未获批准')
  })
})

describe('⑥ 群聊不再缺反幻觉底线', () => {
  it('Lumina 身份文件的人格段里不再混着事实纪律', () => {
    // 人格段里只允许剩下纯人格条目 + 迁移说明；事实纪律本身必须已搬走
    const style = luminaAgents.slice(
      luminaAgents.indexOf('## ✨ 你的风格'),
      luminaAgents.indexOf('## 📌 回复原则'),
    )
    const rules = style
      .split('\n')
      .filter(l => /^\s*-\s/.test(l) || /^\s*\d+\.\s/.test(l))
      .join('\n')
    expect(rules).not.toContain('不编造')
    expect(rules).not.toContain('团队委托结果必须完整呈现给用户')
    expect(rules).not.toContain('标注来源')
  })

  it('事实纪律由代码注入，永不随人格段被剥离', () => {
    const promptSrc = read('electron/prompts/systemPrompt.ts')
    expect(promptSrc).toContain('FACT_DISCIPLINE_LINES')
    expect(promptSrc).toContain('事实纪律')
  })
})
