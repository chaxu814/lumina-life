// ============================================================
// ipc/gitAgentIpc.ts — Git Agent IPC (v3.11)
// ============================================================

import { ipcMain } from 'electron'
import { getGitAgent } from '../gitAgent'

export function registerGitAgentIpc(): void {
  // ─── 状态查询 ─────────────────────────────────────
  ipcMain.handle('git:status', async () => {
    try {
      return await getGitAgent().getStatus()
    } catch (err: any) {
      return { error: err.message }
    }
  })

  ipcMain.handle('git:diff', async (_e, staged?: boolean) => {
    try {
      return await getGitAgent().getDiff(staged)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  })

  ipcMain.handle('git:log', async (_e, count?: number) => {
    try {
      return await getGitAgent().getLog(count)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  })

  // ─── 一键提交流程 ─────────────────────────────────
  ipcMain.handle('git:auto-commit', async (_e, files?: string[]) => {
    try {
      return await getGitAgent().autoCommit(files)
    } catch (err: any) {
      return { success: false, error: err.message, filesChanged: 0, insertions: 0, deletions: 0 }
    }
  })

  ipcMain.handle('git:auto-commit-push', async (_e, files?: string[]) => {
    try {
      return await getGitAgent().autoCommitAndPush(files)
    } catch (err: any) {
      return { success: false, error: err.message, filesChanged: 0, insertions: 0, deletions: 0, pushed: false }
    }
  })

  // ─── 分析 ─────────────────────────────────────────
  ipcMain.handle('git:analyze-diff', async () => {
    try {
      const diff = await getGitAgent().getDiff()
      return await getGitAgent().analyzeDiff(diff)
    } catch (err: any) {
      return { error: err.message }
    }
  })

  ipcMain.handle('git:generate-message', async () => {
    try {
      const diff = await getGitAgent().getDiff(true)
      return await getGitAgent().generateCommitMessage(diff)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  })

  // ─── 手动操作 ─────────────────────────────────────
  ipcMain.handle('git:commit', async (_e, message: string) => {
    try {
      return await getGitAgent().commit(message)
    } catch (err: any) {
      return { success: false, error: err.message, filesChanged: 0, insertions: 0, deletions: 0 }
    }
  })

  ipcMain.handle('git:push', async () => {
    try {
      return { success: await getGitAgent().push() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('git:pull', async () => {
    try {
      return { success: await getGitAgent().pull() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
