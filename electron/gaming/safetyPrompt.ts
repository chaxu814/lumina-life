// ============================================================
// electron/gaming/safetyPrompt.ts — 温馨安全提示
//
// 首次开启游戏能力 / 首次进入自动游玩时，向用户展示友好的安全提醒。
// 确认状态持久化到 localStorage（测试可注入 storage）。
// ============================================================

export interface SafetyPromptState {
  /** 用户是否已确认游戏能力安全提示 */
  gameCapabilityAcknowledged: boolean
  /** 用户是否已确认自动游玩安全提示 */
  autoPlayAcknowledged: boolean
  /** 确认时间（ISO 字符串） */
  acknowledgedAt?: string
}

const STORAGE_KEY = 'lumina.gameSafetyPrompt'

/** 首次开启游戏能力时的提示文案 */
export const SAFETY_PROMPT_GAME_CAPABILITY = `🎮 欢迎开启游戏陪伴能力～

在开始之前，有几句掏心窝子的话想跟你说：

✨ 只在单机、合作或官方明确允许的场景下使用。
🚫 千万不要用在带反作弊的竞技网游里（比如 BattlEye / EAC / VAC），自动化输入很容易被判定成外挂，到时候账号被封就亏大了。
🤝 多人游戏里请遵守用户协议，别影响其他玩家的体验。
👀 AI 的反应和判断力都有限，定位是陪你玩、帮你放松，重要或者不可逆的操作（比如删存档、大规模建造）最好人在旁边看一眼，点个确认再让我动手。

🌱 更适合我的游戏：单机沙盒（Minecraft、Factorio）、单机 RPG、模拟经营。
🌧️ 不太适合：竞技网游、PVP 排位、带反作弊的在线游戏。

准备好了吗？点「我知道了」就开始吧～`

/** 首次进入自动游玩时的提示文案 */
export const SAFETY_PROMPT_AUTO_PLAY = `🤖 即将进入自动游玩模式～

我会自己看画面、做决策、执行操作，直到你喊停或者到时间。再提醒一下：

👀 请保持人在旁边照看，自动操作可能不符合你的预期。
🚫 同样不要在带反作弊的竞技游戏里用自动游玩。
⏹️ 随时可以让我停下，或者我自己觉得局势不对也会停。
🛡️ 危险命令和破坏动作会被安全护栏拦下来。

放心交给我吧，点「我知道了」开始～`

/** 默认未确认状态 */
function defaultState(): SafetyPromptState {
  return { gameCapabilityAcknowledged: false, autoPlayAcknowledged: false }
}

/** 读取提示状态（默认 localStorage；测试可注入内存 storage） */
export function loadSafetyPromptState(storage?: Storage): SafetyPromptState {
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
    if (!s) {return defaultState()}
    const raw = s.getItem(STORAGE_KEY)
    if (!raw) {return defaultState()}
    const parsed = JSON.parse(raw)
    return {
      gameCapabilityAcknowledged: Boolean(parsed.gameCapabilityAcknowledged),
      autoPlayAcknowledged: Boolean(parsed.autoPlayAcknowledged),
      acknowledgedAt: parsed.acknowledgedAt,
    }
  } catch {
    return defaultState()
  }
}

/** 记录用户确认 */
export function acknowledgeSafetyPrompt(
  type: 'game' | 'autoplay',
  storage?: Storage,
): void {
  const state = loadSafetyPromptState(storage)
  if (type === 'game') {state.gameCapabilityAcknowledged = true}
  else {state.autoPlayAcknowledged = true}
  state.acknowledgedAt = new Date().toISOString()
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
    s?.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* 存储失败不影响运行 */ }
}
