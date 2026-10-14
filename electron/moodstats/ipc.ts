// ============================================================
// moodstats/ipc.ts — Mood × Productivity 看板的 IPC 频道
//
// 频道（全部 moodstats: 前缀，走 preload contextBridge 暴露）：
//   moodstats:report      → 聚合报告（分桶 + 趋势 + A/B 对照 + 诚实说明）
//   moodstats:snapshots   → 最近 N 条快照明细（默认 200）
//   moodstats:ab:get      → 当前 A/B 状态（分组 / 运行中 / 已退出）
//   moodstats:ab:setEnabled(on) → 开启/关闭实验（默认仅观测）
//   moodstats:ab:optOut   → 一键退出（停止干预，保留分组不重洗）
//   moodstats:ab:rejoin   → 重新加入
//   moodstats:export      → 导出 CSV + JSON，返回文件路径
//
// 【preload 白名单描述（由集成阶段加进 electron/preload.ts 的 luminaAPI）】
//   moodstatsReport: () => ipcRenderer.invoke('moodstats:report')
//   moodstatsSnapshots: (n?: number) => ipcRenderer.invoke('moodstats:snapshots', n)
//   moodstatsAbGet: () => ipcRenderer.invoke('moodstats:ab:get')
//   moodstatsAbSetEnabled: (on: boolean) => ipcRenderer.invoke('moodstats:ab:setEnabled', on)
//   moodstatsAbOptOut: () => ipcRenderer.invoke('moodstats:ab:optOut')
//   moodstatsAbRejoin: () => ipcRenderer.invoke('moodstats:ab:rejoin')
//   moodstatsExport: () => ipcRenderer.invoke('moodstats:export')
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import type { SnapshotStore } from './snapshotStore'
import type { AbGroup } from './abGroup'
import { buildReport } from './stats'
import { snapshotsToCsv, buildExportJson } from './exporter'

/**
 * 取已注册的 handle。未注册时返回 null —— 面板要能在「未接线」状态下
 * 显示「功能未启用」而不是白屏。
 */
function getHandle(): { store: SnapshotStore; ab: AbGroup } | null {
  try {
    // 惰性引用 register，避免本模块在未接线时也拉起整套存储
    const reg = require('./register')
    // registerMoodStats 返回 handle；这里用模块级引用取回（见 register.ts 的导出）
    return reg.__getMoodStatsHandle?.() ?? null
  } catch {
    return null
  }
}

export function registerMoodStatsIpc(): void {
  ipcMain.handle('moodstats:report', () => {
    try {
      const h = getHandle()
      if (!h) {return { ok: false, error: 'moodstats 未注册（采集钩子尚未接线）' }}
      const snaps = h.store.since(0)
      return { ok: true, report: buildReport(snaps), degraded: h.store.degraded }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('moodstats:snapshots', (_e, n?: unknown) => {
    try {
      const h = getHandle()
      if (!h) {return { ok: false, error: 'moodstats 未注册' }}
      const limit = typeof n === 'number' && n > 0 ? Math.min(n, 5000) : 200
      return { ok: true, snapshots: h.store.recent(limit) }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('moodstats:ab:get', () => {
    try {
      const h = getHandle()
      if (!h) {return { ok: false, error: 'moodstats 未注册' }}
      return { ok: true, state: h.ab.snapshot(), currentGroup: h.ab.currentGroup() }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('moodstats:ab:setEnabled', (_e, on?: unknown) => {
    try {
      const h = getHandle()
      if (!h) {return { ok: false, error: 'moodstats 未注册' }}
      if (on === true) {h.ab.enableExperiment()} else {h.ab.disableExperiment()}
      return { ok: true, state: h.ab.snapshot(), currentGroup: h.ab.currentGroup() }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('moodstats:ab:optOut', () => {
    try {
      const h = getHandle()
      if (!h) {return { ok: false, error: 'moodstats 未注册' }}
      h.ab.optOut()
      return { ok: true, state: h.ab.snapshot(), currentGroup: h.ab.currentGroup() }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('moodstats:ab:rejoin', () => {
    try {
      const h = getHandle()
      if (!h) {return { ok: false, error: 'moodstats 未注册' }}
      h.ab.rejoin()
      return { ok: true, state: h.ab.snapshot(), currentGroup: h.ab.currentGroup() }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  ipcMain.handle('moodstats:export', () => {
    try {
      const h = getHandle()
      if (!h) {return { ok: false, error: 'moodstats 未注册' }}
      const fs = require('fs')
      const path = require('path')
      const os = require('os')
      const snaps = h.store.since(0)
      const report = buildReport(snaps)
      const dir = path.join(
        process.env.LUMINA_DATA_DIR || path.join(os.homedir(), '.lumina'),
        'moodstats-exports',
      )
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const csvPath = path.join(dir, `moodstats-${stamp}.csv`)
      const jsonPath = path.join(dir, `moodstats-${stamp}.json`)
      // CSV 写文件时再补 BOM —— snapshotsToCsv 已含 BOM 字符串
      fs.writeFileSync(csvPath, snapshotsToCsv(snaps), 'utf8')
      fs.writeFileSync(jsonPath, buildExportJson(snaps, report), 'utf8')
      // 广播给面板提示导出位置
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send('moodstats:exported', { csvPath, jsonPath })
        }
      }
      return { ok: true, csvPath, jsonPath, rows: snaps.length }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })
}
