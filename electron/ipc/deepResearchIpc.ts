// ============================================================
// ipc/deepResearchIpc.ts — Deep Research IPC (v3.11)
// ============================================================

import { ipcMain } from 'electron'
import { getDeepResearch } from '../deepResearch'

export function registerDeepResearchIpc(): void {
  const dr = getDeepResearch()

  ipcMain.handle('deep-research:start', async (_e, question: string) => {
    try {
      const report = await dr.research(question)
      const markdown = dr.toMarkdown(report)
      return { success: true, report, markdown }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
