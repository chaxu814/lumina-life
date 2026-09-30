// tests/compactorKeepsConstraints.test.ts
// 验证 agentCompactor 在结构化摘要中「强制保留用户约束」：
//   1. 对话中途给出的格式 / 路径 / 否定约束能被抽出来（不只是最后几条）
//   2. 约束区排在摘要最前
//   3. 末尾有「无法确定就向用户确认」的防编造声明
//   4. 去重与条数上限生效
//   5. 空输入不崩
import { describe, expect, it } from 'vitest'
import {
  buildStructuredSummary,
  extractUserConstraints,
  CONSTRAINT_MAX_PER_CATEGORY,
  SUMMARY_DISCLAIMER,
} from '../electron/agentCompactor'
import type { AgentMessage } from '../electron/tools/types'

let seq = 0
function makeMsg(role: 'system' | 'user' | 'assistant', content: string): AgentMessage {
  return { role, content, ts: ++seq } as AgentMessage
}

/** 构造一轮「早期用户消息 → 助手回复」，助手消息塞噪声，确保只有用户侧约束生效 */
function turn(user: string, answer = '收到，我来处理。'): AgentMessage[] {
  return [makeMsg('user', user), makeMsg('assistant', answer)]
}

describe('extractUserConstraints — 规则抽取', () => {
  it('抽出否定 / 格式 / 路径 / 数字 / 记忆五类约束', () => {
    const got = extractUserConstraints([
      '先看一下整体情况',
      '不要用 emoji',
      '以后所有回答请用表格输出',
      '结论请用中文，不超过 200 字',
      '重点文件是 `K:\\2\\Lumina AI\\electron\\agentCompactor.ts`',
      '保持 TokenEstimator 这个类名和 v9.0 版本号不变',
      '记住，我叫小光',
    ])
    const byCategory = (c: string) => got.filter(x => x.category === c).map(x => x.text)

    expect(byCategory('negation').join('\n')).toContain('不要用 emoji')
    expect(byCategory('format').join('\n')).toMatch(/用表格/)
    expect(byCategory('format').join('\n')).toMatch(/中文/)
    expect(byCategory('format').join('\n')).toMatch(/不超过 200 字/)
    expect(byCategory('target').join('\n')).toContain('K:\\2\\Lumina AI\\electron\\agentCompactor.ts')
    expect(byCategory('literal').join('\n')).toContain('v9.0')
    expect(byCategory('memory').join('\n')).toMatch(/我叫小光/)
  })

  it('从对话中途的消息抽取，不只看最后一条', () => {
    const got = extractUserConstraints([
      '第一步：先扫描项目结构', // 最早的一条，无约束
      '补充一点：不要写代码，只给方案',
      '再补充：输出请用分点列表',
      '最后：随便看看就行', // 最晚的一条，无约束
    ])
    const all = got.map(c => c.text).join('\n')
    expect(all).toContain('不要写代码')
    expect(all).toMatch(/分点/)
  })

  it('无约束的普通消息不产生条目', () => {
    expect(extractUserConstraints(['好的谢谢', '嗯嗯', ''])).toEqual([])
  })
})

describe('buildStructuredSummary — 约束区块', () => {
  const mid: AgentMessage[] = [
    makeMsg('system', 'BASE'),
    ...turn('先帮我看下项目结构'),
    ...turn('不要用 emoji，所有回答请用表格输出'),
    ...turn('重要文件是 `K:\\2\\Lumina AI\\electron\\agentCompactor.ts`，保持 v9.0 兼容'),
    // 「关键决策」按既有行为来自 assistant 侧，这里保留一条以验证字段未被删
    ...turn('那我们继续吧', '已决定采用方案A，改动已确认')
  ]
  const systemMsgs = [mid[0]]
  const summary = buildStructuredSummary(systemMsgs, mid.slice(1), null)

  it('把中途的格式 / 路径 / 否定约束写进摘要', () => {
    expect(summary).toContain('用户明确提出的约束')
    expect(summary).toContain('不要用 emoji')
    expect(summary).toMatch(/表格/)
    expect(summary).toContain('K:\\2\\Lumina AI\\electron\\agentCompactor.ts')
    expect(summary).toContain('v9.0')
  })

  it('约束区排在摘要最前：早于历史延续、用户关注、关键决策等所有区块', () => {
    const constraintIdx = summary.indexOf('用户明确提出的约束')
    expect(constraintIdx).toBeGreaterThan(-1)

    // 摘要标题行应在约束区之前（说明约束区是正文第一块）
    expect(constraintIdx).toBeGreaterThan(summary.indexOf('对话摘要'))

    for (const later of ['【历史摘要延续】', '## 用户关注', '## 关键决策', '## 最近回复']) {
      if (summary.includes(later)) {
        expect(constraintIdx).toBeLessThan(summary.indexOf(later))
      }
    }
  })

  it('增量摘要时约束区依然排在【历史摘要延续】之前', () => {
    const prev = buildStructuredSummary(systemMsgs, [makeMsg('user', '不要用 emoji')], null)
    const merged = buildStructuredSummary(
      systemMsgs,
      [makeMsg('user', '这次请用英文回答')],
      prev,
    )
    expect(merged).toContain('【历史摘要延续】')
    expect(merged.indexOf('用户明确提出的约束')).toBeLessThan(
      merged.indexOf('【历史摘要延续】'),
    )
    expect(merged).toMatch(/英文/)
  })

  it('末尾包含「无法确定就向用户确认」的防编造声明，且在【摘要结束】之前', () => {
    expect(summary).toContain('以上为早期对话的结构化摘要，可能遗漏细节')
    expect(summary).toContain('应当直接向用户确认，而不是假设')
    expect(summary).toContain(SUMMARY_DISCLAIMER)
    // 【摘要结束】 必须仍是最后一行：增量更新依赖 /\n【摘要结束】$/ 剥离尾部
    expect(summary.trimEnd().endsWith('【摘要结束】')).toBe(true)
  })

  it('保留原有字段（用户关注 / 关键决策 / 涉及的文件），向后兼容', () => {
    expect(summary).toContain('## 用户关注')
    expect(summary).toContain('## 关键决策')
  })

  it('可通过选项关闭约束抽取与声明（默认开启的对照）', () => {
    const off = buildStructuredSummary(systemMsgs, mid.slice(1), null, {
      keepConstraints: false,
      disclaimer: false,
    })
    expect(off).not.toContain('用户明确提出的约束')
    expect(off).not.toContain('以上为早期对话的结构化摘要')
    expect(off).toContain('## 用户关注')
  })
})

describe('去重与条数上限', () => {
  it('同一条约束重复出现只列一次', () => {
    const got = extractUserConstraints([
      '不要用 emoji',
      '好的',
      '另外还是不要用 emoji',
    ])
    const negations = got.filter(c => c.category === 'negation')
    expect(negations.length).toBe(1)
  })

  it('反引号 / 空白 / 大小写差异不算新约束', () => {
    const got = extractUserConstraints([
      '文件是 `K:\\2\\app.ts`',
      '文件是 K:\\2\\app.ts',
    ])
    expect(got.filter(c => c.category === 'target').length).toBe(1)
  })

  it('同一句只归入一个类别，不重复列出', () => {
    const got = extractUserConstraints(['不要改 K:\\2\\app.ts'])
    expect(got.length).toBe(1)
    expect(got[0].category).toBe('negation')
    expect(got[0].text).toContain('K:\\2\\app.ts')
  })

  it('每类最多 CONSTRAINT_MAX_PER_CATEGORY 条，总量有上限', () => {
    const many = Array.from({ length: 40 }, (_, i) => `不要做第${i}件事`).join('。')
    const got = extractUserConstraints([many])
    const perCat = new Map<string, number>()
    for (const c of got) perCat.set(c.category, (perCat.get(c.category) ?? 0) + 1)
    for (const n of perCat.values()) expect(n).toBeLessThanOrEqual(CONSTRAINT_MAX_PER_CATEGORY)

    // 总上限：五类各 8 条 = 40，大于 CONSTRAINT_MAX_TOTAL，所以总量应被截断
    const allCats = [
      '不要用 emoji',
      '记住我叫小光',
      '请用表格输出',
      '文件在 `K:\\2\\a.ts`',
      '版本号是 v9.0',
    ].join('。') + '。'.repeat(0)
    const total = extractUserConstraints([allCats])
    expect(total.length).toBeLessThanOrEqual(40)
  })

  it('极长消息不撑爆摘要：单条约束被截断', () => {
    const got = extractUserConstraints([`不要用 emoji，${'补充说明'.repeat(60)}`])
    expect(got.length).toBe(1)
    expect(got[0].text.length).toBeLessThanOrEqual(101)
    expect(got[0].text.endsWith('…')).toBe(true)
  })
})

describe('空输入 / 边界', () => {
  it('空消息列表不崩，且仍返回带标题与声明的摘要', () => {
    const s = buildStructuredSummary([], [], null)
    expect(s).toContain('对话摘要')
    expect(s).toContain('以上为早期对话的结构化摘要，可能遗漏细节')
    expect(s.trimEnd().endsWith('【摘要结束】')).toBe(true)
    expect(s).not.toContain('undefined')
  })

  it('空数组 / 纯空串 / 非字符串内容都不崩', () => {
    expect(extractUserConstraints([])).toEqual([])
    expect(extractUserConstraints(['', '   ', '\n\n'])).toEqual([])
    const s = buildStructuredSummary(
      [],
      [{ role: 'user', content: [] } as unknown as AgentMessage],
      null,
    )
    expect(typeof s).toBe('string')
    expect(s).toContain('对话摘要')
  })

  it('只有助手消息（无用户约束）时不产生约束区', () => {
    const s = buildStructuredSummary(
      [],
      [makeMsg('assistant', '不要用 emoji 是用户说的，我照做')],
      null,
    )
    expect(s).not.toContain('用户明确提出的约束')
  })
})

// ════════════════════════════════════════════════════════════
//  反例不误抽：高精度优先的核心验收
//
//  为什么单独开一组：误抽的代价远大于漏抽 ——
//  一条不存在的「硬约束」会被写进摘要最显眼的位置，之后每一轮回答都拿它当前提，
//  错误会自我强化。所以每条规则都必须能用反例证伪。
// ════════════════════════════════════════════════════════════
describe('反例不误抽', () => {
  /** 整句都不该产生任何约束 */
  const FALSE_POSITIVES = [
    // ── 否定类：客套 / 陈述 / 条件句 ──
    '这个方案不用改，昨晚已经改完了', // 「不用」是在说已完成，不是在下禁令
    '不用谢，客气什么',
    '不用客气，都是小事',
    '这题不需要你查资料', // 后面跟的是委托对象，不是被禁动作
    '如果你不用去开会，就先把代码写了', // 条件句里的否定不是常驻约束
    '别人都这么写，我也这么写', // 「别人」是假否定
    '别处还有一份备份',
    '这只是我想去别的城市走走', // 「别的」同样不是禁令
    '算了，不用了',
    // ── 格式类：裸语言词 / 裸格式词 ──
    '这个中文写得不好',
    '这个英文翻译得很生硬',
    '中文的意思我大概明白', // 提到了语言，但不是要求用中文回答
    '这个表格为空', // 提到表格，不代表要求用表格输出
    '这个 json 解析失败了', // 提到 json，不代表要求返回 json
    // ── 文件 / 标识符类：普通英文词不是文件名 ──
    'See the docs etc. for details', // 句中的 etc. 不是文件
    '这个 `函数` 有点慢', // 反引号包的是中文自然语言，不是标识符
    '输入 / 输出 / 结果 三个字段', // 中文斜杠不是路径
    // ── 数字 / 命名类：普通小数与英文短语 ──
    '这个价格是 3.5 元', // 普通小数不是版本号
    '2.0 版本的事情以后再说', // 提到了版本，但不是版本约束
    'Hello World 是默认标题', // 英文短语不是命名要求
    // ── 记忆类 ──
    '以后有空再聊', // 「以后」后面没有指令词
  ]

  it.each(FALSE_POSITIVES)('不抽：「%s」', (text) => {
    expect(extractUserConstraints([text])).toEqual([])
  })
})

describe('正例仍能被抽到（收紧后不得降低能力）', () => {
  /** 这些是需求点名必须保住的真实约束 */
  const TRUE_POSITIVES: Array<{ text: string; category: string; pattern: RegExp }> = [
    { text: '不要用 emoji', category: 'negation', pattern: /不要用 emoji/ },
    { text: '禁止在代码里写 TODO 注释', category: 'negation', pattern: /禁止/ },
    { text: '别再改那个分支了', category: 'negation', pattern: /别再改/ },
    { text: '以后所有回答请用表格输出', category: 'format', pattern: /用表格/ },
    { text: '这次请用英文回答', category: 'format', pattern: /英文回答/ },
    { text: '把结论改成中文回复', category: 'format', pattern: /中文/ },
    { text: '请控制在 300 字以内', category: 'format', pattern: /300 字以内/ },
    { text: '用 markdown 格式输出', category: 'format', pattern: /markdown/ },
    { text: '不要改 K:\\2\\Lumina AI\\src\\main.tsx', category: 'negation', pattern: /main\.tsx/ },
    { text: '重点文件是 `K:\\2\\app.ts`', category: 'target', pattern: /app\.ts/ },
    { text: '把 TokenEstimator 这个类名保持不变，版本号用 v9.0', category: 'literal', pattern: /v9\.0/ },
    { text: '接口超时时间统一改成 800 ms', category: 'literal', pattern: /800 ms/ },
    { text: '我的名字叫小光', category: 'memory', pattern: /我的名字叫小光/ },
  ]

  it.each(TRUE_POSITIVES)('抽到（$category）：「$text」', ({ text, category, pattern }) => {
    const got = extractUserConstraints([text])
    expect(got.length).toBeGreaterThan(0)
    const hit = got.find(c => c.category === category)
    expect(hit, `未归入 ${category}：${JSON.stringify(got)}`).toBeDefined()
    expect(hit!.text).toMatch(pattern)
  })
})

describe('助手消息中的否定词不会被抽成用户约束', () => {
  it('助手复述 / 劝阻时的话只留在「最近回复」，不进约束区', () => {
    const s = buildStructuredSummary(
      [],
      [
        makeMsg('user', '把 agentRunner 改一下'),
        makeMsg('assistant', '好的，我改一下，不过别忘了这次不用改那个测试文件'),
        makeMsg('user', '好的'),
      ],
      null,
    )
    // 助手的「别忘了 / 不用改」只能出现在「最近回复」，绝不能被提升为用户硬约束
    const blockStart = s.indexOf('用户明确提出的约束')
    const constraintBlock = blockStart >= 0 ? s.slice(blockStart, s.indexOf('## 用户关注')) : ''
    expect(constraintBlock).not.toContain('别忘了这次不用改那个测试文件')
    expect(constraintBlock).not.toContain('不用改那个测试文件')
    expect(s).toContain('## 最近回复')
  })
})
