// ============================================================
// tests/dayreplay.test.ts — Day Replay（可回放的一天）
//
// 覆盖：
//   1. 本地时区跨天切割 / 非法日期
//   2. 各数据源聚合（注入假账本/假看板/假命令审计）
//   3. 时间线排序、stats 逐项正确
//   4. filesChanged best-effort 规则（git commit / git add -A 不编数据）
//   5. Markdown/Text 渲染：关键段落齐全、不泄露内部术语
//   6. 空数据日诚实输出
//   7. IPC 注册幂等（重复调用不重复注册）
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createDayReplayService,
  DayReplayError,
  extractGitFiles,
  type DayReplayAdapters,
  type LlmUsageRowLike,
} from '../electron/dayreplay/dayReplay'
import type { DailyReplay } from '../electron/dayreplay/types'
import { registerDayReplayIpc } from '../electron/dayreplay/ipc'
import type { IpcBus } from '../electron/dayreplay/ipc'

// 固定时钟：2026-10-14 12:00 本地
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime()
const dayTs = (h: number, m = 0, s = 0, ms = 0) => new Date(2026, 9, 14, h, m, s, ms).getTime()
const atIso = (h: number, m = 0, s = 0) => new Date(2026, 9, 14, h, m, s).toISOString()
const yesterdayIso = (h = 9) => new Date(2026, 9, 13, h).toISOString()
const tomorrowIso = (h = 1) => new Date(2026, 9, 15, h).toISOString()

// ── 确定的假数据 ─────────────────────────────────────────────

function makeRows(): LlmUsageRowLike[] {
  return [
    // 故意乱序返回，验证排序
    { ts: dayTs(10, 30), provider: 'deepseek', model: 'deepseek-v4', purpose: 'delegate',
      agentId: 'yak', promptTokens: 500, completionTokens: 100, cost: 0.005, success: true },
    { ts: dayTs(9), provider: 'deepseek', model: 'deepseek-v4', purpose: 'chat',
      agentId: '', promptTokens: 1000, completionTokens: 200, cost: 0.01234, success: true },
    { ts: dayTs(23, 59, 59, 999), provider: 'qwen', model: 'qwen-max', purpose: 'social',
      agentId: 'recha', promptTokens: 100, completionTokens: 50, cost: 0.0001, success: false },
    // 隔壁两天，必须被切掉
    { ts: dayTs(0) - 1, provider: 'deepseek', model: 'x', purpose: 'chat',
      promptTokens: 1, completionTokens: 1, cost: 999, success: true },
    { ts: new Date(2026, 9, 15, 0, 0, 0, 500).getTime(), provider: 'deepseek', model: 'x',
      purpose: 'chat', promptTokens: 1, completionTokens: 1, cost: 999, success: true },
  ]
}

function makeAdapters(): DayReplayAdapters {
  const cmds = [
    { at: atIso(9, 5), command: 'git add a.ts b.ts', disposition: 'passed', source: 'shell_exec' },
    { at: atIso(9, 6), command: 'git checkout main -- c.ts', disposition: 'passed' },
    { at: atIso(11), command: 'Remove-Item -Recurse -Force C:\\', disposition: 'blocked' },
    { at: tomorrowIso(), command: 'git add should-not-count.txt', disposition: 'passed' },
  ]
  const projects = [
    {
      name: '做个小工具',
      createdAt: atIso(9),
      tasks: [
        { title: '写核心逻辑', status: 'done', assignTo: 'yak',
          createdAt: atIso(9, 10), completedAt: atIso(9, 20), elapsedMs: 60_000 },
        { title: '补测试', status: 'pending', assignTo: 'yak',
          createdAt: atIso(9, 11), completedAt: null },
        { title: '昨天的旧任务', status: 'done', assignTo: 'yak',
          createdAt: yesterdayIso(), completedAt: yesterdayIso() },
      ],
    },
  ]
  const interns = [
    { id: 'intern_yak_小陈', name: '实习生小陈', owner: 'yak', status: 'done',
      createdAt: atIso(9, 30), completedAt: atIso(10), taskCount: 3 },
    { id: 'intern_yak_老陈', name: '实习生老陈', owner: 'yak', status: 'done',
      createdAt: yesterdayIso(15), completedAt: yesterdayIso(16), taskCount: 1 },
  ]
  return {
    ledger: { queryRange: (_s, _e) => makeRows() },
    commands: { list: () => cmds },
    projects: { getAllProjects: () => projects },
    interns: { getAll: () => interns },
    now: () => NOW,
  }
}

function makeService() {
  return createDayReplayService(makeAdapters())
}

// ═══════════════════════════════════════════════════════════
// 日期边界与校验
// ═══════════════════════════════════════════════════════════

describe('日期切割与校验', () => {
  it('默认日期 = 本地今天', () => {
    const r = makeService().buildDailyReplay()
    expect(r.date).toBe('2026-10-14')
  })

  it('跨天切割：00:00:00.000 与 23:59:59.999 在界内，次日 00:00:00.500 在界外', () => {
    const r = makeService().buildDailyReplay('2026-10-14')
    // 界内三条账本：9:00 / 10:30 / 23:59:59.999
    expect(r.stats.llmCalls).toBe(3)
    expect(r.stats.promptTokens).toBe(1000 + 500 + 100)
    // 越界的两条 cost=999 绝不能进统计
    expect(r.stats.costYuan).toBe(0.0174)
    expect(r.stats.byAgent).toEqual({ '主对话': 1, yak: 1, recha: 1 })
  })

  it('非法日期抛可识别错误', () => {
    const svc = makeService()
    for (const bad of ['2026/10/14', 'abc', '2026-13-01', '2026-02-30', '2026-10-1', '20261014']) {
      try {
        svc.buildDailyReplay(bad)
        throw new Error(`应该抛错: ${bad}`)
      } catch (e: any) {
        expect(e).toBeInstanceOf(DayReplayError)
        expect(e.code).toBe('E_DAYREPLAY_BAD_DATE')
      }
    }
  })

  it('合法但空的日期：昨天只有边界上的 1 条账本和 1 个委托', () => {
    const r = makeService().buildDailyReplay('2026-10-13')
    // 假数据：10-13 23:59:59.999 那条账本归昨天（不归今天），老陈也是昨天招的
    expect(r.date).toBe('2026-10-13')
    expect(r.stats.llmCalls).toBe(1)
    expect(r.stats.delegates).toBe(1)
    expect(r.stats.commands).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════
// 各数据源聚合 + stats 逐项
// ═══════════════════════════════════════════════════════════

describe('聚合正确性', () => {
  let r: DailyReplay
  beforeEach(() => {r = makeService().buildDailyReplay('2026-10-14')})

  it('stats 逐项正确', () => {
    expect(r.stats.commands).toBe(3)               // 明天那条被切掉
    expect(r.stats.filesChanged).toBe(3)           // a.ts b.ts c.ts
    expect(r.stats.turns).toBe(2)                 // social 那条失败
    expect(r.stats.delegates).toBe(1)             // 小陈
    expect(r.stats.llmCalls).toBe(3)
    expect(r.stats.completionTokens).toBe(200 + 100 + 50)
    expect(r.stats.byPurpose).toEqual({ chat: 1, delegate: 1, social: 1 })
  })

  it('时间线按 ts 升序（账本故意乱序返回）', () => {
    for (let i = 1; i < r.items.length; i++) {
      expect(r.items[i].ts).toBeGreaterThanOrEqual(r.items[i - 1].ts)
    }
  })

  it('时间线种类齐全：llm / command / file / task / delegate', () => {
    const kinds = new Set(r.items.map(i => i.kind))
    expect(kinds).toEqual(new Set(['llm', 'command', 'file', 'task', 'delegate']))
  })

  it('命令条目带处置标签，被拦截的命令也在时间线里', () => {
    const blocked = r.items.find(i => i.kind === 'command' && i.detail === '已拦截')
    expect(blocked).toBeTruthy()
  })

  it('任务条目：完成的任务挂在完成时间上', () => {
    const done = r.items.find(i => i.kind === 'task' && i.title.startsWith('完成任务：写核心逻辑'))
    expect(done).toBeTruthy()
    expect(done!.actor).toBe('yak')
  })
})

// ═══════════════════════════════════════════════════════════
// filesChanged best-effort
// ═══════════════════════════════════════════════════════════

describe('filesChanged best-effort', () => {
  it('git add / git checkout -- 能挖出文件', () => {
    expect(extractGitFiles('git add a.ts b.ts')).toEqual(['a.ts', 'b.ts'])
    expect(extractGitFiles('git checkout main -- src/x.ts')).toEqual(['src/x.ts'])
  })

  it('git commit 没有文件信息 → 不编造', () => {
    expect(extractGitFiles('git commit -m "wip"')).toEqual([])
  })

  it('git add -A 这种全局标记 → 提取不到具体文件，不计', () => {
    expect(extractGitFiles('git add -A')).toEqual([])
  })

  it('统计对不上就保持 0：没有 git 命令时 filesChanged = 0', () => {
    const svc = createDayReplayService({
      ledger: { queryRange: () => [] },
      commands: { list: () => [{ at: atIso(9), command: 'Get-ChildItem', disposition: 'passed' }] },
      projects: { getAllProjects: () => [] },
      interns: { getAll: () => [] },
      now: () => NOW,
    })
    const r = svc.buildDailyReplay('2026-10-14')
    expect(r.stats.filesChanged).toBe(0)
    expect(r.items.some(i => i.kind === 'file')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// 渲染
// ═══════════════════════════════════════════════════════════

describe('Markdown / Text 渲染', () => {
  let r: DailyReplay
  beforeEach(() => {r = makeService().buildDailyReplay('2026-10-14')})

  it('Markdown 包含关键段落与花费（4 位小数）', () => {
    const md = makeService().renderReplayMarkdown(r)
    expect(md).toContain('# 这一天 · 2026-10-14')
    expect(md).toContain('¥0.0174')
    expect(md).toContain('## 团队')
    expect(md).toContain('## 干活痕迹')
    expect(md).toContain('## 谁在出力')
    expect(md).toContain('回放明细')
  })

  it('不泄露内部技术术语', () => {
    const md = makeService().renderReplayMarkdown(r)
    for (const term of ['ReAct', 'BM25', 'usageLedger', 'sandboxAudit', 'agentId']) {
      expect(md).not.toContain(term)
    }
  })

  it('Text 版是 Markdown 去符号的等价版本', () => {
    const txt = makeService().renderReplayText(r)
    expect(txt).toContain('这一天 · 2026-10-14')
    expect(txt).not.toContain('#')
    expect(txt).toContain('花费 ¥0.0174')
    expect(txt).toContain('【团队】')
  })

  it('空数据日诚实输出，不编造段落', () => {
    const svc = createDayReplayService({ now: () => NOW })
    const empty = svc.buildDailyReplay('2026-10-14')
    const md = svc.renderReplayMarkdown(empty)
    expect(md).toBe('# 这一天 · 2026-10-14\n\n这一天没有活动记录。')
    const txt = svc.renderReplayText(empty)
    expect(txt).toBe('这一天 · 2026-10-14\n\n这一天没有活动记录。')
  })
})

// ═══════════════════════════════════════════════════════════
// IPC 注册幂等
// ═══════════════════════════════════════════════════════════

describe('registerDayReplayIpc', () => {
  it('可重复调用：同一频道只 handle 一次', () => {
    const calls: string[] = []
    const fakeBus: IpcBus = {
      handle: (channel: string) => {calls.push(channel)},
    }
    registerDayReplayIpc(fakeBus)
    registerDayReplayIpc(fakeBus)
    registerDayReplayIpc(fakeBus)
    expect(calls).toEqual([
      'dayreplay:today',
      'dayreplay:get',
      'dayreplay:export',
    ])
  })

  it('bus 拿不到（无 electron 环境）时静默不崩', () => {
    // getDefaultBus 失败返回 null —— 不应抛
    expect(() => registerDayReplayIpc()).not.toThrow()
  })
})
