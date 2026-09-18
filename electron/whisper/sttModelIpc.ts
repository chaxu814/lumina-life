// ============================================================
// whisper/sttModelIpc.ts — 离线语音模型「就绪检测 + 一键下载」IPC
//
// 让用户在设置页就能：
//   1) 看到本地离线中文识别是否可用（依赖在不在、模型下没下好）；
//   2) 一键预下载多语种 whisper-base（约 290MB，走国内镜像，有进度）；
// 下载完成后桌宠全双工语音即可完全离线识别中文，不再依赖联网 Web Speech。
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_WHISPER_MODEL, sttCacheDir, configureTransformersEnv } from './sttModelConfig'

export interface OfflineStatus {
  depReady: boolean
  modelReady: boolean
  model: string
  cacheDir: string
  /** 模型目录已占用空间（MB，估算） */
  sizeMB: number
}

/** 判断 @xenova/transformers 依赖是否可加载（打包后也在 node_modules 里） */
export function isTransformersPresent(): boolean {
  try {
    require.resolve('@xenova/transformers')
    return true
  } catch {
    return false
  }
}

/** 模型相对缓存目录（transformers.js 按 <cacheDir>/<org>/<model> 存放） */
function modelDir(): string {
  const [org, name] = DEFAULT_WHISPER_MODEL.split('/')
  return path.join(sttCacheDir(), org, name)
}

/** 目录下递归统计大小（MB） */
function dirSizeMB(dir: string): number {
  let total = 0
  try {
    const stack = [dir]
    while (stack.length) {
      const cur = stack.pop()!
      for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, ent.name)
        if (ent.isDirectory()) stack.push(full)
        else { try { total += fs.statSync(full).size } catch { /* ignore */ } }
      }
    }
  } catch { /* ignore */ }
  return Math.round(total / 1024 / 1024)
}

/** 判断模型是否已下载齐全（config + 至少一个 onnx） */
export function isModelReady(): boolean {
  try {
    const dir = modelDir()
    if (!fs.existsSync(path.join(dir, 'config.json'))) return false
    let hasOnnx = false
    const walk = (d: string, depth: number): void => {
      if (hasOnnx || depth > 3) return
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name)
        if (ent.isDirectory()) walk(full, depth + 1)
        else if (ent.name.endsWith('.onnx')) { hasOnnx = true; return }
      }
    }
    walk(dir, 0)
    return hasOnnx
  } catch {
    return false
  }
}

export function getOfflineStatus(): OfflineStatus {
  const depReady = isTransformersPresent()
  const modelReady = depReady && isModelReady()
  return {
    depReady,
    modelReady,
    model: DEFAULT_WHISPER_MODEL,
    cacheDir: modelDir(),
    sizeMB: dirSizeMB(modelDir()),
  }
}

let downloading = false

export function registerSttModelIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('stt:offline-status', () => {
    try { return { ok: true, ...getOfflineStatus() } }
    catch (e: any) { return { ok: false, error: e?.message } }
  })

  ipcMain.handle('stt:download-model', async () => {
    if (downloading) return { ok: false, error: 'already-downloading' }
    if (!isTransformersPresent()) {
      return { ok: false, error: '缺少 @xenova/transformers 依赖（打包版本应已内置）' }
    }
    if (isModelReady()) return { ok: true, alreadyReady: true, ...getOfflineStatus() }

    downloading = true
    const send = (payload: any) => { try { getWin()?.webContents.send('stt:download-progress', payload) } catch { /* ignore */ } }
    try {
      const { pipeline } = await import('@xenova/transformers' as any)
      configureTransformersEnv()
      send({ status: 'downloading', progress: 0, file: '开始下载离线中文语音模型…' })
      await pipeline('automatic-speech-recognition', DEFAULT_WHISPER_MODEL, {
        quantized: true,
        progress_callback: (p: any) => {
          try {
            send({
              status: p.status || 'downloading',
              progress: typeof p.progress === 'number' ? p.progress : undefined,
              file: p.file || p.name,
              loaded: p.loaded,
              total: p.total,
            })
          } catch { /* ignore */ }
        },
      })
      send({ status: 'done', progress: 100 })
      return { ok: true, ...getOfflineStatus() }
    } catch (e: any) {
      send({ status: 'error', message: String(e?.message || e) })
      return { ok: false, error: String(e?.message || e) }
    } finally {
      downloading = false
    }
  })
}
