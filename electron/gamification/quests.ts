// ============================================================
// gamification/quests.ts — 每日任务系统 v1.0 ⭐
//
// 「三驾马车」之主动任务：每日刷新，完成奖励 XP
// 让 Lumina 从「被动等成就」变成「主动催你玩」
// ============================================================

import { globalEventBus, BusEvents } from '../eventBus'
import { xpManager, XP_RULES } from './levels'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { app } from 'electron'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export type QuestDifficulty = 'easy' | 'medium' | 'hard'
export type QuestCategory = 'chat' | 'tool' | 'news' | 'social' | 'explore' | 'daily'

export interface QuestDef {
  id: string
  title: string
  description: string
  icon: string
  difficulty: QuestDifficulty
  category: QuestCategory
  /** 完成目标次数 */
  target: number
  /** 每次进度奖励 XP */
  xpPerProgress: number
  /** 完成奖励 XP（额外） */
  xpReward: number
  /** 检查进度的回调 */
  check: (stats: QuestProgressStats) => number
}

export interface QuestProgress {
  questId: string
  current: number
  target: number
  completed: boolean
  claimed: boolean
}

export interface QuestProgressStats {
  messagesToday: number
  toolCallsToday: number
  newsReadToday: number
  newsDigestsViewed: number
  chatsWithTeam: number
  memoriesCreated: number
  tasksCompleted: number
  loginStreak: number
  modesSwitched: number
  achievementsUnlocked: number
  searchUsed: number
  bookmarksAdded: number
}

export interface DailyQuestState {
  date: string
  quests: QuestProgress[]
  completedCount: number
  allCompleted: boolean
  streakBonus: number
}

// ═══════════════════════════════════════════════════════════
// 任务定义
// ═══════════════════════════════════════════════════════════

const ALL_QUESTS: QuestDef[] = [
  // ── 每日轻松任务 ──
  {
    id: 'daily_chat_5',
    title: '早安问候',
    description: '和 Lumina 聊 5 句话',
    icon: '💬',
    difficulty: 'easy',
    category: 'chat',
    target: 5,
    xpPerProgress: 4,
    xpReward: 30,
    check: (s) => Math.min(s.messagesToday, 5),
  },
  {
    id: 'daily_tool_1',
    title: '小试牛刀',
    description: '让 Lumina 用 1 次工具',
    icon: '🔧',
    difficulty: 'easy',
    category: 'tool',
    target: 1,
    xpPerProgress: 5,
    xpReward: 20,
    check: (s) => Math.min(s.toolCallsToday, 1),
  },
  {
    id: 'daily_news_1',
    title: '今日资讯',
    description: '看一眼今日新闻',
    icon: '📰',
    difficulty: 'easy',
    category: 'news',
    target: 1,
    xpPerProgress: 5,
    xpReward: 25,
    check: (s) => Math.min(s.newsReadToday, 1),
  },
  {
    id: 'daily_streak',
    title: '连续签到',
    description: '连续登录天数 ≥ 1',
    icon: '🔥',
    difficulty: 'easy',
    category: 'daily',
    target: 1,
    xpPerProgress: 10,
    xpReward: 15,
    check: (s) => Math.min(s.loginStreak, 1),
  },

  // ── 中等任务 ──
  {
    id: 'daily_chat_20',
    title: '畅聊时光',
    description: '和 Lumina 聊 20 句话',
    icon: '🗣️',
    difficulty: 'medium',
    category: 'chat',
    target: 20,
    xpPerProgress: 3,
    xpReward: 60,
    check: (s) => Math.min(s.messagesToday, 20),
  },
  {
    id: 'daily_tool_5',
    title: '工具达人',
    description: '使用 5 次工具',
    icon: '🛠️',
    difficulty: 'medium',
    category: 'tool',
    target: 5,
    xpPerProgress: 4,
    xpReward: 50,
    check: (s) => Math.min(s.toolCallsToday, 5),
  },
  {
    id: 'daily_team',
    title: '团队协作',
    description: '和 Agent 团队聊天 3 次',
    icon: '👥',
    difficulty: 'medium',
    category: 'social',
    target: 3,
    xpPerProgress: 6,
    xpReward: 45,
    check: (s) => Math.min(s.chatsWithTeam, 3),
  },
  {
    id: 'daily_memory',
    title: '铭记于心',
    description: '让 Lumina 记住 2 件事',
    icon: '🧠',
    difficulty: 'medium',
    category: 'explore',
    target: 2,
    xpPerProgress: 8,
    xpReward: 40,
    check: (s) => Math.min(s.memoriesCreated, 2),
  },

  // ── 困难任务 ──
  {
    id: 'daily_chat_50',
    title: '话痨模式',
    description: '累计聊 50 句话',
    icon: '💫',
    difficulty: 'hard',
    category: 'chat',
    target: 50,
    xpPerProgress: 2,
    xpReward: 100,
    check: (s) => Math.min(s.messagesToday, 50),
  },
  {
    id: 'daily_all_news',
    title: '新闻全览',
    description: '看完今日全部新闻推送',
    icon: '📡',
    difficulty: 'hard',
    category: 'news',
    target: 1,
    xpPerProgress: 20,
    xpReward: 80,
    check: (s) => Math.min(s.newsDigestsViewed, 1),
  },
  {
    id: 'daily_explorer',
    title: '探索达人',
    description: '完成 3 种不同类型的任务',
    icon: '🌟',
    difficulty: 'hard',
    category: 'explore',
    target: 3,
    xpPerProgress: 15,
    xpReward: 100,
    check: (s) => {
      let count = 0
      if (s.messagesToday >= 5) {count++}
      if (s.toolCallsToday >= 1) {count++}
      if (s.newsReadToday >= 1) {count++}
      if (s.chatsWithTeam >= 1) {count++}
      if (s.tasksCompleted >= 1) {count++}
      return Math.min(count, 3)
    },
  },
]

// ═══════════════════════════════════════════════════════════
// 每日任务管理器
// ═══════════════════════════════════════════════════════════

const QUESTS_PER_DAY = 5  // 每天随机抽 5 个

class QuestManager {
  private _state: DailyQuestState = this._createEmptyState()
  private readonly statePath: string
  private _statsListeners: Array<(state: DailyQuestState) => void> = []

  constructor() {
    this.statePath = this._getStatePath()
    this._loadState()
  }

  private _getStatePath(): string {
    try {
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'lumina-quests.json')
      }
    } catch { /* app 未就绪 */ }
    // ⚠️ 原来这里退回 process.cwd()，也就是**项目根目录** ——
    // 于是开发模式下 `lumina-quests.json` 会落进仓库里（发布后污染 Git 工作区）。
    // 退回系统临时目录：宁可状态不持久，也不能把文件写进用户的代码仓库。
    return path.join(os.tmpdir(), 'lumina-quests.json')
  }

  private _createEmptyState(): DailyQuestState {
    return {
      date: '',
      quests: [],
      completedCount: 0,
      allCompleted: false,
      streakBonus: 0,
    }
  }

  /** 检查日期是否改变，刷新每日任务 */
  private _checkDailyReset(): boolean {
    const today = new Date().toISOString().slice(0, 10)
    if (this._state.date !== today) {
      // 保存上一日的完成数到 streak
      const yesterdayCompleted = this._state.completedCount
      this._state = this._createEmptyState()
      this._state.date = today
      this._state.quests = this._generateDailyQuests()
      // 如果昨天完成了至少 3 个任务，累积 streakBonus
      if (yesterdayCompleted >= 3) {
        this._state.streakBonus = Math.min((this._state.streakBonus || 0) + 1, 30)
      }
      this._saveState()
      return true
    }
    return false
  }

  /** 每天随机选 QUESTS_PER_DAY 个任务 */
  private _generateDailyQuests(): QuestProgress[] {
    const shuffled = [...ALL_QUESTS].sort(() => Math.random() - 0.5)
    // 确保每天至少有一个 easy + 一个 medium
    const easy = shuffled.filter(q => q.difficulty === 'easy')
    const medium = shuffled.filter(q => q.difficulty === 'medium')
    const hard = shuffled.filter(q => q.difficulty === 'hard')

    const selected = new Set<QuestDef>()
    // 必选：1 easy, 1 medium
    if (easy.length > 0) {selected.add(easy[0])}
    if (medium.length > 0) {selected.add(medium[0])}

    // 剩下随机补满
    const remaining = shuffled.filter(q => !selected.has(q))
    for (const q of remaining) {
      if (selected.size >= QUESTS_PER_DAY) {break}
      selected.add(q)
    }

    return Array.from(selected).map(q => ({
      questId: q.id,
      current: 0,
      target: q.target,
      completed: false,
      claimed: false,
    }))
  }

  /** 获取任务定义 */
  getQuestDef(questId: string): QuestDef | undefined {
    return ALL_QUESTS.find(q => q.id === questId)
  }

  /** 获取今日所有任务 */
  getDailyQuests(): DailyQuestState {
    this._checkDailyReset()
    return {
      ...this._state,
      quests: this._state.quests.map(qp => ({ ...qp })),
    }
  }

  /** 更新进度 */
  updateProgress(stats: Partial<QuestProgressStats>): { completed: QuestDef[]; xpGained: number } {
    const today = new Date().toISOString().slice(0, 10)
    if (this._state.date !== today) {
      this._checkDailyReset()
    }

    // 构建完整统计
    const fullStats: QuestProgressStats = {
      messagesToday: 0,
      toolCallsToday: 0,
      newsReadToday: 0,
      newsDigestsViewed: 0,
      chatsWithTeam: 0,
      memoriesCreated: 0,
      tasksCompleted: 0,
      loginStreak: 1,
      modesSwitched: 0,
      achievementsUnlocked: 0,
      searchUsed: 0,
      bookmarksAdded: 0,
      ...stats,
    }

    const completed: QuestDef[] = []
    let xpGained = 0

    for (const progress of this._state.quests) {
      if (progress.completed && progress.claimed) {continue}

      const def = this.getQuestDef(progress.questId)
      if (!def) {continue}

      const newProgress = def.check(fullStats)
      const oldProgress = progress.current
      progress.current = Math.max(progress.current, newProgress)

      // 如果这次更新有进展，发放进度 XP
      if (progress.current > oldProgress && !progress.completed) {
        const delta = progress.current - oldProgress
        xpGained += delta * def.xpPerProgress
        xpManager.addXp(delta * def.xpPerProgress, `任务「${def.title}」进度`)
      }

      // 检查是否达成
      if (progress.current >= def.target && !progress.completed) {
        progress.completed = true
        completed.push(def)
        xpGained += def.xpReward
        xpManager.addXp(def.xpReward, `完成任务「${def.title}」`)
      }
    }

    // 更新完成计数
    this._state.completedCount = this._state.quests.filter(q => q.completed).length
    this._state.allCompleted = this._state.quests.every(q => q.completed)

    // 发送事件
    globalEventBus.emit(BusEvents.QUEST_UPDATED, {
      quests: this._state.quests,
      completedCount: this._state.completedCount,
      allCompleted: this._state.allCompleted,
    })

    this._saveState()
    this._statsListeners.forEach(l => l(this._state))

    return { completed, xpGained }
  }

  /** 领取任务奖励（用于需要手动点击领取的场景） */
  claimReward(questId: string): boolean {
    const progress = this._state.quests.find(q => q.questId === questId)
    if (!progress || !progress.completed || progress.claimed) {return false}

    const def = this.getQuestDef(questId)
    if (!def) {return false}

    progress.claimed = true
    xpManager.addXp(def.xpReward, `领取任务「${def.title}」奖励`)
    this._saveState()
    return true
  }

  /** 领取连续签到 bonus */
  claimStreakBonus(): number {
    if (this._state.streakBonus <= 0) {return 0}
    const bonus = this._state.streakBonus * 10
    xpManager.addXp(bonus, '连续签到奖励')
    this._state.streakBonus = 0
    this._saveState()
    return bonus
  }

  /** 注册监听 */
  onUpdate(cb: (state: DailyQuestState) => void): () => void {
    this._statsListeners.push(cb)
    return () => {
      this._statsListeners = this._statsListeners.filter(l => l !== cb)
    }
  }

  // ── 持久化 ──

  private _loadState(): void {
    if (!fs.existsSync(this.statePath)) {
      this._checkDailyReset()
      return
    }
    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8')
      this._state = JSON.parse(raw)
    } catch (e) {
      // 🔧 修复：原 catch 走 _checkDailyReset()，而它内部会
      // `this._state = this._createEmptyState()`——
      // 也就是把「文件损坏」当成「新的一天」，
      // 用户的连续签到(streak)和当日任务进度直接归零，且无提示。
      //
      // 现在：备份原文，并**不**重置状态。
      // 积分只是锦上添花，损坏后保留现场比误清零更有价值；
      // 真要恢复交给设置页的「修复游戏化数据」入口。
      const backup = `${this.statePath}.corrupted`
      try {
        if (!fs.existsSync(backup)) {fs.copyFileSync(this.statePath, backup)}
        console.error(
          `[QuestManager] 游戏化状态文件已损坏，原文备份至 ${backup}。` +
          '已保留现场、未执行每日重置（连签记录未清零）。'
        )
      } catch { /* 备份失败也不清零 */ }
      this._state = this._createEmptyState()   // 内存里先用空状态兜底，避免后续访问崩
    }
  }

  private _saveState(): void {
    try {
      const dir = path.dirname(this.statePath)
      if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true })}
      fs.writeFileSync(this.statePath, JSON.stringify(this._state, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[QuestManager] 保存失败:', e)
    }
  }
}

// 全局单例
export const questManager = new QuestManager()
