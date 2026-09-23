// ============================================================
// electron/gaming/autoPlay.ts — 自主游玩闭环
//
// 感知 → 决策 → 安全审查 → 执行 → 间隔 → 循环，直到满足停止条件。
// 设计为可注入 decide / onRound / stopSignal，便于单测与 UI 集成。
//
// 安全护栏：
//   - 危险动作被拦时计数，连续 3 轮被拦自动停止
//   - 决策返回 null 表示 VLM 判断应停
//   - stopSignal 外部可紧急中断
// ============================================================

import type {
  GameActionRequest, GameActionResult, GameConfig, GameState,
} from './types'
import type { GameProfile } from './profiles'
import { reviewGameAction } from './security'
import { getGameState, executeGameAction } from './gameActions'

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
 * 默认决策：把 GameState 摘要交给 VLM，让它输出下一步动作 JSON。
 * 解析失败或 VLM 建议停止（stop:true）时返回 null。
 */
async function defaultDecide(
  profile: GameProfile,
  state: GameState,
  round: number,
): Promise<GameActionRequest | null> {
  // 延迟 import，避免测试环境强依赖 VLM
  const { callVisionModel } = await import('../tools/impl/cuCore')
  const prompt = `你正在操控 ${profile.displayName}。当前游戏状态：
${JSON.stringify({
  detected: state.detected,
  health: state.health,
  food: state.food,
  hotbar: state.hotbar,
  nearEntities: state.nearEntities,
  summary: state.raw,
}, null, 2)}

请选择下一步动作。只输出 JSON：
{"action":"动作名","duration_ms":500,"reason":"一句话理由","stop":false}
action 必须是以下之一：${Object.keys(profile.actionMap).join('、')}
如果局面平稳无事可做或需要用户介入，输出 {"stop":true,"reason":"..."}`

  try {
    const raw = await callVisionModel(prompt, `第 ${round} 轮决策`, '', true)
    // 提取 JSON
    let s = (raw || '').trim().replace(/```json\s*/gi, '').replace(/```/g, '').trim()
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start < 0 || end <= start) {return null}
    const j = JSON.parse(s.slice(start, end + 1))
    if (j.stop === true || !j.action) {return null}
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

  const decideFn = decide || ((state, round) => defaultDecide(profile, state, round))

  const start = Date.now()
  let roundsPlayed = 0
  let actionsExecuted = 0
  let dangerousBlocked = 0
  let consecutiveBlocked = 0
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

    // 决策返回 null → 停止
    if (!action) {
      stopReason = '决策函数返回停止'
      onRound?.({
        round: roundsPlayed, state, action: null, result: null, stopped: true, stopReason,
      })
      break
    }

    // 3. 安全审查
    const guard = reviewGameAction(action, profile)
    if (!guard.allowed) {
      dangerousBlocked++
      consecutiveBlocked++
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

    // 4. 执行
    let result: GameActionResult
    try {
      result = await executeGameAction(action, config)
      if (result.ok) {actionsExecuted++}
    } catch (e: any) {
      result = { ok: false, content: `执行异常: ${e?.message || e}`, error: 'exec_error' }
    }

    onRound?.({
      round: roundsPlayed, state, action, result, stopped: false,
    })

    // 5. 间隔
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
