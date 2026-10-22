// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// rituals/scheduler.ts — 分钟级仪式调度器（纯逻辑，时钟可注入）
//
// 不挂 cron.ts / orchestrator：完全自包含，30s 轮询一次，
// 命中 HH:MM 即触发，同一「日期+分钟」只触发一次。
// 开关/时间每次 tick 现场读取——用户改时间或开关热生效，无需重启。
// ============================================================

import type { RitualKind } from './types'

export interface SchedulerHooks {
  /** 睡前开关（生产：feature flag rituals.nightReview） */
  isNightEnabled: () => boolean
  /** 晨间开关（生产：feature flag rituals.morningBriefing） */
  isMorningEnabled: () => boolean
  /** 睡前时间 "HH:MM"（每次现场读，支持热改） */
  nightTime: () => string
  /** 晨间时间 "HH:MM" */
  morningTime: () => string
  /** 触发回调 */
  fire: (kind: RitualKind) => void
}

/** 解析 "HH:MM" → {h, m}；非法返回 null */
export function parseHHMM(v: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) {return null}
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 23 || mm > 59) {return null}
  return { h, m: mm }
}

function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 调度器：tick(nowMs) 返回本次实际触发的仪式。
 * @param hooks  每次 tick 现场读取配置 → 热改时间/开关立即生效
 */
export class RitualScheduler {
  private firedKeys = new Set<string>()

  constructor(private readonly hooks: SchedulerHooks) {}

  /**
   * @param nowMs 当前时间戳（测试可注入任意时刻）
   * @returns 本次 tick 新触发的仪式列表（去重后）
   */
  tick(nowMs: number): RitualKind[] {
    const now = new Date(nowMs)
    const fired: RitualKind[] = []

    const check = (kind: RitualKind, enabled: boolean, time: string): void => {
      if (!enabled) {return}
      const target = parseHHMM(time)
      if (!target) {return}
      if (now.getHours() !== target.h || now.getMinutes() !== target.m) {return}
      const key = `${kind}:${dateKeyOf(now)}:${target.h}:${target.m}`
      if (this.firedKeys.has(key)) {return}
      this.firedKeys.add(key)
      fired.push(kind)
    }

    check('night', this.hooks.isNightEnabled(), this.hooks.nightTime())
    check('morning', this.hooks.isMorningEnabled(), this.hooks.morningTime())

    for (const kind of fired) {
      try {this.hooks.fire(kind)} catch (e) {console.error('[Rituals] 触发失败:', e)}
    }
    return fired
  }

  /** 忘了哪些分钟已触发（测试辅助） */
  resetDedup(): void {
    this.firedKeys.clear()
  }
}
