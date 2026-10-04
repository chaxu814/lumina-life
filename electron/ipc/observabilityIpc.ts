// ================================================================
// ipc/observabilityIpc.ts — 记忆审判台 + 团队泳道画布 的 IPC
//
// 【为什么单独一个文件】
// 这两个模块是 2026-10-04 新增的。写完逻辑 + 单测 + UI 面板之后，
// 自查发现它们**模块外零引用** —— 有 preload 缺口的 IPC、有没挂载的面板，
// 有 67 个用例在跑，但运行时一行都执行不到。
//
// 这不是新问题，是本项目反复出现的同一类：
//   · SkillMarketPanel 走 window.electron（不存在的通道）→ 整个面板是死的
//   · 三 Agent 团队在打包版里 require 断链 → 招牌能力全废
//   · 渠道主键在 IPC 边界被销毁又伪造
//
// 共同点：**接缝在中间层，两侧都「看起来正常」**。
// 所以这个文件存在的意义就是把接缝显式化，并让 tests/observabilityWiring.test.ts
// 把「主进程 → preload → 面板」三层钉成可回归的不变式。
// ================================================================

import { ipcMain } from 'electron'
import { getMemoryEvidence } from '../memoryEvidence'
import { MemoryTrialBench } from '../memory/trialBench'
import { swimlaneFromBoard, swimlaneFromTrace, type SwimlaneModel } from '../team/swimlane'
// 🔧 2026-10-04：这两个数据源**必须静态 import**。
//   初版写的是 `require('../team/teamSharedBoard')` 惰性加载 ——
//   打包器把模块压平后该相对路径必然解析失败，被 bundle-requires-gate 门禁当场抓出。
//   这正是本项目反复栽跟头的那一类（打包 require 断链、团队动态 import、渠道 key 伪造）：
//   **接缝在中间层，两侧都看起来正常**。
//   已确认无循环依赖：teamSharedBoard / llmTrace 只 import electron / fs / path。
import { getSharedBoard } from '../team/teamSharedBoard'
import { getTaskTrace } from '../team/llmTrace'

/** 审判台单例：裁决历史必须跨会话留存，否则「记错了」这个反馈等于没给 */
let _bench: MemoryTrialBench | null = null

function getBench(): MemoryTrialBench {
  if (!_bench) {
    // 刻意不注入 MemoryStore 实例 —— 审判台读的是 store 自己的数据源，
    // 写入裁决时才落库。这样单测可以用纯内存 mock 替换掉它。
    _bench = new MemoryTrialBench()
  }
  return _bench
}

export function registerObservabilityIpc(): void {
  // ─── 记忆审判台 ─────────────────────────────────────
  ipcMain.handle('memory-trial:review', async () => {
    try {
      // 用证据引擎的评分结果，而不是直接从 SQLite 拿原始事实 ——
      // 审判台要展示的就是**带证据评分**的记忆，直接给原始 FactEntry 会缺
      // compositeScore / status / mentionCount 这些面板真正要用的字段。
      const scored = getMemoryEvidence().getMemoriesByScore().slice(0, 50)
      return { ok: true, items: getBench().review(scored) }
    } catch (err: unknown) {
      // 降级：记忆读不到不该让审判台整个不可用
      return { ok: false, error: (err instanceof Error ? err.message : String(err)), items: [] as unknown[] }
    }
  })

  ipcMain.handle('memory-trial:submit', async (_e, payload: {
    memoryKey: string
    verdict: string
    reason?: string
  }) => {
    try {
      const result = getBench().submit(payload.memoryKey, payload.verdict, payload.reason)
      // 刻意不把 result 展开到顶层 —— 它自带 ok 字段，展开会覆盖本层的 ok=true，
      // 面板就无法区分「IPC 失败」与「业务上被拒绝」这两种情况。
      return { ok: true, result: result as unknown }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) }
    }
  })

  ipcMain.handle('memory-trial:stats', async () => {
    try {
      return { ok: true, stats: getBench().stats() as unknown }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) }
    }
  })

  ipcMain.handle('memory-trial:history', async (_e, memoryKey?: string) => {
    try {
      return { ok: true, records: getBench().history(memoryKey) as unknown[] }
    } catch (err: unknown) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) }
    }
  })

  // ─── 团队泳道画布 ───────────────────────────────────
  // ⚠️ 真实数据源（teamSharedBoard / llmTrace）都 import electron 的 app，
  //   在这里动态 require 会与 tools 形成环（项目里已因此踩过一次）。
  //   所以走惰性 require，失败时返回 null —— 面板会显示「还没有可画的协作任务」
  //   而不是白屏。这与 SwimlaneCanvas 现有的降级分支一致。
  ipcMain.handle('swimlane:get', async (): Promise<SwimlaneModel | null> => {
    try {
      // 优先看板（有依赖关系），退回 trace（有起止时间）。两者都空则返回 null，
      // 面板会显示「还没有可画的协作任务」—— 而不是画一张空图或白屏。
      const tasks = getSharedBoard().list()
      if (Array.isArray(tasks) && tasks.length > 0) {
        const fromBoard = swimlaneFromBoard(tasks)
        if (fromBoard.nodes.length > 0) {return fromBoard}
      }
      const entries = getTaskTrace().list(200)
      return Array.isArray(entries) && entries.length > 0
        ? swimlaneFromTrace(entries)
        : null
    } catch (err: unknown) {
      // 数据源不可达是**可降级**状态，不是致命错误；留一行痕便于排障。
      // eslint-disable-next-line no-console
      console.warn('[ObservabilityIPC] 泳道数据源不可用，返回空图:', err instanceof Error ? err.message : String(err))
      return null
    }
  })
}
