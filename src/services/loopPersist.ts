// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// services/loopPersist.ts — Loop 跨 Session 持久化 & 通用工具
//
// 持久化策略（Phase 4 最终版）：
//   1. Electron IPC（优先）— 通过 loop:data:read / loop:data:write
//      将数据写入 userData/lumina-loop-data.json，重启后自动恢复。
//   2. localStorage（降级）— IPC 不可用时自动降级，满足基本跨 Session 需求。
// ============================================================

import type { LoopTask } from './loopTypes'

export const LOOP_STORAGE_KEY = 'lumina_loop_state_v1'

/** 持久化后端接口 */
export interface LoopPersistenceBackend {
  load: () => Promise<LoopTask[]>
  save: (tasks: LoopTask[]) => Promise<void>
}

/** localStorage 后端（降级方案，可跨重启存活） */
export const localStorageBackend: LoopPersistenceBackend = {
  async load() {
    try {
      const raw = localStorage.getItem(LOOP_STORAGE_KEY)
      if (!raw) {return []}
      const data = JSON.parse(raw)
      return Array.isArray(data) ? (data as LoopTask[]) : []
    } catch {
      return []
    }
  },
  async save(tasks) {
    try {
      localStorage.setItem(LOOP_STORAGE_KEY, JSON.stringify(tasks))
    } catch (e) {
      // 🔧 原为静默 catch（注释也承认「静默」）。
      // 容量超限时用户的 Loop 任务**全部丢失**且毫无察觉——
      // 表现为「我建的循环任务怎么都没了」，且无法排查。
      // 现在至少留下 error 级线索（诊断面板可见）。
      console.error(
        '[loopPersist] ⚠️ Loop 任务保存失败（localStorage 容量超限？），' +
        '本次变更已丢失。共 ' + (Array.isArray(tasks) ? tasks.length : 0) + ' 条任务未能保存。',
        e,
      )
    }
  },
}

// ═══════════════════════════════════════════════════════
// Electron IPC 磁盘持久化（Phase 4: 专用 IPC handler）
// 数据存储在 userData/lumina-loop-data.json，通过
// loop:data:read / loop:data:write IPC 通信。
// ═══════════════════════════════════════════════════════

const LOOP_DATA_KEY = 'lumina-loop-data'

export function createElectronLoopPersistence(): LoopPersistenceBackend {
  const api = (window as any).luminaAPI
  const hasIpc = typeof api?.loopDataRead === 'function' && typeof api?.loopDataWrite === 'function'

  if (!hasIpc) {
    console.warn('[LoopPersist] Electron IPC 不可用，降级到 localStorage')
    return localStorageBackend
  }

  return {
    async load() {
      try {
        const data = await api.loopDataRead()
        const arr = data?.[LOOP_DATA_KEY]
        return Array.isArray(arr) ? (arr as LoopTask[]) : []
      } catch (e: any) {
        console.warn('[LoopPersist] Electron 读取失败，降级:', e?.message)
        return localStorageBackend.load()
      }
    },
    async save(tasks) {
      try {
        await api.loopDataWrite({ [LOOP_DATA_KEY]: tasks })
      } catch (e: any) {
        console.warn('[LoopPersist] Electron 写入失败:', e?.message)
        // 降级写 localStorage
        await localStorageBackend.save(tasks)
      }
    },
  }
}

// ═══════════════════════════════════════════════════════
// 通用工具
// ═══════════════════════════════════════════════════════

/** 生成唯一 ID */
export function genId(prefix = 'loop'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Cron 5 段表达式匹配（分 时 日 月 周）
 * 与 electron/tools/impl/cron.ts 保持同一套语义：
 *   星号通配、星号斜杠N 步进、逗号枚举、连字符区间、数字精确
 */
export function cronMatches(schedule: string, now: Date): boolean {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) {return false}
  const [cronMin, cronHour, cronDay, cronMonth, cronWeek] = parts
  const minute = now.getMinutes()
  const hour = now.getHours()
  const dayOfMonth = now.getDate()
  const month = now.getMonth() + 1 // JS 0-11 → 1-12
  const dayOfWeek = now.getDay()   // 0=周日

  const matchField = (cron: string, value: number): boolean => {
    const field = cron.trim()
    if (field === '*' || field === '?') {return true}
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10)
      return !Number.isNaN(step) && step > 0 && value % step === 0
    }
    if (field.includes(',')) {
      return field.split(',').some(s => parseInt(s, 10) === value)
    }
    if (field.includes('-')) {
      const [a, b] = field.split('-').map(s => parseInt(s, 10))
      return !Number.isNaN(a) && !Number.isNaN(b) && value >= a && value <= b
    }
    return parseInt(field, 10) === value
  }

  return (
    matchField(cronMin, minute) &&
    matchField(cronHour, hour) &&
    matchField(cronDay, dayOfMonth) &&
    matchField(cronMonth, month) &&
    matchField(cronWeek, dayOfWeek)
  )
}

/** 从字符串中鲁棒地抽取 JSON（容错 markdown 代码块 / 前后说明文字） */
export function extractJson(raw: string): unknown | null {
  if (!raw) {return null}
  // 去掉 ```json ... ``` 围栏
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : raw
  // 直接尝试
  try {
    return JSON.parse(candidate)
  } catch {
    /* continue */
  }
  // 截取第一个 { 到最后一个 }
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return null
    }
  }
  return null
}