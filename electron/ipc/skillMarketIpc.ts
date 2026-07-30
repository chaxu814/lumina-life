// ============================================================
// ipc/skillMarketIpc.ts — Skill 市场 IPC (v3.10)
//
// 暴露 SkillMarket 引擎给渲染进程：
//   - 浏览/搜索/安装/卸载 skill
//   - 导入导出 .lumskill 文件
//   - 评分与评论
//   - 社区仓库
// ============================================================

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { getSkillMarket } from '../skillMarket'
import type { SkillCategory } from '../skillMarket'

export function registerSkillMarketIpc(): void {
  const market = getSkillMarket()

  // ─── 已安装列表 ───────────────────────────────────
  ipcMain.handle('skill-market:installed', async () => {
    return market.getInstalled().map(s => ({
      id: s.meta.id,
      name: s.meta.name,
      version: s.meta.version,
      description: s.meta.description,
      author: s.meta.author,
      category: s.meta.category,
      tags: s.meta.tags,
      icon: s.meta.icon,
      rating: s.meta.rating,
      ratingCount: s.meta.ratingCount,
      downloads: s.meta.downloads,
      installedAt: s.installedAt,
      enabled: s.enabled,
    }))
  })

  // ─── 搜索社区 ─────────────────────────────────────
  ipcMain.handle('skill-market:search', async (_event, query: string, category?: SkillCategory) => {
    return market.searchCommunity(query, category)
  })

  // ─── 🔧 v2.17: 搜索魔搭社区 ───────────────────────
  ipcMain.handle('skill-market:modelscope-search', async (_event, query: string, category?: SkillCategory) => {
    return market.modelscopeSearch(query, category)
  })

  // ─── 社区 skill 详情 ──────────────────────────────
  ipcMain.handle('skill-market:detail', async (_event, skillId: string) => {
    return market.getCommunitySkill(skillId)
  })

  // ─── 从社区安装 ───────────────────────────────────
  ipcMain.handle('skill-market:install-community', async (_event, skillId: string) => {
    return market.installFromCommunity(skillId)
  })

  // ─── 从 URL 安装 ──────────────────────────────────
  ipcMain.handle('skill-market:install-url', async (_event, url: string) => {
    return market.installFromUrl(url)
  })

  // ─── 从本地 .lumskill 安装 ────────────────────────
  ipcMain.handle('skill-market:install-local', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { success: false, error: '无活动窗口' }

    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择技能包 (.lumskill)',
      filters: [{ name: 'Lumina 技能包', extensions: ['lumskill', 'zip'] }],
      properties: ['openFile'],
    })

    if (canceled || filePaths.length === 0) {
      return { success: false, error: '用户取消' }
    }

    return market.installFromZip(filePaths[0])
  })

  // ─── 导出 .lumskill ───────────────────────────────
  ipcMain.handle('skill-market:export', async (_event, skillId: string) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { success: false, error: '无活动窗口' }

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出技能包',
      defaultPath: `${skillId}.lumskill`,
      filters: [{ name: 'Lumina 技能包', extensions: ['lumskill'] }],
    })

    if (canceled || !filePath) {
      return { success: false, error: '用户取消' }
    }

    return market.exportToZip(skillId, filePath)
  })

  // ─── 卸载 ─────────────────────────────────────────
  ipcMain.handle('skill-market:uninstall', async (_event, skillId: string) => {
    return { success: market.uninstallSkill(skillId) }
  })

  // ─── 启用/禁用 ────────────────────────────────────
  ipcMain.handle('skill-market:toggle', async (_event, skillId: string, enabled: boolean) => {
    return { success: market.toggleSkill(skillId, enabled) }
  })

  // ─── 创建新 skill ─────────────────────────────────
  ipcMain.handle('skill-market:create', async (_event, data: {
    id: string; name: string; description: string;
    category: SkillCategory; systemPrompt: string; author?: string
  }) => {
    try {
      const skill = market.createSkill(data.id, data.name, data.description, data.category, data.systemPrompt, data.author)
      return { success: true, skill: { id: skill.meta.id, name: skill.meta.name } }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── 更新 system prompt ───────────────────────────
  ipcMain.handle('skill-market:update-prompt', async (_event, skillId: string, prompt: string) => {
    return { success: market.updateSkillSystemPrompt(skillId, prompt) }
  })

  // ─── 评分与评论 ───────────────────────────────────
  ipcMain.handle('skill-market:reviews', async (_event, skillId: string) => {
    return market.getReviews(skillId)
  })

  ipcMain.handle('skill-market:add-review', async (_event, skillId: string, author: string, rating: number, comment: string) => {
    try {
      const review = market.addReview(skillId, author, rating, comment)
      return { success: true, review }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── 聚合的 system prompt (用于 Agent 上下文) ─────
  ipcMain.handle('skill-market:aggregated-prompt', async () => {
    return market.getAggregatedSystemPrompt()
  })

  // ─── 社区仓库管理 ─────────────────────────────────
  ipcMain.handle('skill-market:add-repo', async (_event, url: string) => {
    market.addCommunityRepo(url)
    return { success: true }
  })
}
