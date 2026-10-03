// ============================================================
// electron/gaming/autoPlay.ts — 自主游玩闭环
//
// 感知 → 决策 → 安全审查 → 反作弊检测 → 执行 → 间隔 → 循环，直到满足停止条件。
// 设计为可注入 decide / onRound / stopSignal，便于单测与 UI 集成。
//
// 安全护栏：
//   - 危险动作被拦时计数，连续 3 轮被拦自动停止
//   - 命中反作弊竞技网游黑名单 → 立即硬停（anti_cheat_detected）
//   - 决策返回 null 表示 VLM 判断应停；开局 minRoundsBeforeStop 内不误停
//   - 连续 N 轮无成功动作（空转）→ 停止
//   - stopSignal 外部可紧急中断
// ============================================================

import type {
  GameActionRequest, GameActionResult, GameConfig, GameState,
} from './types'
import type { GameProfile } from './profiles'
import { reviewGameAction } from './security'
import { getGameState, executeGameAction } from './gameActions'
import { focusWindowRobust } from './focus'
import { detectAntiCheatGame } from './antiCheat'
import { callVisionModel } from '../tools/impl/cuCore'

export interface AutoPlayOptions {
  profile: GameProfile
  config: GameConfig
  /** 最大轮数，默认 20 */
  maxRounds?: number
  /** 最大时长 ms，默认 120000（2 分钟） */
  maxDurationMs?: number
  /** 每轮之间的最小间隔 ms，默认 800 */
  minIntervalMs?: number
  /** 自定义决策函数（默认用 VLM 分析画面后决策） */
  decide?: (state: GameState, round: number) => Promise<GameActionRequest | null>
  /** 每轮结束回调（用于 UI 展示过程） */
  onRound?: (info: AutoPlayRoundInfo) => void
  /**
   * 每轮执行动作前聚焦目标游戏窗口（关闭弹窗/翻译气泡造成的焦点丢失）。
   * 默认通过 focusWindowRobust() 实现（适配器聚焦 + 标题校验 + AppActivate 兜底 + 关弹窗）。
   */
  focusTarget?: () => Promise<boolean>
  /**
   * 决策连续返回 null（未检测到游戏/模型要求停止）时的容错轮数：
   * 前 N 次先重新聚焦并继续，超过才停止。默认 2。
   */
  nullDecideGrace?: number
  /**
   * 至少跑够 N 轮才允许因 VLM 主动要求停止（should_stop / null）而结束，
   * 避免开局误判立刻停。默认 0（不限制，向后兼容）。
   */
  minRoundsBeforeStop?: number
  /**
   * 连续 N 轮没有成功动作（空转）则停止，避免对着静止画面空跑。默认 5。
   */
  consecutiveNoOpLimit?: number
  /**
   * 每轮读取当前前台窗口标题的来源（用于反作弊黑名单检测）。
   * 默认走平台适配器 getActiveWindow。
   */
  getWindowTitle?: () => Promise<string | undefined>
  /** 停止信号（外部可设置为 true 来紧急中断） */
  stopSignal?: { stopped: boolean }
}

export interface AutoPlayRoundInfo {
  round: number
  state: GameState
  action: GameActionRequest | null
  result: GameActionResult | null
  stopped: boolean
  stopReason?: string
}

export interface AutoPlayResult {
  roundsPlayed: number
  stopped: boolean
  stopReason: string
  actionsExecuted: number
  dangerousBlocked: number
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * 默认决策：把当前 GameState + 最近历史动作 + profile.vlmPrompt 一起交给 VLM，
 * 要求输出 JSON {"action":"...","reason":"...","should_stop":bool}。
 * 解析失败 / VLM 要求停止时返回 null。
 */
async function defaultDecide(
  profile: GameProfile,
  state: GameState,
  round: number,
  history: string[],
): Promise<GameActionRequest | null> {
  const recent = history.slice(-8).join(' → ') || '（刚开始，还没有动作）'
  const prompt = `你正在操控 ${profile.displayName}。
${profile.vlmPrompt}

当前游戏状态：
${JSON.stringify({
  detected: state.detected,
  health: state.health,
  food: state.food,
  hotbar: state.hotbar,
  nearEntities: state.nearEntities,
  summary: state.raw,
}, null, 2)}

最近动作历史（按时间顺序）：${recent}

请选择下一步动作。只输出 JSON：
{"action":"动作名","duration_ms":500,"reason":"一句话理由","should_stop":false}
action 必须是以下之一：${Object.keys(profile.actionMap).join('、')}
注意：click 只会点击屏幕正中心；若游戏不在屏幕中心，请改用方向键等键盘动作。
如果局面平稳无事可做、需要用户介入、或你觉得该停了，输出 {"should_stop":true,"reason":"..."}。`

  try {
    const raw = await callVisionModel(prompt, `第 ${round} 轮决策`, '', true)
    // 提取 JSON
    const s = (raw || '').trim().replace(/```json\s*/gi, '').replace(/```/g, '').trim()
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start < 0 || end <= start) {return null}
    const j = JSON.parse(s.slice(start, end + 1))
    // 兼容旧字段 stop / should_stop
    if (j.should_stop === true || j.stop === true || !j.action) {return null}
    const req: GameActionRequest = {
      action: j.action,
      durationMs: typeof j.duration_ms === 'number' ? j.duration_ms : undefined,
      text: typeof j.text === 'string' ? j.text : undefined,
      slot: typeof j.slot === 'number' ? j.slot : undefined,
      profileId: profile.id,
    }
    return req
  } catch {
    return null
  }
}

/**
 * 运行自主游玩闭环。
 */
export async function runAutoPlay(options: AutoPlayOptions): Promise<AutoPlayResult> {
  const {
    profile,
    config,
    maxRounds = 20,
    maxDurationMs = 120000,
    minIntervalMs = 800,
    decide,
    onRound,
    focusTarget,
    nullDecideGrace = 2,
    minRoundsBeforeStop = 0,
    consecutiveNoOpLimit = 5,
    getWindowTitle,
    stopSignal,
  } = options

  // 模块未启用 → 直接返回
  if (!config.enabled) {
    return {
      roundsPlayed: 0,
      stopped: true,
      stopReason: '游戏模块未启用',
      actionsExecuted: 0,
      dangerousBlocked: 0,
    }
  }

  // 历史动作（喂给 VLM 决策，避免重复同一个动作）
  const history: string[] = []
  const decideFn = decide || ((state, round) => defaultDecide(profile, state, round, history))

  // 默认聚焦：focusWindowRobust（适配器聚焦 + 标题校验 + AppActivate 兜底 + 关弹窗）
  const targetTitle = config.windowTitle || profile.displayName
  const defaultFocus = async (): Promise<boolean> => {
    try {return await focusWindowRobust(targetTitle)}
    catch {return true /* 聚焦失败不阻断闭环 */}
  }
  const focusFn = focusTarget || defaultFocus

  // 默认读取前台窗口标题（反作弊检测用）：best-effort
  const defaultGetWindowTitle = async (): Promise<string | undefined> => {
    try {
      const { getPlatformAdapter } = await import('../core/platform')
      const aw = await getPlatformAdapter().getActiveWindow?.()
      return aw?.title
    } catch {return undefined}
  }
  const readTitle = getWindowTitle || defaultGetWindowTitle

  // 启动前先聚焦一次，避免首轮感知到的是其他窗口
  try {await focusFn()} catch { /* 忽略 */ }

  const start = Date.now()
  let roundsPlayed = 0
  let actionsExecuted = 0
  let dangerousBlocked = 0
  let consecutiveBlocked = 0
  let consecutiveNull = 0
  let consecutiveNoOp = 0
  let stopReason = ''

  while (roundsPlayed < maxRounds) {
    // 外部紧急停止
    if (stopSignal?.stopped) {
      stopReason = '外部停止信号'
      break
    }
    // 超时
    if (Date.now() - start > maxDurationMs) {
      stopReason = `超过最大时长 ${maxDurationMs}ms`
      break
    }

    roundsPlayed++

    // 0. 反作弊黑名单检测：命中带反作弊的竞技网游 → 立即硬停
    try {
      const title = await readTitle()
      const ac = detectAntiCheatGame(title)
      if (ac) {
        stopReason = `anti_cheat_detected:${ac}`
        onRound?.({
          round: roundsPlayed, state: { detected: false, hotbar: [] }, action: null, result: null,
          stopped: true, stopReason,
        })
        break
      }
    } catch { /* 读窗口失败不阻断 */ }

    // 1. 感知
    let state: GameState
    try {
      const sensed = await getGameState(config)
      state = sensed.state
    } catch (e: any) {
      state = { detected: false, hotbar: [], raw: `感知失败: ${e?.message || e}` }
    }

    // 2. 决策
    let action: GameActionRequest | null = null
    try {
      action = await decideFn(state, roundsPlayed)
    } catch (e: any) {
      action = null
    }

    // 决策返回 null → 容错
    if (!action) {
      consecutiveNull++
      consecutiveNoOp++
      // 开局保护：还没跑够 minRoundsBeforeStop 轮，先继续（不误停）
      const warmup = roundsPlayed < minRoundsBeforeStop
      if (warmup || consecutiveNull <= nullDecideGrace) {
        onRound?.({
          round: roundsPlayed, state, action: null, result: null, stopped: false,
        })
        try {await focusFn()} catch { /* 忽略 */ }
        await sleep(minIntervalMs)
        continue
      }
      stopReason = '决策函数连续返回停止'
      onRound?.({
        round: roundsPlayed, state, action: null, result: null, stopped: true, stopReason,
      })
      break
    }

    consecutiveNull = 0

    // 3. 安全审查
    const guard = reviewGameAction(action, profile)
    if (!guard.allowed) {
      dangerousBlocked++
      consecutiveBlocked++
      consecutiveNoOp++
      const result: GameActionResult = {
        ok: false,
        content: guard.reason || '被安全护栏拦截',
        error: 'guard_blocked',
      }
      onRound?.({
        round: roundsPlayed, state, action, result, stopped: false,
      })
      // 连续 3 轮被拦 → 停止
      if (consecutiveBlocked >= 3) {
        stopReason = `连续 ${consecutiveBlocked} 轮危险动作被拦`
        break
      }
      await sleep(minIntervalMs)
      continue
    }

    consecutiveBlocked = 0

    // 4. 聚焦目标窗口（防止弹窗/翻译气泡/其他窗口抢走键盘焦点）
    try {await focusFn()} catch { /* 聚焦失败不阻断 */ }

    // 5. 执行
    let result: GameActionResult
    try {
      result = await executeGameAction(action, config)
      if (result.ok) {
        actionsExecuted++
        consecutiveNoOp = 0 // 成功动作重置空转计数
        history.push(action.action)
      } else {
        consecutiveNoOp++
      }
    } catch (e: any) {
      result = { ok: false, content: `执行异常: ${e?.message || e}`, error: 'exec_error' }
      consecutiveNoOp++
    }

    onRound?.({
      round: roundsPlayed, state, action, result, stopped: false,
    })

    // 连续空转过多 → 停止（动作执行了但都失败）
    if (consecutiveNoOp >= consecutiveNoOpLimit && roundsPlayed >= minRoundsBeforeStop) {
      stopReason = `consecutive_no_op:连续 ${consecutiveNoOp} 轮无成功动作`
      break
    }

    // 6. 间隔
    await sleep(minIntervalMs)
  }

  if (!stopReason) {
    if (roundsPlayed >= maxRounds) {stopReason = `达到最大轮数 ${maxRounds}`}
  }

  return {
    roundsPlayed,
    stopped: true,
    stopReason: stopReason || '正常结束',
    actionsExecuted,
    dangerousBlocked,
  }
}
