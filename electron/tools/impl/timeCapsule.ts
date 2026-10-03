// ============================================================
// impl/timeCapsule.ts — 时光胶囊工具 v1.0
//
// 用户埋一颗胶囊 → 指定未来时间 → 到期自动弹出提醒
// 数据存储在 SQLite（复用 memory store 的数据库）
// ============================================================

import type { ToolDef, ToolResult } from '../types'
import { globalEventBus, BusEvents } from '../../eventBus'
import { xpManager, XP_RULES } from '../../gamification/levels'
import { achievementManager } from '../../gamification/achievements'

// ═══════════════════════════════════════════════════════════
// 内存存储（未来可改为 SQLite 持久化）
// ═══════════════════════════════════════════════════════════

interface TimeCapsule {
  id: string
  message: string
  /** 目标日期 YYYY-MM-DD */
  targetDate: string
  /** 埋胶囊时用户的 note / 对自己的话 */
  note: string
  /** 创建时间戳 */
  createdAt: number
  /** 是否已开启 */
  opened: boolean
  /** 关联的成就/状态快照 */
  snapshot?: {
    level: number
    achievementsCount: number
    totalMessages: number
  }
}

const capsules: TimeCapsule[] = []
let capsuleIdCounter = 1

// ═══════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════

export const timeCapsuleDef: ToolDef = {
  name: 'time_capsule',
  description: '埋一颗时光胶囊 —— 给未来的自己留一段话，到期 Lumina 会主动提醒你。可以指定天数（如"30天后"）或具体日期。',
  params: {
    action: {
      type: 'string',
      description: '操作类型: bury（埋胶囊）/ list（查看未开封的）/ open（打开指定胶囊）',
      required: true,
      enum: ['bury', 'list', 'open'],
    },
    message: {
      type: 'string',
      description: '胶囊内容（bury 时必填）：想对未来的自己说的话',
      required: false,
    },
    days: {
      type: 'number',
      description: '多少天后开启（与 targetDate 二选一）',
      required: false,
    },
    targetDate: {
      type: 'string',
      description: '目标日期 YYYY-MM-DD（与 days 二选一）',
      required: false,
    },
    id: {
      type: 'string',
      description: '胶囊 ID（open 操作时必填）',
      required: false,
    },
  },
  toolsets: ['agent', 'tasks_core'],
}

export async function timeCapsule(args: Record<string, any>): Promise<ToolResult> {
  const action = args.action as string

  switch (action) {
    case 'bury': {
      const message = args.message as string
      if (!message) {
        return { callId: '', ok: false, content: '', error: '请填写胶囊内容' }
      }

      // 计算目标日期
      let targetDate: string
      if (args.targetDate) {
        targetDate = args.targetDate
      } else if (args.days) {
        const d = new Date()
        d.setDate(d.getDate() + parseInt(args.days))
        targetDate = d.toISOString().slice(0, 10)
      } else {
        // 默认 30 天后
        const d = new Date()
        d.setDate(d.getDate() + 30)
        targetDate = d.toISOString().slice(0, 10)
      }

      const capsule: TimeCapsule = {
        id: `cap_${capsuleIdCounter++}`,
        message,
        targetDate,
        note: `埋于 ${new Date().toLocaleDateString('zh-CN')}，将于 ${targetDate} 开启`,
        createdAt: Date.now(),
        opened: false,
        snapshot: {
          level: 1,
          achievementsCount: 0,
          totalMessages: 0,
        },
      }

      capsules.push(capsule)

      // 更新成就统计
      achievementManager.updateStats({
        timeCapsulesBuried: achievementManager.getStats().timeCapsulesBuried + 1,
      })
      xpManager.addXp(20, '埋了一颗时光胶囊')

      // 发送事件
      globalEventBus.emit(BusEvents.TIME_CAPSULE_BURIED, capsule)

      return {
        callId: '',
        ok: true,
        content: `📮 时光胶囊已埋好！\n\n📝 内容：${message}\n📅 开启日期：${targetDate}\n\n到那天我会提醒你的 ✨`,
      }
    }

    case 'list': {
      const unopened = capsules.filter(c => !c.opened)
      if (unopened.length === 0) {
        return { callId: '', ok: true, content: '目前没有未开启的时光胶囊。要不要埋一个？⏳' }
      }

      const list = unopened.map(c =>
        `📮 #${c.id} — 将于 ${c.targetDate} 开启\n  "${c.message.slice(0, 50)}${c.message.length > 50 ? '...' : ''}"`
      ).join('\n\n')

      return { callId: '', ok: true, content: `你有 ${unopened.length} 颗未开启的时光胶囊：\n\n${list}` }
    }

    case 'open': {
      const id = args.id as string
      const capsule = capsules.find(c => c.id === id)
      if (!capsule) {
        return { callId: '', ok: false, content: '', error: `未找到胶囊: ${id}` }
      }

      capsule.opened = true

      return {
        callId: '',
        ok: true,
        content: `📮 时光胶囊开启！\n\n你说过：\n"${capsule.message}"\n\n${capsule.note}\n\n${capsule.createdAt ? `从 ${new Date(capsule.createdAt).toLocaleDateString('zh-CN')} 到现在，已经过去了 ${Math.floor((Date.now() - capsule.createdAt) / 86400000)} 天 🕰️` : ''}`,
      }
    }

    default:
      return { callId: '', ok: false, content: '', error: `未知操作: ${action}` }
  }
}

// ═══════════════════════════════════════════════════════════
// 检查到期的胶囊（由 cron 系统定时调用）
// ═══════════════════════════════════════════════════════════

export function checkExpiredCapsules(): TimeCapsule[] {
  const today = new Date().toISOString().slice(0, 10)
  const expired = capsules.filter(c => !c.opened && c.targetDate <= today)

  for (const cap of expired) {
    cap.opened = true
    globalEventBus.emit(BusEvents.TIME_CAPSULE_EXPIRED, cap)
  }

  return expired
}
