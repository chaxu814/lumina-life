// ============================================================
// taskProfiler.test.ts — 任务类型识别 · 术有专攻
//
// 回归背景（用户实测）：问纯组合概率题，Lumina 却去 web_search 搜题目原文。
// 本测试锁住：纯推理题必须被判成 reasoning，且高置信时 suppressSearch=true。
// ============================================================

import { describe, it, expect } from 'vitest'
import { profileTask, renderCapabilityMatching, SEARCH_TOOLS, CAPABILITY_MATCHING_GUIDE } from '../electron/orchestration/taskProfiler'

describe('profileTask — 纯推理（本次修复的核心）', () => {
  it('用户实测的原始题目 → reasoning + 高置信 + 抑制联网', () => {
    const p = profileTask('集合 C={1,2,3,...,13} 子集 N 个元素 不含五个连续整数 概率')
    expect(p.kind).toBe('reasoning')
    expect(p.confidence).toBe('high')
    expect(p.suppressSearch).toBe(true)
    expect(p.directive).toContain('不要调用 web_search')
  })

  it('证明题 → reasoning', () => {
    const p = profileTask('证明根号2是无理数')
    expect(p.kind).toBe('reasoning')
    expect(p.suppressSearch).toBe(true)
  })

  it('数列求和 → reasoning', () => {
    const p = profileTask('求 1+2+3+...+100 的和，用推导过程')
    expect(p.kind).toBe('reasoning')
    expect(p.suppressSearch).toBe(true)
  })

  it('排列组合 → reasoning', () => {
    const p = profileTask('从 10 个人里选 3 个人有多少种组合？')
    expect(p.kind).toBe('reasoning')
    expect(p.suppressSearch).toBe(true)
  })

  it('纯数学表达式（无推理词）也识别为 reasoning', () => {
    const p = profileTask('解方程 x^2 - 5x + 6 = 0')
    expect(p.kind).toBe('reasoning')
    expect(p.suppressSearch).toBe(true)
  })

  it('用户显式要求搜索 → 仍判 reasoning 但不抑制联网（尊重用户）', () => {
    const p = profileTask('帮我搜一下这个概率公式的推导过程')
    expect(p.kind).toBe('reasoning')
    expect(p.suppressSearch).toBe(false)
  })

  it('低置信推理（长数学表达式）同样抑制联网 —— 推理题的答案只能靠推导', () => {
    const longMath = '已知 ' + 'a1=1, a2=2, '.repeat(30) + ' 请给出结论'
    const p = profileTask(longMath)
    expect(p.kind).toBe('reasoning')
    expect(p.confidence).toBe('low')
    expect(p.suppressSearch).toBe(true)
  })
})

describe('profileTask — 实时信息（必须联网）', () => {
  it('天气 → realtime', () => {
    const p = profileTask('今天北京天气怎么样')
    expect(p.kind).toBe('realtime')
    expect(p.suppressSearch).toBe(false)
    expect(p.directive).toContain('web_search')
  })

  it('最新消息 → realtime', () => {
    expect(profileTask('最新的 AI 新闻有哪些').kind).toBe('realtime')
  })

  it('股价 → realtime', () => {
    expect(profileTask('茅台今天股价多少').kind).toBe('realtime')
  })

  it('实时信息优先于推理：含数字也不误判为纯推理', () => {
    const p = profileTask('今天上证指数收盘是多少')
    expect(p.kind).toBe('realtime')
    expect(p.suppressSearch).toBe(false)
  })
})

describe('profileTask — 其他类型', () => {
  it('闲聊 → chat（不注入指引）', () => {
    const p = profileTask('你好呀')
    expect(p.kind).toBe('chat')
    expect(p.directive).toBe('')
    expect(p.suppressSearch).toBe(false)
  })

  it('知识解释 → knowledge', () => {
    const p = profileTask('什么是量子纠缠')
    expect(p.kind).toBe('knowledge')
    expect(p.suppressSearch).toBe(false)
  })

  it('写作 → writing', () => {
    expect(profileTask('帮我写一篇关于环保的文章').kind).toBe('writing')
  })

  it('编程 → coding', () => {
    expect(profileTask('写个爬虫抓取新闻').kind).toBe('coding')
  })

  it('审查 → review', () => {
    expect(profileTask('帮我审查一下这段代码的风险').kind).toBe('review')
  })

  it('文件 → file', () => {
    expect(profileTask('这个文件夹里有什么').kind).toBe('file')
  })

  it('空输入 → unknown', () => {
    const p = profileTask('')
    expect(p.kind).toBe('unknown')
    expect(p.suppressSearch).toBe(false)
  })
})

describe('renderCapabilityMatching', () => {
  it('总则包含关键规则：纯推理不联网 + 实时必须联网', () => {
    expect(CAPABILITY_MATCHING_GUIDE).toContain('不要联网搜索')
    expect(CAPABILITY_MATCHING_GUIDE).toContain('必须 web_search')
  })

  it('有针对性 directive 时追加"本轮判定"', () => {
    const out = renderCapabilityMatching(profileTask('计算这个组合概率'))
    expect(out).toContain('本轮判定')
  })

  it('无 directive 时只输出总则', () => {
    const out = renderCapabilityMatching(profileTask(''))
    expect(out).toBe(CAPABILITY_MATCHING_GUIDE)
  })
})

describe('SEARCH_TOOLS 常量', () => {
  it('包含三个联网工具', () => {
    expect([...SEARCH_TOOLS]).toEqual(['web_search', 'web_fetch', 'browser'])
  })
})
