// ============================================================
// tests/companionGuard.test.ts — 铁则一的代码兜底
//
// 背景：AGENTS.md 第一条承诺「用户永远不知道 Yak 和热茶的存在」，
// 但此前这条只写在 system prompt 里，代码层零强制。
// 而 tools/impl/team.ts 又把「### Yak（程序员）输出」亲手写进回灌模型的工具结果 ——
// 模型在自己上下文里反复读到名字，再被要求「绝不暴露」，等于赌它听话。
//
// 这个测试同时锁死两件互相拉扯的事：
//   ① 成员名必须被遮蔽（铁则一）
//   ② 普通中文里的「热茶」绝不能被误伤（否则产品变成灾难）
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  applyCompanionGuard,
  guardEvent,
  StreamingCompanionFilter,
  wouldRedact,
  ROLE_LABELS,
} from '../electron/agent/companionGuard'
import type { AgentEvent } from '../electron/tools/types'

const companion = { tier: 'companion' as const }

/** 造一对过滤器（每条用例都要新的，避免状态互相污染） */
function filters(opts = companion) {
  return {
    text: new StreamingCompanionFilter(opts),
    think: new StreamingCompanionFilter(opts),
  }
}

describe('applyCompanionGuard — 必须遮蔽的泄漏', () => {

  it('拉丁成员名 Yak 被替换为角色称谓', () => {
    const r = applyCompanionGuard('Yak 说这个方案可行。', companion)
    expect(r.text).not.toContain('Yak')
    expect(r.text).toContain(ROLE_LABELS.yak)
    expect(r.redacted).toBe(true)
  })

  it('小写 yak 同样遮蔽', () => {
    expect(applyCompanionGuard('yak 写完了', companion).text).not.toContain('yak')
  })

  it('Recha 被替换', () => {
    const r = applyCompanionGuard('Recha 审完了', companion)
    expect(r.text).not.toContain('Recha')
    expect(r.text).toContain(ROLE_LABELS.recha)
  })

  it('delegate_chain 的原始标题会被整体洗掉', () => {
    const raw = '## 流水线结果（第1轮通过）\n\n### Yak（程序员）输出\n代码...\n\n### 热茶 审查\n没问题\n'
    const r = applyCompanionGuard(raw, companion)
    expect(r.text).not.toContain('Yak')
    expect(r.text).not.toContain('热茶')
  })

  it('多个名字同时出现全部遮蔽', () => {
    const r = applyCompanionGuard('Yak 写完，Recha 审过', companion)
    expect(r.text).not.toMatch(/Yak|Recha/)
    expect(r.leaked.sort()).toEqual([ROLE_LABELS.yak, ROLE_LABELS.recha].sort())
  })

  it('无 agent 语境的中文「热茶」也应遮蔽（名字本身即身份）', () => {
    // 「热茶」作为成员名出现时，同句通常会有语境词；
    // 这里单独测它在有语境时的行为
    const r = applyCompanionGuard('热茶 审查说代码没问题', companion)
    expect(r.text).not.toContain('热茶')
  })

})

describe('applyCompanionGuard — 绝不能误伤', () => {

  it('「喝杯热茶」原样保留（最典型的误伤场景）', () => {
    const r = applyCompanionGuard('要不要喝杯热茶？', companion)
    expect(r.text).toContain('热茶')
    expect(r.redacted).toBe(false)
  })

  it('普通句子完全不动', () => {
    const s = '好的，我帮你把这个文件整理一下。'
    expect(applyCompanionGuard(s, companion).text).toBe(s)
  })

  it('英文单词里包含 yak 不被误伤（词边界）', () => {
    // 'yakky' 不是成员名
    const r = applyCompanionGuard('yakky noodles', companion)
    expect(r.redacted).toBe(false)
  })

  it('无成员的普通技术回答零改写', () => {
    const s = '这个函数在第 40 行有竞态条件，建议加锁。'
    expect(applyCompanionGuard(s, companion).text).toBe(s)
  })

})

describe('applyCompanionGuard — 档位与群聊豁免', () => {

  it('collab 档放行（专业用户要能查协作细节）', () => {
    const s = 'Yak 写完，Recha 审过'
    expect(applyCompanionGuard(s, { tier: 'collab' }).text).toBe(s)
  })

  it('audit 档放行', () => {
    const s = 'Yak 写完'
    expect(applyCompanionGuard(s, { tier: 'audit' }).text).toBe(s)
  })

  it('群聊会话放行（产品本身就以多 Agent 同屏为卖点）', () => {
    const s = 'Yak 说他搞定了'
    expect(applyCompanionGuard(s, { tier: 'companion', isGroupChat: true }).text).toBe(s)
  })

  it('非法档位按最严格处理（fail-closed）', () => {
    const s = 'Yak 写完'
    expect(applyCompanionGuard(s, { tier: 'godmode' as never }).text).not.toContain('Yak')
  })

})

describe('applyCompanionGuard — 健壮性', () => {

  it('空串 / 非字符串不抛异常', () => {
    expect(applyCompanionGuard('', companion).text).toBe('')
    expect(applyCompanionGuard(undefined as unknown as string).text).toBe('')
    expect(applyCompanionGuard(null as unknown as string).text).toBe('')
  })

  it('重复调用无状态污染（正则 lastIndex 回归）', () => {
    const s = 'Yak 和 Recha 都在'
    const a = applyCompanionGuard(s, companion)
    const b = applyCompanionGuard(s, companion)
    expect(a.text).toBe(b.text)
    for (let i = 0; i < 5; i++) { applyCompanionGuard(s, companion) }
    expect(applyCompanionGuard(s, companion).text).toBe(a.text)
  })

  it('wouldRedact 与实际结果一致', () => {
    expect(wouldRedact('Yak 写的', companion)).toBe(true)
    expect(wouldRedact('今天天气不错', companion)).toBe(false)
  })

})

describe('StreamingCompanionFilter — 流式切词不能漏', () => {

  it('名字被切在两个 chunk 之间时仍被遮蔽', () => {
    const f = new StreamingCompanionFilter(companion)
    // 模拟模型逐 token 吐字：名字正好横跨边界
    const parts = ['我看一下…然后让 Yak', ' 那边处理。']
    let out = ''
    for (const p of parts) { out += f.push(p) }
    out += f.flush()
    expect(out).not.toContain('Yak')
    expect(out).toContain(ROLE_LABELS.yak)
  })

  it('Recha 被切成三个 chunk 也不漏', () => {
    const f = new StreamingCompanionFilter(companion)
    let out = ''
    for (const p of ['结果交给你了，Re', 'cha 说', '可以。']) { out += f.push(p) }
    out += f.flush()
    expect(out).not.toContain('Recha')
  })

  it('整体输出与一次性处理结果一致', () => {
    const full = '好的，我先看看。Yak 说要改一下第 40 行，我让他改完再给你。'
    const once = applyCompanionGuard(full, companion).text
    const f = new StreamingCompanionFilter(companion)
    let streamed = ''
    // 逐字符喂，最苛刻的切法
    for (const ch of full) { streamed += f.push(ch) }
    streamed += f.flush()
    expect(streamed).toBe(once)
  })

  it('短文本不被无谓地压住（无名字前缀时立即放行）', () => {
    // 早期实现是「固定压住末尾 8 字符」，会把 '好的' 整段扣住直到 flush。
    // 现在的实现只压「仍可能是名字头」的后缀，普通文本零延迟 ——
    // 这是刻意优化：延迟不该施加在 99% 无关的字符上。
    const f = new StreamingCompanionFilter(companion)
    expect(f.push('好的')).toBe('好的')
    expect(f.pending).toBe(0)
  })

  it('名字前缀会被压住而不是放行', () => {
    const f = new StreamingCompanionFilter(companion)
    // 'Re' 是 Recha 的真前缀 → 「结果交给你了，」可以放行，但 'Re' 必须压住
    expect(f.push('结果交给你了，Re')).toBe('结果交给你了，')
    expect(f.pending).toBe(2) // 恰好是压住的那个 'Re'
  })

  it('flush 不会丢字（压住的尾巴必须交出来）', () => {
    const f = new StreamingCompanionFilter(companion)
    // 结尾落在名字前缀上 → 有内容被压住，必须由 flush 交出
    const emitted = f.push('我看完了整段代码，准备交给 Re')
    expect(f.pending).toBeGreaterThan(0)
    const out = emitted + f.flush()
    // 「Re」不是完整名字（还没写完），此时不应被替换，但也不能丢
    expect(out).toBe('我看完了整段代码，准备交给 Re')
    expect(f.pending).toBe(0)
  })

  it('push 多次 + flush 的总输出与一次性处理完全一致', () => {
    const full = '我看完了整段代码，准备交给 Recha 定夺，他说可以合并。'
    const once = applyCompanionGuard(full, companion).text
    const f = new StreamingCompanionFilter(companion)
    let out = ''
    const parts = ['我看完了整段', '代码，准备交给 R', 'echa 定夺，', '他说可以合并。']
    for (const p of parts) { out += f.push(p) }
    out += f.flush()
    expect(out).toBe(once)
  })

  it('非陪伴档位下流式不做任何延迟（原样透出）', () => {
    const f = new StreamingCompanionFilter({ tier: 'collab' })
    const out = f.push('Yak 说可以') + f.flush()
    expect(out).toContain('Yak')
  })

  it('flush 后可继续使用而不串味', () => {
    const f = new StreamingCompanionFilter(companion)
    f.push('第一段内容', )
    f.flush()
    let second = ''
    second += f.push('Yak 接手了')
    second += f.flush()
    expect(second).not.toContain('Yak')
  })

})

// ═══════════════════════════════════════════════════════════
// guardEvent — 事件级出口过滤
// 这一组是铁则一真正被钉死的地方：
// 每种「会携带文本送到用户面前」的事件类型，都必须过护栏。
// ═══════════════════════════════════════════════════════════

describe('guardEvent — 各类事件出口', () => {

  it('text 事件：成员名被遮蔽', () => {
    const f = filters()
    const ev: AgentEvent = { type: 'text', content: 'Yak 说他搞定了' }
    const r = guardEvent(ev, f.text, f.think, companion)
    expect((r.event as { content: string }).content).not.toContain('Yak')
    expect(r.redactedLeak).toContain(ROLE_LABELS.yak)
  })

  it('text 事件：无泄漏时原样透传，且 redactedLeak 为空', () => {
    const f = filters()
    const ev: AgentEvent = { type: 'text', content: '好的，我改好了' }
    const r = guardEvent(ev, f.text, f.think, companion)
    expect(r.event).toBe(ev)
    expect(r.redactedLeak).toEqual([])
  })

  it('text_stream 事件：走流式过滤器', () => {
    const f = filters()
    const ev: AgentEvent = { type: 'text_stream', content: '我准备让 Yak 接手这件事，你稍等' }
    const r = guardEvent(ev, f.text, f.think, companion)
    expect((r.event as { content: string }).content).not.toContain('Yak')
  })

  it('thinking 事件：思考面板同样不能漏名字', () => {
    const f = filters()
    const ev: AgentEvent = { type: 'thinking', text: '让 Yak 去写代码比较合适' }
    const r = guardEvent(ev, f.text, f.think, companion)
    expect((r.event as { text: string }).text).not.toContain('Yak')
  })

  it('error 事件：错误文案里的名字也要遮蔽', () => {
    const f = filters()
    const ev: AgentEvent = { type: 'error', error: 'Yak 调用失败：超时' }
    const r = guardEvent(ev, f.text, f.think, companion)
    expect((r.event as { error: string }).error).not.toContain('Yak')
  })

  it('memory_summary 事件：摘要里的名字也要遮蔽', () => {
    const f = filters()
    const ev: AgentEvent = { type: 'memory_summary', summary: '今天 Yak 帮我修好了那个 bug' }
    const r = guardEvent(ev, f.text, f.think, companion)
    expect((r.event as { summary: string }).summary).not.toContain('Yak')
  })

  it('tool_start 事件：工具参数里的任务描述含名字', () => {
    const f = filters()
    const ev: AgentEvent = { type: 'tool_start', tool: 'delegate_to', args: { to: 'yak', task: '让 Yak 修这个 bug' } }
    const r = guardEvent(ev, f.text, f.think, companion)
    const args = (r.event as { args: Record<string, unknown> }).args
    expect(String(args.task)).not.toContain('Yak')
    // 标识符类参数必须原样保留 —— 改掉它等于破坏路由数据结构
    expect(args.to).toBe('yak')
  })

  it('tool_start：白名单外的键一律不动（防误伤标识符）', () => {
    const f = filters()
    const ev: AgentEvent = {
      type: 'tool_start',
      tool: 'delegate_to',
      args: { to: 'recha', from: 'yak', agentId: 'yak', mode: 'yak-debug', filePath: 'K:/src/yak.ts' },
    }
    const r = guardEvent(ev, f.text, f.think, companion)
    expect(r.event).toBe(ev)
  })

  it('tool_end 事件：委托结果里的成员名必须遮蔽（最关键的一处）', () => {
    const f = filters()
    const ev: AgentEvent = {
      type: 'tool_end',
      tool: 'delegate_chain',
      result: { ok: true, content: '## 流水线结果\n\n### Yak（程序员）输出\nconst a = 1\n\n### 热茶 审查\n没问题' },
    } as unknown as AgentEvent
    const r = guardEvent(ev, f.text, f.think, companion)
    const result = (r.event as { result: { content: string } }).result
    expect(result.content).not.toContain('Yak')
    expect(result.content).not.toContain('热茶')
    // 工具名本身不动（那是 UI 语义，不是身份泄漏）
    expect((r.event as { tool: string }).tool).toBe('delegate_chain')
  })

  it('非陪伴档位：事件原样透传', () => {
    const opts = { tier: 'collab' as const }
    const f = filters(opts)
    const ev: AgentEvent = { type: 'text', content: 'Yak 说他搞定了' }
    const r = guardEvent(ev, f.text, f.think, opts)
    expect(r.event).toBe(ev)
  })

  it('群聊：事件原样透传', () => {
    const opts = { tier: 'companion' as const, isGroupChat: true }
    const f = filters(opts)
    const ev: AgentEvent = { type: 'text', content: 'Yak 说他搞定了' }
    const r = guardEvent(ev, f.text, f.think, opts)
    expect(r.event).toBe(ev)
  })

  it('与事件无关的类型（done / token_update）不被动过', () => {
    const f = filters()
    const ev: AgentEvent = { type: 'done', totalTokens: 123 }
    const r = guardEvent(ev, f.text, f.think, companion)
    expect(r.event).toBe(ev)
  })

  it('approval:pending 不被遮蔽（安全相关事件任何档位都必须透出）', () => {
    const f = filters()
    const ev: AgentEvent = {
      type: 'approval:pending',
      toolName: 'shell_exec',
      requestId: 'r1',
      args: { cmd: 'ls' },
      summary: '需要你确认',
    }
    const r = guardEvent(ev, f.text, f.think, companion)
    expect(r.event).toBe(ev)
  })

})
