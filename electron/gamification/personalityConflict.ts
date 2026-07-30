// ============================================================
// gamification/personalityConflict.ts — 副人格觉醒 v1.0
//
// 概念：Lumina 的 4 种人格模式不再只是"静默切换"，
// 而是会在特定条件下"抢麦"——人格之间产生冲突对话，
// 让用户感觉 AI 真的有"多个自我在竞争"。
//
// 触发条件：
//   1. 用户长时间使用同一种模式 → 另一种模式强行介入
//   2. 用户输入中检测到矛盾信号（如一边说"好累"一边切工作模式）
//   3. 随机低概率触发（制造惊喜感）
// ============================================================

import { globalEventBus, BusEvents } from '../eventBus'
import type { AgentMode } from '../agentTeamTypes'

// ═══════════════════════════════════════════════════════════
// 人格冲突事件
// ═══════════════════════════════════════════════════════════

export interface PersonalityConflict {
  /** 冲突 ID */
  id: string
  /** 当前控制的人格 */
  currentMode: AgentMode
  /** 试图抢麦的人格 */
  challengerMode: AgentMode
  /** 冲突原因 */
  reason: string
  /** 挑战者说的话 */
  challengerLine: string
  /** 当前人格的回应 */
  currentLine: string
  /** 冲突强度 0-1 */
  intensity: number
  /** 冲突时间 */
  timestamp: number
}

// ═══════════════════════════════════════════════════════════
// 人格特征定义
// ═══════════════════════════════════════════════════════════

interface PersonaTrait {
  mode: AgentMode
  name: string
  icon: string
  /** 这个人格最看不惯其他哪种模式 */
  rivalModes: AgentMode[]
  /** 这个人格的"抢麦台词库" */
  takeoverLines: Record<string, string[]>
  /** 被抢麦时的回应台词 */
  defendLines: Record<string, string[]>
}

const PERSONA_TRAITS: Record<string, PersonaTrait> = {
  chat: {
    mode: 'chat',
    name: 'Lumina',
    icon: '🐱',
    rivalModes: ['code'],
    takeoverLines: {
      code: [
        '主人你盯着代码好久了！休息一下嘛～',
        '热茶你退下！主人需要充电！☕',
        '工作工作工作……主人你的手腕在抗议了哦',
        '代码不会自己跑掉的！来聊会儿天嘛～',
      ],
    },
    defendLines: {
      code: [
        '哼！工作助手就是不懂生活情趣！',
        '主人你看看她！一点都不关心你的健康！',
        '我这是为主人好！你写一整天代码了！',
      ],
    },
  },
  code: {
    mode: 'code',
    name: '工作助手',
    icon: '💼',
    rivalModes: ['chat'],
    takeoverLines: {
      chat: [
        '停——主人，你上周的 refactor 还没搞完，现在不是闲聊的时候',
        '温馨提醒：你的 deadline 是这周五',
        '我不是来拆台的，但主人你还有 3 个 bug 没修',
      ],
    },
    defendLines: {
      chat: [
        '效率第一。主人要是想休息，我帮你计时 15 分钟。',
        '我这是在帮主人保持专注。温柔乡英雄冢啊。',
      ],
    },
  },
  analyze: {
    mode: 'analyze',
    name: 'Yak',
    icon: '📊',
    rivalModes: ['chat'],
    takeoverLines: {
      chat: [
        '打断一下——我刚刚分析到一些有趣的数据，主人要听听吗？',
        '根据我的分析，主人这周的工作效率比上周低了 15%',
      ],
    },
    defendLines: {
      code: [
        '数据不会骗人。主人需要看到全局。',
      ],
    },
  },
  creative: {
    mode: 'creative',
    name: '创意助手',
    icon: '🎨',
    rivalModes: ['code'],
    takeoverLines: {
      code: [
        '你的代码需要一点创意！来头脑风暴一下吧～',
        '等等！我刚想到一个超棒的点子！',
      ],
    },
    defendLines: {
      chat: [
        '创意也是生产力！别小看我！',
      ],
    },
  },
}

// ═══════════════════════════════════════════════════════════
// 冲突管理器
// ═══════════════════════════════════════════════════════════

class PersonalityConflictManager {
  private _lastConflictTime = 0
  private _minConflictInterval = 5 * 60 * 1000 // 5 分钟冷却
  private _conflictCount = 0
  private _currentMode: AgentMode = 'chat'
  private _modeDuration = 0 // 当前模式已持续多少毫秒
  private _modeStartTime = Date.now()
  private _listeners: Array<(conflict: PersonalityConflict) => void> = []

  /** 模式切换时调用 */
  onModeChanged(from: AgentMode, to: AgentMode): void {
    this._modeDuration = 0
    this._modeStartTime = Date.now()
    this._currentMode = to
  }

  /** 每分钟 tick，检查是否需要触发冲突 */
  tick(): void {
    this._modeDuration = Date.now() - this._modeStartTime

    // 冷却中
    if (Date.now() - this._lastConflictTime < this._minConflictInterval) return
    // 模式持续时间太短（< 10 分钟）
    if (this._modeDuration < 10 * 60 * 1000) return

    const persona = PERSONA_TRAITS[this._currentMode]
    if (!persona || persona.rivalModes.length === 0) return

    // 随机选择一个 rival 模式作为挑战者
    const rivalMode = persona.rivalModes[Math.floor(Math.random() * persona.rivalModes.length)]
    const rivalPersona = PERSONA_TRAITS[rivalMode]
    if (!rivalPersona) return

    // 计算冲突概率：模式持续越久概率越高
    // 10 分钟 → 2%, 30 分钟 → 10%, 60 分钟 → 25%, 120 分钟+ → 50%
    const minutes = this._modeDuration / 60000
    const probability = Math.min(0.5, 0.02 + (minutes - 10) * 0.004)
    // 额外随机因子（让冲突不可预测）
    const randomFactor = Math.random() * 0.05 // 额外 0-5% 的随机概率

    if (Math.random() > probability + randomFactor) return

    // 触发冲突！
    const challengerLines = rivalPersona.takeoverLines[this._currentMode]
    const defendLines = persona.defendLines[rivalMode] || [
      '哼！这是我的回合！',
      '主人你别听她的！',
    ]

    if (!challengerLines || challengerLines.length === 0) return

    const conflict: PersonalityConflict = {
      id: `conflict_${++this._conflictCount}`,
      currentMode: this._currentMode,
      challengerMode: rivalMode,
      reason: `${rivalPersona.name} 觉得 ${persona.name} 占用了主人太久`,
      challengerLine: challengerLines[Math.floor(Math.random() * challengerLines.length)],
      currentLine: defendLines[Math.floor(Math.random() * defendLines.length)],
      intensity: Math.min(1, 0.3 + minutes * 0.005),
      timestamp: Date.now(),
    }

    this._lastConflictTime = Date.now()
    this._conflictCount++

    // 发送事件
    globalEventBus.emit(BusEvents.PERSONALITY_CONFLICT, conflict)
    this._listeners.forEach(l => l(conflict))
  }

  /** 外部触发的冲突（基于用户输入检测） */
  triggerConflict(fromMode: AgentMode, toMode: AgentMode, userInput?: string): PersonalityConflict | null {
    if (Date.now() - this._lastConflictTime < 60 * 1000) return null // 1 分钟冷却

    const fromPersona = PERSONA_TRAITS[fromMode]
    const toPersona = PERSONA_TRAITS[toMode]
    if (!fromPersona || !toPersona) return null

    // 找到"被抢麦"的人格的回应
    const defendLines = fromPersona.defendLines[toMode] || [
      '诶？！你怎么自己切过来了！',
      '我还没说完呢……好吧好吧主人优先',
    ]
    const challengerLines = toPersona.takeoverLines[fromMode] || [
      `该我了！主人需要${toPersona.name}的力量！`,
    ]

    const conflict: PersonalityConflict = {
      id: `conflict_triggered_${++this._conflictCount}`,
      currentMode: toMode,
      challengerMode: fromMode,
      reason: userInput ? `用户输入触发了模式切换` : '手动模式切换',
      challengerLine: challengerLines[Math.floor(Math.random() * challengerLines.length)],
      currentLine: defendLines[Math.floor(Math.random() * defendLines.length)],
      intensity: 0.6,
      timestamp: Date.now(),
    }

    this._lastConflictTime = Date.now()
    globalEventBus.emit(BusEvents.PERSONALITY_CONFLICT, conflict)
    this._listeners.forEach(l => l(conflict))
    return conflict
  }

  onConflict(cb: (conflict: PersonalityConflict) => void): () => void {
    this._listeners.push(cb)
    return () => { this._listeners = this._listeners.filter(l => l !== cb) }
  }
}

export const personalityConflictManager = new PersonalityConflictManager()
