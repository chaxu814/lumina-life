// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// billing/billingIpc.ts — 预算守护的 IPC 层（budget:* 前缀）
//
// 遵循项目现有模式：
//   - ipcMain.handle('budget:xxx', ...) 注册（参考 diagnosticsIpc / memoryIpc）
//   - preload 里 contextBridge 白名单式暴露（参考 petPreload.ts）
//   - 设置持久化复用 lumina-config.json（config:set 同一文件，budget 命名空间）
// ============================================================

import { ipcMain } from 'electron'
import * as fs from 'fs'
import { stateFilePath } from '../core/pathsFallback'
import { getUsageLedger } from './usageLedger'
import { getBudgetGuardian, type BudgetConfig } from './budgetGuardian'
import { listAllPrices, setPriceOverrides, type PriceEntry } from './priceTable'

const CONFIG_FILE = stateFilePath('lumina-config.json')
const BUDGET_KEY = 'budget'

// ═══════════════════════════════════════════════════════════
// 设置读写（复用现有 lumina-config.json，budget 命名空间）
// ═══════════════════════════════════════════════════════════

function loadBudgetSettings(): { config: Partial<BudgetConfig>; priceOverrides: PriceEntry[] } {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {return { config: {}, priceOverrides: [] }}
    const full = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    const budget = (full && typeof full === 'object' && full[BUDGET_KEY]) || {}
    return {
      config: (budget.config || {}) as Partial<BudgetConfig>,
      priceOverrides: (budget.priceOverrides || []) as PriceEntry[],
    }
  } catch {
    return { config: {}, priceOverrides: [] }
  }
}

function saveBudgetSettings(patch: { config?: Partial<BudgetConfig>; priceOverrides?: PriceEntry[] }): void {
  let full: Record<string, any> = {}
  try {
    if (fs.existsSync(CONFIG_FILE)) {full = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))}
  } catch {
    full = {} // 损坏时重建（与 memoryIpc 的保守策略一致：这里只动 budget 子键）
  }
  const cur = (full[BUDGET_KEY] && typeof full[BUDGET_KEY] === 'object') ? { ...full[BUDGET_KEY] } : {}
  if (patch.config) {cur.config = { ...(cur.config || {}), ...patch.config }}
  if (patch.priceOverrides) {cur.priceOverrides = patch.priceOverrides}
  full[BUDGET_KEY] = cur
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(full, null, 2), 'utf-8')
}

/** 启动时调用：把磁盘上的预算配置喂进单例，并尝试挂真实 SQLite 句柄 */
export function loadBudgetSettingsIntoSingletons(): void {
  // 优先接 SQLite（lumina-memory.db，与 RelationshipEventStore 同库）；
  // better-sqlite3 不可用时静默退回内存账——账本缺失不阻塞启动。
  try {
    const { getMemoryStore } = require('../memory/memoryStore')
    const db = getMemoryStore().getDb()
    if (db) {
      const { initUsageLedger } = require('./usageLedger')
      initUsageLedger(db)
    }
  } catch (e: any) {
    console.warn('[Billing] SQLite 账本未挂载，退化为内存账:', e?.message)
  }
  const { config, priceOverrides } = loadBudgetSettings()
  setPriceOverrides(priceOverrides)
  getBudgetGuardian().setConfig(config)
}

// ═══════════════════════════════════════════════════════════
// summary 组装
// ═══════════════════════════════════════════════════════════

function buildSummary(): Record<string, any> {
  const ledger = getUsageLedger()
  const guardian = getBudgetGuardian()
  const todayAgg = ledger.today()
  const snap = guardian.evaluate(todayAgg.cost)
  return {
    level: snap.level,
    costYuan: snap.costYuan,
    budgetYuan: snap.budgetYuan,
    ratio: snap.ratio,
    remainingYuan: snap.remainingYuan,
    dateKey: snap.dateKey,
    actions: snap.actions,
    tokens: {
      prompt: todayAgg.promptTokens,
      completion: todayAgg.completionTokens,
      total: todayAgg.totalTokens,
      calls: todayAgg.calls,
      estimatedCalls: todayAgg.estimatedCalls, // UI 要据此标注「估算」
    },
    byPurpose: ledger.todayByPurpose(),
    byProvider: ledger.todayByProvider(),
    byAgent: ledger.todayByAgent(),
    config: guardian.getConfig(),
  }
}

// ═══════════════════════════════════════════════════════════
// IPC 注册
// ═══════════════════════════════════════════════════════════

export function registerBillingIpc(): void {
  // 启动时先把磁盘配置装进单例
  loadBudgetSettingsIntoSingletons()

  ipcMain.handle('budget:summary', () => {
    try {return { ok: true, summary: buildSummary() }}
    catch (e: any) {return { ok: false, error: e?.message || String(e) }}
  })

  ipcMain.handle('budget:audit', () => {
    try {return { ok: true, audit: getBudgetGuardian().getAuditLog() }}
    catch (e: any) {return { ok: false, error: e?.message || String(e) }}
  })

  ipcMain.handle('budget:setConfig', (_e, patch: Partial<BudgetConfig>) => {
    try {
      getBudgetGuardian().setConfig(patch || {})
      saveBudgetSettings({ config: patch || {} })
      return { ok: true, summary: buildSummary() }
    } catch (e: any) {return { ok: false, error: e?.message || String(e) }}
  })

  ipcMain.handle('budget:override', (_e, reason: string) => {
    try {
      const rec = getBudgetGuardian().overrideLatest(reason)
      if (!rec) {return { ok: false, error: '当前没有需要放行的收紧记录' }}
      return { ok: true, record: rec, summary: buildSummary() }
    } catch (e: any) {return { ok: false, error: e?.message || String(e) }}
  })

  ipcMain.handle('budget:priceTable', () => {
    try {
      return { ok: true, prices: listAllPrices(), overrides: loadBudgetSettings().priceOverrides }
    } catch (e: any) {return { ok: false, error: e?.message || String(e) }}
  })

  ipcMain.handle('budget:setPriceOverrides', (_e, entries: PriceEntry[]) => {
    try {
      setPriceOverrides(entries || [])
      saveBudgetSettings({ priceOverrides: entries || [] })
      return { ok: true }
    } catch (e: any) {return { ok: false, error: e?.message || String(e) }}
  })
}
