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
   * 默认通过平台适配器 focusWindow(config.windowTitle) 实现。
   */
  focusTarget?: () => Promise<boolean>
  /**
   * 决策连续返回 null（未检测到游戏/模型要求停止）时的容错轮数：
   * 前 N 次先重新聚焦并继续，超过才停止。默认 2。
   */
  nullDecideGrace?: number
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

请选择下一步动作。只输出 JSON：
{"action":"动作名","duration_ms":500,"reason":"一句话理由","stop":false}
action 必须是以下之一：${Object.keys(profile.actionMap).join('、')}
注意：click 只会点击屏幕正中心；若游戏不在屏幕中心，请改用方向键等键盘动作。
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
    focusTarget,
    nullDecideGrace = 2,
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

  // 默认聚焦：走平台适配器按窗口标题找窗并前台 + 点中心聚焦内容区
  const defaultFocus = async (): Promise<boolean> => {
    try {
      const { getPlatformAdapter } = await import('../core/platform')
      const adapter = getPlatformAdapter()
      if (typeof adapter.focusWindow !== 'function') {return true}
      return await adapter.focusWindow(config.windowTitle || profile.displayName)
    } catch {
      return true // 聚焦失败不阻断闭环（动作执行层仍会尝试）
    }
  }
  const focusFn = focusTarget || defaultFocus

  // 启动前先聚焦一次，避免首轮感知到的是其他窗口
  try {await focusFn()} catch { /* 忽略 */ }

  const start = Date.now()
  let roundsPlayed = 0
  let actionsExecuted = 0
  let dangerousBlocked = 0
  let consecutiveBlocked = 0
  let consecutiveNull = 0
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

    // 决策返回 null → 容错：未超 grace 先重新聚焦继续，否则停止
    if (!action) {
      consecutiveNull++
      if (consecutiveNull <= nullDecideGrace) {
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
      if (result.ok) {actionsExecuted++}
    } catch (e: any) {
      result = { ok: false, content: `执行异常: ${e?.message || e}`, error: 'exec_error' }
    }

    onRound?.({
      round: roundsPlayed, state, action, result, stopped: false,
    })

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
