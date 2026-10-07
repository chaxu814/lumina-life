// ============================================================
// tests/newsNarrator.test.ts — 新闻叙述层（LLM 已接 / 未接 两条路）
//
// 【背景】
// 用户报「邮件里的新闻只发网站，不要总结」。修的时候最容易做错的是
// 「不管有没有 LLM 都套一层模板」——没接模型时假装能总结，比不总结更糟。
// 这个文件钉住两条路的分界：
//   · narrateDigest 拿不到可用输出 → 必须返回 null（而不是编一段）
//   · 拿不到 → assembleDigestBody 只能给「标题 + 网址」
// 另外钉住 parseNarrativeJson 的容错：LLM 一定会犯 markdown 包裹 / 前后废话。
// ============================================================

import { describe, it, expect } from 'vitest'
import { narrateDigest, parseNarrativeJson } from '../electron/tools/impl/newsNarrator'
import { assembleDigestBody } from '../electron/tools/impl/newsDigest'
import type { FilteredItem } from '../electron/tools/impl/newsFilter'
import type { NewsItem } from '../electron/tools/impl/newsCollector'

function newsItem(over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'n1',
    title: 'An AI couldn’t beat humans at StarCraft, so it decided to cheat',
    url: 'https://www.theverge.com/ai/1004543/openai-gpt-cheat-starcraft',
    source: 'The Verge',
    category: 'tech',
    pubDate: '2026-10-04T11:22:26-04:00',
    summary: 'StarSkirmish pits AI-made StarCraft-playing bots against one another.',
    content: 'StarSkirmish pits AI-made bots against one another.',
    hotScore: 70,
    fingerprint: 'fp1',
    ...over,
  }
}

function filtered(items: NewsItem[]): FilteredItem[] {
  return items.map(item => ({
    item,
    relevanceScore: 80,
    reason: 'ok',
    oneLiner: '一句话',
    tags: ['tech'],
  }))
}

const SAMPLE = filtered([newsItem(), newsItem({ id: 'n2', title: 'MacBook Air M5 is $200 off', url: 'https://www.theverge.com/gadgets/1000832/macbook-air-m5' })])

describe('parseNarrativeJson', () => {
  it('解析标准 JSON', () => {
    const r = parseNarrativeJson('{"lead":"今天都在打折","takeaway":"不值得买","items":[{"index":1,"comment":"AI 打不过人去作弊"}]}')
    expect(r).not.toBeNull()
    expect(r!.lead).toBe('今天都在打折')
    expect(r!.items).toHaveLength(1)
    expect(r!.items[0].index).toBe(1)
  })

  it('剥掉 markdown 代码块包裹', () => {
    const r = parseNarrativeJson('```json\n{"lead":"A","items":[{"index":1,"comment":"B"}]}\n```')
    expect(r!.lead).toBe('A')
    expect(r!.items[0].comment).toBe('B')
  })

  it('能从前后废话里抠出 JSON', () => {
    const r = parseNarrativeJson('好的，这是结果：\n{"lead":"A","items":[]}\n希望有帮助！')
    expect(r!.lead).toBe('A')
  })

  it('解析不了就返回 null（而不是空对象假装成功）', () => {
    expect(parseNarrativeJson('完全不是 JSON')).toBeNull()
    expect(parseNarrativeJson('')).toBeNull()
  })

  it('items 里的脏条目被丢弃，剩下合法的照常返回', () => {
    const r = parseNarrativeJson('{"lead":"A","items":[{"index":"x"},{"index":2},{"index":3,"comment":"   "},{"index":4,"comment":"好"}]}')
    expect(r!.items.map(i => i.index)).toEqual([4])
  })
})

describe('narrateDigest', () => {
  it('LLM 正常返回时给出 lead / takeaway / 逐条点评', async () => {
    const r = await narrateDigest(SAMPLE, async () => JSON.stringify({
      lead: '今天美国科技媒体在集中清库存。',
      takeaway: '打折是真的，需求不是。',
      items: [{ index: 0, comment: 'AI 打星际争霸打不过人类，于是学坏了。' }],
    }))
    expect(r).not.toBeNull()
    expect(r!.lead).toContain('清库存')
    expect(r!.items[0].index).toBe(0)
  })

  it('LLM 抛错 → 返回 null，让调用方退回极简', async () => {
    const r = await narrateDigest(SAMPLE, async () => { throw new Error('ECONNREFUSED') })
    expect(r).toBeNull()
  })

  it('LLM 返回垃圾 → 返回 null', async () => {
    const r = await narrateDigest(SAMPLE, async () => '<think>让我想想</think> 呃…')
    expect(r).toBeNull()
  })

  it('空列表直接返回 null，不去烧 token', async () => {
    let called = false
    const r = await narrateDigest([], async () => { called = true; return '{}' })
    expect(r).toBeNull()
    expect(called).toBe(false)
  })
})

describe('assembleDigestBody — 两种形态', () => {
  it('没接 LLM：只给标题和网址，不出现分类标题/星级/标签', () => {
    const body = assembleDigestBody(SAMPLE, { title: 'T' })
    expect(body).toContain('**1. An AI couldn’t beat humans at StarCraft, so it decided to cheat**')
    expect(body).toContain('https://www.theverge.com/ai/1004543/openai-gpt-cheat-starcraft')
    expect(body).not.toContain('⭐')          // 没有星级堆砌
    expect(body).not.toContain('🏷️')         // 没有标签堆砌
    expect(body).not.toContain('###')         // 没有分类小标题
    expect(body).not.toContain('今日导读')
  })

  it('没接 LLM 时给出「去接 LLM」的提示，而不是假装有摘要', () => {
    const body = assembleDigestBody(SAMPLE, { title: 'T' })
    expect(body).toContain('接入 LLM 后 Lumina 会为你写导读')
  })

  it('接了 LLM：有导读 + takeaway + 逐条点评 + 链接', () => {
    const body = assembleDigestBody(SAMPLE, {
      title: 'T',
      narrative: {
        lead: '今天美国科技媒体在集中清库存。',
        takeaway: '打折是真的，需求不是。',
        items: [{ index: 0, comment: 'AI 打不过人类就去作弊，挺有意思。' }],
      },
    })
    expect(body).toContain('## 📝 今日导读')
    expect(body).toContain('今天美国科技媒体在集中清库存。')
    expect(body).toContain('💡 **打折是真的，需求不是。**')
    expect(body).toContain('AI 打不过人类就去作弊，挺有意思。')
    expect(body).toContain('📎 https://www.theverge.com/ai/1004543/openai-gpt-cheat-starcraft')
    expect(body).toContain('前往设置 → 新闻订阅')
  })

  it('LLM 只写了一半（没有 takeaway）也不会崩', () => {
    const body = assembleDigestBody(SAMPLE, {
      title: 'T',
      narrative: { lead: '只有导读', takeaway: '', items: [] },
    })
    expect(body).toContain('只有导读')
  })

  it('LLM 返回的 index 越界不会污染邮件', () => {
    const body = assembleDigestBody(SAMPLE, {
      title: 'T',
      narrative: { lead: 'L', takeaway: 'K', items: [{ index: 99, comment: '这条不存在' }] },
    })
    expect(body).not.toContain('这条不存在')
  })

  it('空列表给出明确说明而不是空白邮件', () => {
    const body = assembleDigestBody([], { title: 'T' })
    expect(body).toContain('没有筛选出值得关注的新闻')
  })
})
