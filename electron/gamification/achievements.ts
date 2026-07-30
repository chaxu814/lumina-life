// ============================================================
// gamification/achievements.ts — 成就系统 v1.0
//
// 追踪用户行为 → 触发成就解锁 → 发送事件给前端
// 灵感来源: SpringNote 的等级系统 + 游戏化设计
// ============================================================

import { globalEventBus, BusEvents } from '../eventBus'

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

export interface Achievement {
  id: string
  name: string
  description: string
  icon: string
  category: 'milestone' | 'social' | 'skill' | 'hidden' | 'fun'
  condition: (stats: UserStats) => boolean
  /** 解锁后是否显示庆祝动画 */
  showCelebration?: boolean
  /** 隐藏成就（条件不暴露给用户） */
  hidden?: boolean
}

export interface UserStats {
  /** 总对话次数 */
  totalChats: number
  /** 总对话轮数 */
  totalMessages: number
  /** 使用过的工具数 */
  toolsUsed: string[]
  /** 使用工具总次数 */
  totalToolCalls: number
  /** Agent 间亲密度总和 */
  totalAffinity: number
  /** 使用天数 */
  daysActive: number
  /** 连续使用天数 */
  streakDays: number
  /** 创建的记忆数 */
  memoriesSaved: number
  /** 完成的任务数 */
  tasksCompleted: number
  /** 人格切换次数 */
  modeSwitches: number
  /** 时光胶囊数量 */
  timeCapsulesBuried: number
  /** 已解锁成就 ID 列表 */
  unlockedAchievements: string[]
}

// ═══════════════════════════════════════════════════════════
// 成就定义
// ═══════════════════════════════════════════════════════════

export const ACHIEVEMENTS: Achievement[] = [
  // ── 里程碑 ──
  {
    id: 'first_chat',
    name: '初次见面',
    description: '和 Lumina 完成第一次对话',
    icon: '🤝',
    category: 'milestone',
    condition: (s) => s.totalMessages >= 1,
  },
  {
    id: 'chat_100',
    name: '畅聊达人',
    description: '累计 100 条对话消息',
    icon: '💬',
    category: 'milestone',
    condition: (s) => s.totalMessages >= 100,
  },
  {
    id: 'chat_1000',
    name: '话痨模式',
    description: '累计 1000 条对话消息',
    icon: '🗣️',
    category: 'milestone',
    condition: (s) => s.totalMessages >= 1000,
  },
  {
    id: 'week_active',
    name: '一周伙伴',
    description: '连续使用 Lumina 7 天',
    icon: '📅',
    category: 'milestone',
    condition: (s) => s.streakDays >= 7,
  },
  {
    id: 'month_active',
    name: '满月纪念',
    description: '连续使用 Lumina 30 天',
    icon: '🌕',
    category: 'milestone',
    condition: (s) => s.streakDays >= 30,
    showCelebration: true,
  },
  {
    id: 'first_tool',
    name: '初试身手',
    description: '第一次使用 Lumina 的工具',
    icon: '🔧',
    category: 'skill',
    condition: (s) => s.toolsUsed.length >= 1,
  },
  {
    id: 'tool_master_10',
    name: '工具达人',
    description: '使用过 10 种不同的工具',
    icon: '🛠️',
    category: 'skill',
    condition: (s) => s.toolsUsed.length >= 10,
  },
  {
    id: 'tool_master_all',
    name: '全能主人',
    description: '使用过 20 种不同的工具',
    icon: '🏆',
    category: 'skill',
    condition: (s) => s.toolsUsed.length >= 20,
    showCelebration: true,
  },
  {
    id: 'first_memory',
    name: '铭记于心',
    description: 'Lumina 第一次记住关于你的事',
    icon: '💾',
    category: 'milestone',
    condition: (s) => s.memoriesSaved >= 1,
  },
  {
    id: 'memory_hoarder',
    name: '记忆收藏家',
    description: '保存了 50 条记忆',
    icon: '🧠',
    category: 'milestone',
    condition: (s) => s.memoriesSaved >= 50,
  },

  // ── 社交 ──
  {
    id: 'team_love',
    name: '团队默契',
    description: '团队亲密度总和达到 150',
    icon: '💕',
    category: 'social',
    condition: (s) => s.totalAffinity >= 150,
  },
  {
    id: 'social_butterfly',
    name: '社交达人',
    description: '观看过 10 次 Agent 团队群聊',
    icon: '🦋',
    category: 'social',
    condition: (s) => s.totalChats >= 10, // proxy
  },

  // ── 娱乐 ──
  {
    id: 'mode_hopper',
    name: '百变主人',
    description: '切换过 4 种不同的人格模式',
    icon: '🎭',
    category: 'fun',
    condition: (s) => s.modeSwitches >= 4,
  },
  {
    id: 'first_capsule',
    name: '时间旅人',
    description: '埋下第一颗时光胶囊',
    icon: '⏳',
    category: 'fun',
    condition: (s) => s.timeCapsulesBuried >= 1,
  },
  {
    id: 'task_warrior',
    name: '任务战士',
    description: '完成了 10 个定时任务',
    icon: '⚔️',
    category: 'skill',
    condition: (s) => s.tasksCompleted >= 10,
  },

  // ── 隐藏成就 ──
  {
    id: 'night_owl',
    name: '夜猫子',
    description: '凌晨 2-5 点还在和 Lumina 聊天',
    icon: '🦉',
    category: 'hidden',
    hidden: true,
    condition: () => {
      const h = new Date().getHours()
      return h >= 2 && h <= 5
    },
  },
]

// ═══════════════════════════════════════════════════════════
// 成就管理器
// ═══════════════════════════════════════════════════════════

class AchievementManager {
  private _stats: UserStats = {
    totalChats: 0,
    totalMessages: 0,
    toolsUsed: [],
    totalToolCalls: 0,
    totalAffinity: 0,
    daysActive: 1,
    streakDays: 1,
    memoriesSaved: 0,
    tasksCompleted: 0,
    modeSwitches: 0,
    timeCapsulesBuried: 0,
    unlockedAchievements: [],
  }

  private _listeners: Array<(achievement: Achievement) => void> = []
  private _statsListeners: Array<(stats: UserStats) => void> = []

  /** 获取当前统计 */
  getStats(): UserStats {
    return { ...this._stats }
  }

  /** 更新统计信息（触发成就检查） */
  updateStats(partial: Partial<UserStats>): Achievement[] {
    // 合并数组类型字段
    if (partial.toolsUsed) {
      const existing = new Set(this._stats.toolsUsed)
      partial.toolsUsed.forEach(t => existing.add(t))
      this._stats.toolsUsed = Array.from(existing)
      delete partial.toolsUsed
    }

    Object.assign(this._stats, partial)

    // 检查新成就
    const newAchievements = this.checkAchievements()
    this._statsListeners.forEach(l => l(this._stats))
    return newAchievements
  }

  /** 手动设置完整统计（从持久化恢复） */
  setStats(stats: UserStats): void {
    this._stats = stats
  }

  /** 检查是否有新成就解锁 */
  checkAchievements(): Achievement[] {
    const unlocked = new Set(this._stats.unlockedAchievements)
    const newlyUnlocked: Achievement[] = []

    for (const achievement of ACHIEVEMENTS) {
      if (unlocked.has(achievement.id)) continue
      if (achievement.condition(this._stats)) {
        unlocked.add(achievement.id)
        this._stats.unlockedAchievements.push(achievement.id)
        newlyUnlocked.push(achievement)

        // 发送成就解锁事件
        globalEventBus.emit(BusEvents.ACHIEVEMENT_UNLOCKED, achievement)

        // 通知监听器
        this._listeners.forEach(l => l(achievement))
      }
    }

    return newlyUnlocked
  }

  /** 注册成就解锁监听 */
  onAchievement(cb: (achievement: Achievement) => void): () => void {
    this._listeners.push(cb)
    return () => {
      this._listeners = this._listeners.filter(l => l !== cb)
    }
  }

  /** 注册统计更新监听 */
  onStatsUpdate(cb: (stats: UserStats) => void): () => void {
    this._statsListeners.push(cb)
    return () => {
      this._statsListeners = this._statsListeners.filter(l => l !== cb)
    }
  }
}

// 全局单例
export const achievementManager = new AchievementManager()
