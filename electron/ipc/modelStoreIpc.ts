// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/modelStoreIpc.ts — 🛒 Live2D 配件商城（本地/离线模式）IPC (v0.2 创新提案1)
//
// 已有 lifeServices 提供 pet:models:list/select/remove/import（选文件导入）。
// 本模块只补两件事：
//   1) model-store:import-folder —— 弹「选目录」对话框（而非选文件），
//      自动在目录里找 *.model3.json，导入前先用 modelValidator 做
//      schema 校验 + 恶意脚本(.js/.html)扫描，block 级一律拒收；
//   2) model-store:cloud-status —— 报告云端商城是否配置（MVP 恒为离线/本地模式）。
//
// 列表/切换/卸载直接复用已有 pet:models:* / pet:set-model 通道，前端经 preload 调用。
// ============================================================

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { app } from 'electron'
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'
import { ModelLibrary } from '../pet/modelLibrary'
import { importLive2dModel, findLive2dEntriesOnDisk, type ModelImporterFs } from '../pet/modelImporter'
import { validateModelPackage } from '../pet/modelValidator'

/** 已配置云端商城地址时填这里；MVP 留空 → 前端显示「本地/离线模式」 */
const CLOUD_STORE_URL = ''

function modelsRoot(): string {
  return path.join(app.getPath('userData'), 'pet-models')
}
function libraryJsonPath(): string {
  return path.join(app.getPath('userData'), 'pet-model-library.json')
}

const nodeFs: ModelImporterFs = {
  readText: async (p) => fsp.readFile(p, 'utf8'),
  fileExists: async (p) => { try { await fsp.access(p); return true } catch { return false } },
  ensureDir: async (p) => { await fsp.mkdir(p, { recursive: true }) },
  copyFile: async (from, to) => {
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.copyFile(from, to)
  },
}

function readLibrary(): ModelLibrary {
  try {
    const raw = JSON.parse(require('node:fs').readFileSync(libraryJsonPath(), 'utf8'))
    return ModelLibrary.deserialize(raw)
  } catch {
    return new ModelLibrary()
  }
}
function writeLibrary(lib: ModelLibrary): void {
  require('node:fs').mkdirSync(path.dirname(libraryJsonPath()), { recursive: true })
  require('node:fs').writeFileSync(libraryJsonPath(), JSON.stringify(lib.serialize(), null, 2), 'utf8')
}

let registered = false

export function registerModelStoreIpc(): void {
  if (registered) {return}
  registered = true

  // 云端商城是否配置（MVP：始终离线/本地模式）
  ipcMain.handle('model-store:cloud-status', () => {
    return {
      ok: true,
      configured: !!CLOUD_STORE_URL,
      url: CLOUD_STORE_URL || null,
      mode: CLOUD_STORE_URL ? 'online' : 'offline',
      note: CLOUD_STORE_URL ? '' : '云端商城未配置，当前为本地/离线模式：仅浏览和导入本机模型',
    }
  })

  // 选目录导入 Live2D 模型（导入前跑安全校验）
  ipcMain.handle('model-store:import-folder', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined
      const dlg = await dialog.showOpenDialog(parent as BrowserWindow, {
        title: '选择 Live2D 模型文件夹（内含 model3.json）',
        properties: ['openDirectory'],
      })
      if (dlg.canceled || !dlg.filePaths[0]) {
        return { ok: false, canceled: true }
      }
      const srcDir = dlg.filePaths[0]

      // 1) 自动找入口
      const entries = await findLive2dEntriesOnDisk(srcDir)
      if (!entries.length) {
        return { ok: false, error: '所选文件夹内未找到 *.model3.json（仅支持 Cubism 3/4/5）' }
      }
      const entryRel = entries[0]

      // 2) 导入前安全校验（schema + moc3 存在 + 恶意脚本扫描）
      const check = await validateModelPackage(srcDir, entryRel)
      if (check.level === 'block') {
        return {
          ok: false,
          blocked: true,
          error: '模型未通过安全校验，已拒绝导入',
          issues: check.issues.map((i) => ({ level: i.level, code: i.code, message: i.message, file: i.file })),
        }
      }

      // 3) 复制进用户模型库
      const suggestedName = path.basename(srcDir)
      const plan = await importLive2dModel(srcDir, entryRel, modelsRoot(), suggestedName, nodeFs)
      const relEntry = `${plan.modelName}/${plan.entryRel}`.replace(/\\/g, '/')

      // 4) 注册进库
      const lib = readLibrary()
      const reg = lib.register({ name: suggestedName, entryRel: relEntry, kind: 'live2d' }, Date.now())
      if (!reg.ok) {
        return { ok: false, error: reg.error || '模型注册失败' }
      }
      writeLibrary(lib)

      return {
        ok: true,
        model: { id: reg.id, name: suggestedName, entryRel: relEntry, kind: 'live2d' },
        fileCount: plan.fileCount,
        warnings: check.issues.filter((i) => i.level === 'warn')
          .map((i) => ({ code: i.code, message: i.message, file: i.file })),
      }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  console.log('[modelStore] 🛒 IPC 已注册 (model-store:*)')
}
