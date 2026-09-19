// ============================================================
// ipc/loopIpc.ts — Loop 任务磁盘持久化 IPC
//
// 让 loopPersist.ts 的 localStorage 后端可替换为 Electron fs，
// 数据存储在 userData/lumina-loop-data.json。
// ============================================================

import { ipcMain, app } from 'electron'
import fs from 'fs'
import { join } from 'path'

const DATA_FILE = join(app.getPath('userData'), 'lumina-loop-data.json')

function readData(): Record<string, any> {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'))
    }
  } catch (e: any) {
    console.warn('[LoopIpc] 读取失败:', e?.message)
  }
  return {}
}

function writeData(data: Record<string, any>): void {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8')
  } catch (e: any) {
    console.warn('[LoopIpc] 写入失败:', e?.message)
  }
}

let registered = false

export function registerLoopIpc(): void {
  if (registered) {return}
  registered = true

  ipcMain.handle('loop:data:read', () => readData())
  ipcMain.handle('loop:data:write', (_event, data: Record<string, any>) => {
    writeData(data)
    return { ok: true }
  })
}
