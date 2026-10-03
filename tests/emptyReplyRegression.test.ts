// ============================================================
// tests/emptyReplyRegression.test.ts — 「暂时无法生成有效回复」故障回归
//
// 【对应真实故障】
// 用户反馈：偶尔问答时 Lumina 回复
//   「抱歉，我暂时无法生成有效回复。请试试说"继续"…」
// 而下一句又恢复正常。
//
// 【根因（两个独立缺陷叠加）】
//   ① agentRunner 流式路径：模型输出了本仓库解析器认不出的 XML 工具格式
//      → 解析返回 null
//      → tools.length===0 分支把 XML 剥掉，`cleanText || streamText` 又把
//        整段 XML 当回复返回
//      → cleanToolNoiseText 再删一遍 → 空串
//   ② cleanToolNoiseText 对「纯工具标记」直接 return ''
//   ③ reactEngine.cleanXmlToolCalls 同理返回空串
//   → 连续 3 次空回复 → 恢复流程 → 也失败 → 兜底文案
//
// 【本测试钉住的不变量（比「不出现某个字符串」重要得多）】
//   **非空输入永远不产生空输出。**
// 只要守住这条，兜底文案就永远不会出现——它只是最后一道防线。
// 写死字符串的测试会在下一次改文案时失效，写不变量的不会。
// ============================================================

import { describe, it, expect } from 'vitest'
import { cleanToolNoiseText } from '../electron/agent/toolNoise'
import { parseXmlToolCalls, hasToolCallIntent } from '../electron/llm/xmlToolCall'
// 注意：本文件不 import agentRunner —— 那会拉进 Electron 的 app.getPath，
// 在纯 Node 测试环境下直接报 "Cannot read properties of undefined"。
// agentRunner 的 parseXmlToolCalls 已改为委托给 llm/xmlToolCall，
// 这里的委托关系由下面的 featureFlags 源码断言验证，
// 避免为了测一个纯函数而启动整个 Electron 运行时。

// 各种模型可能吐出的工具标记变体
const XML_SAMPLES = [
  '<tool_call><function=web_search><parameter=query>Qwen3</parameter></function></tool_call>',
  '<tool_call><tool_name>web_search</tool_name><tool_args>{"query":"Qwen3"}</tool_args></tool_call>',
  '<tool_call><web_search>\nquery="Qwen3"\n</web_search></tool_call>',
  '<tool_call><tool_calls>[{"name":"web_search","arguments":{"query":"x"}}]</tool_calls></tool_call>',
  '<tool_call><invoke name="web_search">{"query":"x"}</invoke></tool_call>',
  '<web_search(query="Qwen3", engine="bing")>',
  '<function_calls>[{"name":"web_search","arguments":{"query":"x"}}]</function_calls>',
  '```tool_code\n<tool_call><web_search>query="x"</web_search></tool_call>\n```',
]

describe('regression · 核心不变量：非空输入不产生空输出', () => {
  it('cleanToolNoiseText 对任何纯工具标记都返回非空说明', () => {
    for (const s of XML_SAMPLES) {
      const out = cleanToolNoiseText(s)
      expect(out.trim().length, `输入 ${s.slice(0, 40)}… 被清成了空串`).toBeGreaterThan(0)
    }
  })

  it('cleanToolNoiseText 保留正常回复不变', () => {
    const normal = 'Qwen3 是一个开源大模型，支持 128K 上下文。'
    expect(cleanToolNoiseText(normal)).toBe(normal)
  })

  it('cleanToolNoiseText 仍会剥掉工具噪音但保留正文', () => {
    const mixed = '正在搜索中\nQwen3 的参数量是 70B。'
    const out = cleanToolNoiseText(mixed)
    expect(out).toContain('70B')
    expect(out).not.toContain('正在搜索中')
  })

  it('真正空输入仍返回空串（不得凭空造内容）', () => {
    expect(cleanToolNoiseText('')).toBe('')
    expect(cleanToolNoiseText('   ')).toBe('')
  })
})

describe('regression · XML 解析器：认得全，且失败不吞内容', () => {
  it('7 种格式全部能解析出工具调用', () => {
    for (const s of XML_SAMPLES) {
      const r = parseXmlToolCalls(s)
      expect(r.calls.length, `未能解析: ${s.slice(0, 50)}`).toBeGreaterThan(0)
      expect(typeof r.calls[0].function.name).toBe('string')
      expect(r.calls[0].function.name.length).toBeGreaterThan(0)
    }
  })

  it('解析成功时正文被正确剥掉', () => {
    const r = parseXmlToolCalls('我来查一下。\n<tool_call><function=web_search><parameter=query>test</parameter></function></tool_call>')
    expect(r.calls.length).toBe(1)
    expect(r.text).not.toContain('tool_call')
  })

  it('🔑 解析失败时原文一字不改（绝不静默变空）', () => {
    const weird = '<tool_call><完全未知的格式 xyz="1"></tool_call>'
    const r = parseXmlToolCalls(weird)
    expect(r.calls.length).toBe(0)
    // 关键：text 必须还是原文
    expect(r.text).toBe(weird)
    expect(r.text.trim().length).toBeGreaterThan(0)
  })

  it('解析失败时给出诊断信息（便于排障）', () => {
    const r = parseXmlToolCalls('<tool_call><unknown_tool_xyz>{"a":1}</unknown_tool_xyz></tool_call>')
    expect(r.calls.length).toBe(0)
    expect(r.hadToolCallIntent).toBe(true)
    expect(r.diagnostic.length).toBeGreaterThan(0)
  })

  it('白名单生效：未注册的工具名不被误认（防止 <b> 之类标签）', () => {
    const known = new Set(['web_search', 'file_read'])
    // <b> 是 HTML 粗体，不是工具
    const r = parseXmlToolCalls('<tool_call><b>x</b></tool_call>', known)
    expect(r.calls.length).toBe(0)
    // 合法工具则认得
    const r2 = parseXmlToolCalls('<tool_call><function=web_search><parameter=query>x</parameter></function></tool_call>', known)
    expect(r2.calls.length).toBe(1)
  })

  it('无白名单时保持宽容（本地模型自造工具名也能试）', () => {
    const r = parseXmlToolCalls('<tool_call><function=my_custom_tool><parameter=a>1</parameter></function></tool_call>')
    expect(r.calls.length).toBe(1)
  })

  it('普通 Markdown 不会被误判为调用意图', () => {
    expect(hasToolCallIntent('这是**粗体**和 <b>标签</b>')).toBe(false)
    const r = parseXmlToolCalls('这是**粗体**和 <b>标签</b>')
    expect(r.calls.length).toBe(0)
    expect(r.hadToolCallIntent).toBe(false)
  })

  it('search_depth 伪参数被剔除（历史行为保持）', () => {
    const r = parseXmlToolCalls('<tool_call><web_search>\nquery="x"\nsearch_depth=high\n</web_search></tool_call>')
    expect(r.calls[0].function.arguments).not.toContain('search_depth')
  })

  it('多个工具调用能全部解析', () => {
    const r = parseXmlToolCalls(
      '<tool_call><tool_calls>[{"name":"web_search","arguments":{"q":"a"}},{"name":"file_read","arguments":{"p":"b"}}]</tool_calls></tool_call>',
    )
    expect(r.calls.length).toBe(2)
  })
})

describe('regression · agentRunner 已委托给单一事实源', () => {
  it('源码层面确认委托关系（避免重复实现再次分叉）', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const src = fs.readFileSync(
      path.join(process.cwd(), 'electron', 'agentRunner.ts'),
      'utf-8',
    )
    // 必须 import 共享解析器
    expect(src).toMatch(/import\s*\{[^}]*parseXmlToolCalls[^}]*\}\s*from\s*'\.\/llm\/xmlToolCall'/)
    // 本地函数必须委托，不得再自己写正则实现
    expect(src).toMatch(/export function parseXmlToolCalls[\s\S]{0,400}parseXmlToolCallsShared\(/)
    // 旧的 tools.length===0 分支不得再出现「删干净后回退原文」的写法
    // （只检查代码行，不扫注释——修复说明里会引用旧写法）
    const codeOnly = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(codeOnly).not.toMatch(/cleanText\s*\|\|\s*streamText/)
    // 新的分支必须提供非空兜底
    expect(codeOnly).toMatch(/toolsAvailable|leftover|没有可用的工具/)
  })
})

describe('regression · 端到端不变量（模拟真实故障链路）', () => {
  /** 忠实复刻 agentRunner 流式路径的两个分支 */
  function simulateStreamBranch(raw: string, toolsAvailable: number): { text: string; toolCalls: number } {
    const r = parseXmlToolCalls(raw)
    if (r.calls.length > 0) {
      if (toolsAvailable === 0) {
        // agentRunner 现在的行为：保留正文 + 诚实的工具不可用说明
        const leftover = r.text.trim()
        return {
          text: leftover
            ? `${leftover}\n\n（本轮没有可用的工具...）`
            : '（我本来想调用一个工具，但这轮没有可用的工具...）',
          toolCalls: 0,
        }
      }
      return { text: r.text || '', toolCalls: r.calls.length }
    }
    // 解析不出 → 原文返回
    return { text: raw, toolCalls: 0 }
  }

  it('分支 A：tools=0 时，模型输出 XML 仍产生非空文本', () => {
    for (const s of XML_SAMPLES) {
      const r = simulateStreamBranch(s, 0)
      const final = cleanToolNoiseText(r.text)
      expect(final.trim().length, `tools=0 时 ${s.slice(0, 40)}… 产生了空回复`).toBeGreaterThan(0)
    }
  })

  it('分支 B：tools>0 时产出可执行的工具调用', () => {
    for (const s of XML_SAMPLES) {
      const r = simulateStreamBranch(s, 5)
      expect(r.toolCalls, `tools>0 时 ${s.slice(0, 40)}… 没解析出调用`).toBeGreaterThan(0)
    }
  })

  it('分支 A + 清理器串联后仍非空（完整链路）', () => {
    for (const s of XML_SAMPLES) {
      const r = simulateStreamBranch(s, 0)
      const final = cleanToolNoiseText(r.text)
      expect(final.trim().length, `完整链路 ${s.slice(0, 40)}… 产生了空回复`).toBeGreaterThan(0)
    }
  })

  it('未知格式 → 原文保留 → 清理后仍有内容', () => {
    const weird = '<tool_call><某种没见过的格式>abc</某种没见过的格式></tool_call>'
    const parsed = parseXmlToolCalls(weird)
    expect(parsed.text).toBe(weird)          // 原文保留
    const final = cleanToolNoiseText(parsed.text)
    expect(final.trim().length).toBeGreaterThan(0)
  })

  it('任意非空模型输出，经完整清理后都非空', () => {
    const corpus = [
      ...XML_SAMPLES,
      '正常回答。',
      '',
      '   ',
      '正在搜索中',
      '<tool_call></tool_call>',
      '<tool_call>   </tool_call>',
    ]
    for (const s of corpus) {
      const out = cleanToolNoiseText(s)
      if (s.trim().length === 0) {
        expect(out).toBe('')   // 空输入 → 空输出（正确）
      } else {
        expect(out.trim().length, `输入「${s.slice(0, 30)}」变成了空串`).toBeGreaterThan(0)
      }
    }
  })
})
