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
import { MemoryTrialBench, type TrialSink, type TrialStore } from '../memory/trialBench'
import { getMemoryStore } from '../memory/memoryStore'
import { swimlaneFromBoard, swimlaneFromTrace, type SwimlaneModel } from '../team/swimlane'
// 🔧 2026-10-04：这两个数据源**必须静态 import**。
//   初版写的是 `require('../team/teamSharedBoard')` 惰性加载 ——
//   打包器把模块压平后该相对路径必然解析失败，被 bundle-requires-gate 门禁当场抓出。
//   这正是本项目反复栽跟头的那一类（打包 require 断链、团队动态 import、渠道 key 伪造）：
//   **接缝在中间层，两侧都看起来正常**。
//   已确认无循环依赖：teamSharedBoard / llmTrace 只 import electron / fs / path。
import { getSharedBoard } from '../team/teamSharedBoard'
import { getTaskTrace } from '../team/llmTrace'
// 情绪数据源：per-agent 失败连击 + 全局因果状态。两者都是**真实驱动**的
// （worker 真的失败过 / 真的重试过），不是新造一个没人写的假 store。
import { getWorkerFailureStreak, snapshotEmotionCausality, getCausalFrontendThree, getCausalGatingHints } from '../pet/emotionCausalityBridge'

/**
 * 审判台单例：裁决历史必须跨会话留存，否则「记错了」这个反馈等于没给。
 *
 * 🔧 2026-10-15：原实现是 `new MemoryTrialBench()` —— 不传 store、不传 sink。
 * 后果不是「少了个功能」，而是**面板在说谎**：
 *   · sink 为 null → trialBench.submit() 里的回写分支从不执行，SQLite 里什么都没变
 *   · sinkError 因此永不被设置 → 面板的诚实提示路径永不触发，一律显示「已生效」
 *   · records 是内存 Map 且无上层持久化 → 重启后裁决历史全部蒸发
 * 而面板上明确写着「你的纠正会真的下调它的记忆权重并标记为已被证伪」。
 * 这是本项目最痛的那类**假成功**，必须接线，不能靠面板降级掩盖。
 */
let _bench: MemoryTrialBench | null = null

/** 取一个能用「事实读取 + 裁决落库」能力的 store；取不到就返回 null 而不是硬撑 */
function getTrialStore(): (TrialStore & {
  applyTrialVerdict?: (w: Parameters<TrialSink>[0]) => { ok: boolean; factId: number | null }
}) | null {
  try {
    const s = getMemoryStore() as unknown as {
      getFacts?: (category?: string, limit?: number) => unknown[]
    }
    if (typeof s?.getFacts !== 'function') {return null}
    return s as never
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.warn('[TrialBench] 记忆存储不可用，审判台将以只读模式运行：',
      err instanceof Error ? err.message : String(err))
    return null
  }
}

function getBench(): MemoryTrialBench {
  if (!_bench) {
    const store = getTrialStore()
    // sink 缺失时**故意不注入**，让 submit() 走「无 sink」分支并如实留痕。
    // 宁可让面板显示「落库失败」，也不制造第二次假成功。
    const sink: TrialSink | undefined = store && typeof store.applyTrialVerdict === 'function'
      ? (w) => {
          const r = store.applyTrialVerdict!(w)
          if (!r.ok) {
            // 留了档但没匹配到事实行：仍然算失败，因为用户要的是权重真的变了
            throw new Error('未能在事实库中定位到这条记忆，权重未变更（裁决已留档）')
          }
        }
      : undefined
    if (!store) {
      // eslint-disable-next-line no-console
      console.warn('[TrialBench] 未接入记忆存储，裁决将不会被持久化')
    }
    _bench = new MemoryTrialBench(store, sink ? { sink } : undefined)
  }
  return _bench
}

/** 效价夹到 [-1,+1]（mood 的口径） */
function clamp11(v: number): number {
  if (!Number.isFinite(v)) {return 0}
  return Math.max(-1, Math.min(1, v))
}

/** 比例夹到 [0,1]（energy / affinity 的口径） */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) {return 0.5}
  return Math.max(0, Math.min(1, v))
}

/**
 * 由真实数值生成标签。
 * 【为什么不叫 emotionFusion 的 label】那个 class 是**单实例桌宠**的平滑层，
 * 带自己的状态与漂移；这里只需要一个无状态的映射，不能把桌宠的状态混进团队仪表盘。
 */
function labelOf(mood: number, energy: number, streak: number): string {
  if (streak >= 3) {return '受挫 😟'}
  if (mood <= -0.3) {return '低落 😕'}
  if (mood >= 0.5) {return '愉快 😄'}
  if (energy < 0.35) {return '疲惫 😪'}
  return '平静 😐'
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
  // ─── 团队情绪（情绪仪表盘）─────────────────────────────
  // 【为什么数据源是这两个，而不是新造一个 store】
  // 1. snapshotEmotionCausality —— 全局因果状态，由**真实的** worker 失败 /
  //    验证重试 / 用户否定驱动（2026-10-04 已接进门控，所以它真的在动）。
  // 2. getWorkerFailureStreak(agentId) —— 每个成员**自己的**失败连击数。
  //    这是 per-agent 的真实历史，而不是给三个 Agent 塞同一份值。
  //
  // 【明确不伪造的部分】
  // history（时间序列）返回空数组 —— 项目里目前没有情绪时序存储。
  // 编一条假曲线出来比留空更糟：用户会以为那是真实波动。
  ipcMain.handle('team:emotions', async () => {
    try {
      const snap = snapshotEmotionCausality()
      const f3 = getCausalFrontendThree()
      // mood 是 [-1,+1] 效价，energy/affinity 是 [0,1]；无因果数据时回落中性值
      const baseMood = Number.isFinite(f3?.mood) ? f3.mood : 0
      const baseEnergy = Number.isFinite(f3?.energy) ? f3.energy : 0.7
      const baseAffinity = Number.isFinite(f3?.affinity) ? f3.affinity : 0.5

      const emotions: Record<string, unknown> = {}
      for (const id of ['lumina', 'yak', 'recha']) {
        const streak = Math.max(0, getWorkerFailureStreak(id as 'lumina' | 'yak' | 'recha'))
        // 某个 agent 连续失败越多，affinity（信任）掉得越多
        const penalty = Math.min(0.3, streak * 0.06)
        const mood = clamp11(baseMood - penalty)
        const affinity = clamp01(baseAffinity - penalty)
        const energy = clamp01(baseEnergy - streak * 0.04)
        emotions[id] = {
          mood,
          energy,
          affinity,
          label: labelOf(mood, energy, streak),
          // 失败连击是**真实**的，面板可以用它解释「为什么她今天心情差」
          failureStreak: streak,
          // 明确留空：没有情绪时序存储就不编曲线
          history: [],
        }
      }
      return {
        ok: true,
        emotions,
        hasLiveData: Boolean(snap),
        // 🫀 情绪因果链：把「她今天为什么这样」翻译成人能读的一句话。
        //   来源是真实的因果引擎（worker 失败 / 验证重试 / 用户否定驱动），
        //   不是模板文案。为空数组时面板不渲染该区块。
        causalReasons: (() => {
          try {
            const hints = getCausalGatingHints()
            return Array.isArray(hints?.reasons) ? hints.reasons.slice(0, 6) : []
          } catch { return [] }
        })(),
      }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), emotions: {} }
    }
  })

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
