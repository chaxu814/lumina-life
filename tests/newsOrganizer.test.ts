// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// tests/newsOrganizer.test.ts
// 覆盖「改造 3」：新闻分级 + agent 整理的解析与降级路径
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { splitInterests, matchesKeywords, classifyNewsPriority, classifyBatch, DEFAULT_PRIORITY_OPTIONS } from '../electron/news/newsPriority'
import {
  extractJsonArray, applyOrganizerOutput, buildOrganizerPrompt,
  organizeNewsWithAgent, DEFAULT_ORGANIZER_OPTIONS,
} from '../electron/tools/impl/newsOrganizer'
import type { FilteredItem } from '../electron/tools/impl/newsFilter'
import type { NewsItem } from '../electron/tools/impl/newsCollector'

function mkItem(over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'n1', title: '标题', url: 'http://x', source: '源', category: 'tech',
    pubDate: '', summary: '摘要', content: '', hotScore: 50, fingerprint: 'f',
    ...over,
  }
}

function mkFiltered(over: Partial<FilteredItem> = {}, itemOver: Partial<NewsItem> = {}): FilteredItem {
  return {
    item: mkItem(itemOver),
    relevanceScore: 50,
    reason: 'r',
    oneLiner: '一句话',
    digest: '摘要正文',
    tags: ['tech'],
    ...over,
  }
}

// ═══ 分级 ═══

describe('splitInterests', () => {
  it('按中英文标点切词并去重', () => {
    expect(splitInterests('AI大模型、AI编程工具，AI大模型')).toEqual(['AI大模型', 'AI编程工具'])
  })
  it('丢掉单字符噪声', () => {
    expect(splitInterests('AI、x、芯片')).toEqual(['AI', '芯片'])
  })
  it('空值安全', () => {
    expect(splitInterests('')).toEqual([])
    expect(splitInterests(null)).toEqual([])
  })
})

describe('matchesKeywords', () => {
  it('英文大小写不敏感', () => {
    expect(matchesKeywords('OpenAI releases GPT', ['openai'])).toEqual(['openai'])
  })
  it('无命中返回空数组', () => {
    expect(matchesKeywords('无关内容', ['openai'])).toEqual([])
  })
  it('空关键词列表 → 空数组（不把所有内容都判为命中）', () => {
    expect(matchesKeywords('任意内容', [])).toEqual([])
  })
})

describe('classifyNewsPriority — 高优先级判定', () => {
  it('相关性超阈值 → high', () => {
    const v = classifyNewsPriority(mkFiltered({ relevanceScore: 92 }), 'AI')
    expect(v.priority).toBe('high')
    expect(v.reasons.join()).toContain('相关性')
  })

  it('命中订阅话题 → high', () => {
    const v = classifyNewsPriority(
      mkFiltered({ relevanceScore: 10 }, { title: 'OpenAI 发布全新大模型' }),
      '大模型、openai',
    )
    expect(v.priority).toBe('high')
    expect(v.reasons.join()).toContain('订阅话题')
  })

  it('重大分类 + 高热度 → high', () => {
    const v = classifyNewsPriority(
      mkFiltered({ relevanceScore: 10 }, { category: 'finance', hotScore: 95 }),
      '完全无关的兴趣',
    )
    expect(v.priority).toBe('high')
  })

  it('普通内容 → normal（不弹系统通知）', () => {
    const v = classifyNewsPriority(
      mkFiltered({ relevanceScore: 30 }, { category: 'tech', hotScore: 40, title: '随便一条' }),
      '完全无关的兴趣',
    )
    expect(v.priority).toBe('normal')
    expect(v.reasons).toHaveLength(0)
  })

  it('热度高但非重大分类 → 仍是 normal（热榜≠用户关心）', () => {
    const v = classifyNewsPriority(
      mkFiltered({ relevanceScore: 10 }, { category: 'tech', hotScore: 100 }),
      '不相关',
    )
    expect(v.priority).toBe('normal')
  })

  it('阈值可配置', () => {
    const item = mkFiltered({ relevanceScore: 70 }, { category: 'tech', hotScore: 10 })
    expect(classifyNewsPriority(item, '无关', { scoreThreshold: 60 }).priority).toBe('high')
    expect(classifyNewsPriority(item, '无关', { scoreThreshold: 80 }).priority).toBe('normal')
  })

  it('默认阈值是 85', () => {
    expect(DEFAULT_PRIORITY_OPTIONS.scoreThreshold).toBe(85)
  })
})

describe('classifyBatch', () => {
  it('正确分桶且 id 索引可查', () => {
    const items = [
      mkFiltered({ relevanceScore: 95 }, { id: 'a' }),
      mkFiltered({ relevanceScore: 10 }, { id: 'b', title: '无关' }),
    ]
    const r = classifyBatch(items, '不相关')
    expect(r.high.map(h => h.item.item.id)).toEqual(['a'])
    expect(r.normal.map(h => h.item.item.id)).toEqual(['b'])
    expect(r.verdicts.get('a')?.priority).toBe('high')
  })

  it('空数组安全', () => {
    const r = classifyBatch([], 'x')
    expect(r.high).toEqual([])
    expect(r.normal).toEqual([])
  })
})

// ═══ 解析 ═══

describe('extractJsonArray — 容忍 agent 的各种脏输出', () => {
  it('纯数组', () => {
    expect(extractJsonArray('[{"id":"a"}]')).toEqual([{ id: 'a' }])
  })

  it('带 ```json 围栏', () => {
    expect(extractJsonArray('```json\n[{"id":"a"}]\n```')).toEqual([{ id: 'a' }])
  })

  it('带 ``` 无语言标记', () => {
    expect(extractJsonArray('```\n[{"id":"a"}]\n```')).toEqual([{ id: 'a' }])
  })

  it('前后有解释文字', () => {
    expect(extractJsonArray('好的，结果如下：\n[{"id":"a"}]\n希望有帮助')).toEqual([{ id: 'a' }])
  })

  it('尾随逗号', () => {
    expect(extractJsonArray('[{"id":"a"},]')).toEqual([{ id: 'a' }])
  })

  it('完全不是数组 → null', () => {
    expect(extractJsonArray('我无法完成这个任务')).toBeNull()
    expect(extractJsonArray('')).toBeNull()
    expect(extractJsonArray('{"id":"a"}')).toBeNull()
  })
})

describe('applyOrganizerOutput — 应用 agent 结果', () => {
  const base = [mkFiltered({}, { id: 'a' }), mkFiltered({}, { id: 'b' })]

  it('按 agent 顺序重排并覆盖文案', () => {
    const out = applyOrganizerOutput(base, JSON.stringify([
      { id: 'b', tags: ['资本'], summary: '新的摘要', opinion: '我的判断', keep: true },
      { id: 'a', tags: ['AI'], summary: 'A 的摘要', keep: true },
    ]))!
    expect(out.items.map(i => i.item.id)).toEqual(['b', 'a'])
    expect(out.items[0].digest).toBe('新的摘要')
    expect(out.items[0].reason).toBe('我的判断')
    expect(out.items[0].tags).toEqual(['资本'])
  })

  it('keep=false 默认只降权不删除（误删新闻比多留噪音更糟）', () => {
    const out = applyOrganizerOutput(base, JSON.stringify([
      { id: 'a', summary: 's', keep: true },
      { id: 'b', summary: 's', keep: false },
    ]))!
    expect(out.items.map(i => i.item.id)).toEqual(['a', 'b'])
  })

  it('applyDrops=true 时剔除 keep=false', () => {
    const out = applyOrganizerOutput(base, JSON.stringify([
      { id: 'a', summary: 's', keep: true },
      { id: 'b', summary: 's', keep: false },
    ]), { applyDrops: true })!
    expect(out.items.map(i => i.item.id)).toEqual(['a'])
    expect(out.keptCount).toBe(1)
  })

  it('applyDrops=true 但全部 keep=false → 不允许清空列表', () => {
    const out = applyOrganizerOutput(base, JSON.stringify([
      { id: 'a', keep: false }, { id: 'b', keep: false },
    ]), { applyDrops: true })!
    expect(out.items.length).toBeGreaterThan(0)
  })

  it('缺 keep 字段默认保留（防止 agent 漏字段误删）', () => {
    const out = applyOrganizerOutput(base, JSON.stringify([
      { id: 'a', summary: 's' }, { id: 'b', summary: 's' },
    ]), { applyDrops: true })!
    expect(out.items).toHaveLength(2)
  })

  it('agent 只提到部分条目 → 未提到的补回，不丢新闻', () => {
    const out = applyOrganizerOutput(base, JSON.stringify([{ id: 'a', summary: 's', keep: true }]))!
    expect(out.items.map(i => i.item.id).sort()).toEqual(['a', 'b'])
  })

  it('agent 返回不存在的 id → 视为无法应用', () => {
    expect(applyOrganizerOutput(base, JSON.stringify([{ id: 'zzz', keep: true }]))).toBeNull()
  })

  it('输出不可解析 → null', () => {
    expect(applyOrganizerOutput(base, '完全不是 JSON')).toBeNull()
  })

  it('tags 为空时保留原 tags', () => {
    const out = applyOrganizerOutput(base, JSON.stringify([{ id: 'a', tags: [], summary: 's', keep: true }]))!
    expect(out.items[0].tags).toEqual(['tech'])
  })
})

describe('buildOrganizerPrompt', () => {
  it('包含每条新闻的 id 与标题', () => {
    const { userContent, systemPrompt } = buildOrganizerPrompt([mkFiltered({}, { id: 'x1', title: '重大新闻' })], 'AI')
    expect(userContent).toContain('x1')
    expect(userContent).toContain('重大新闻')
    expect(userContent).toContain('AI')
    expect(systemPrompt).toContain('JSON')
  })

  it('长文本被裁剪（控制 token 成本）', () => {
    const long = 'a'.repeat(5000)
    const { userContent } = buildOrganizerPrompt([mkFiltered({}, { summary: long })], '')
    expect(userContent.length).toBeLessThan(1500)
  })
})

// ═══ 主流程与降级 ═══

const mockDelegate = vi.fn()
const mockIsConfigured = vi.fn()

vi.mock('../electron/delegationManager', () => ({
  getDelegationManager: () => ({
    isConfigured: mockIsConfigured,
    delegate: mockDelegate,
  }),
}))

describe('organizeNewsWithAgent — 降级路径（核心验收项）', () => {
  beforeEach(() => {
    mockDelegate.mockReset()
    mockIsConfigured.mockReset()
  })
  afterEach(() => vi.clearAllMocks())

  const items = [mkFiltered({}, { id: 'a' }), mkFiltered({}, { id: 'b' })]

  it('开关关闭 → 零 LLM 调用，原样返回', async () => {
    const r = await organizeNewsWithAgent(items, {}, false)
    expect(r.organized).toBe(false)
    expect(r.degraded).toBe(true)
    expect(r.items).toBe(items) // 同一个引用 = 完全没有加工
    expect(mockDelegate).not.toHaveBeenCalled()
  })

  it('默认配置里 agentOrganize 关闭（省电模式默认）', () => {
    expect(DEFAULT_ORGANIZER_OPTIONS.agentId).toBe('recha')
  })

  it('目标 agent 未配置 → 降级，不发起委托', async () => {
    mockIsConfigured.mockReturnValue(false)
    const r = await organizeNewsWithAgent(items, { agentId: 'recha' }, true)
    expect(r.degraded).toBe(true)
    expect(r.reason).toContain('未配置')
    expect(r.items).toBe(items)
    expect(mockDelegate).not.toHaveBeenCalled()
  })

  it('委托返回 success=false → 降级', async () => {
    mockIsConfigured.mockReturnValue(true)
    mockDelegate.mockResolvedValue({ success: false, error: '模型超时' })
    const r = await organizeNewsWithAgent(items, {}, true)
    expect(r.degraded).toBe(true)
    expect(r.reason).toContain('模型超时')
    expect(r.items).toBe(items)
  })

  it('委托抛异常 → 降级（不向调用方抛出）', async () => {
    mockIsConfigured.mockReturnValue(true)
    mockDelegate.mockRejectedValue(new Error('网络炸了'))
    const r = await organizeNewsWithAgent(items, {}, true)
    expect(r.degraded).toBe(true)
    expect(r.items).toBe(items)
  })

  it('agent 输出无法解析 → 降级回原始列表', async () => {
    mockIsConfigured.mockReturnValue(true)
    mockDelegate.mockResolvedValue({ success: true, content: '我今天不太想干活' })
    const r = await organizeNewsWithAgent(items, {}, true)
    expect(r.degraded).toBe(true)
    expect(r.reason).toContain('无法解析')
    expect(r.items).toBe(items)
  })

  it('空列表 → 直接降级，不浪费 LLM 调用', async () => {
    const r = await organizeNewsWithAgent([], {}, true)
    expect(r.degraded).toBe(true)
    expect(mockDelegate).not.toHaveBeenCalled()
  })

  it('成功整理 → 按 agent 顺序返回', async () => {
    mockIsConfigured.mockReturnValue(true)
    mockDelegate.mockResolvedValue({
      success: true,
      content: JSON.stringify([
        { id: 'b', tags: ['资本'], summary: 'B 摘要', keep: true },
        { id: 'a', tags: ['AI'], summary: 'A 摘要', keep: true },
      ]),
    })
    const r = await organizeNewsWithAgent(items, {}, true)
    expect(r.organized).toBe(true)
    expect(r.degraded).toBe(false)
    expect(r.items.map(i => i.item.id)).toEqual(['b', 'a'])
  })

  it('agent 剔除低价值条目（applyDrops 生效）', async () => {
    mockIsConfigured.mockReturnValue(true)
    mockDelegate.mockResolvedValue({
      success: true,
      content: JSON.stringify([
        { id: 'a', summary: 'A', keep: true },
        { id: 'b', summary: 'B', keep: false },
      ]),
    })
    const r = await organizeNewsWithAgent(items, {}, true)
    expect(r.items.map(i => i.item.id)).toEqual(['a'])
  })

  it('超过 maxItems 的尾部原样保留（只整理前 N 条，不丢新闻）', async () => {
    const many = ['a', 'b', 'c', 'd'].map(id => mkFiltered({}, { id }))
    mockIsConfigured.mockReturnValue(true)
    mockDelegate.mockResolvedValue({
      success: true,
      content: JSON.stringify([{ id: 'a', summary: 'A', keep: true }, { id: 'b', summary: 'B', keep: true }]),
    })
    const r = await organizeNewsWithAgent(many, { maxItems: 2 }, true)
    expect(r.items.map(i => i.item.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('走的是既有 delegation 机制（from 恒为 lumina）', async () => {
    mockIsConfigured.mockReturnValue(true)
    mockDelegate.mockResolvedValue({ success: true, content: '[]' })
    await organizeNewsWithAgent(items, { agentId: 'recha' }, true)
    expect(mockDelegate).toHaveBeenCalledWith('lumina', expect.objectContaining({
      to: 'recha',
      taskType: 'logic_check',
    }))
  })
})
