// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/bridgeIpc.ts — Bridge / Window / Dialog / Export / App IPC
// v2.7 升级: 集成消息队列
// ============================================================

import { ipcMain, BrowserWindow, dialog, app, shell } from 'electron'
import { join, extname } from 'path'
import fs from 'fs'
import { execSync } from 'child_process'
import os from 'os'

// ─── 辅助: 从 ZIP 容器格式的 Office 文档提取文本 ─────
// 支持 .docx (word/document.xml) 和 .pptx (ppt/slides/slide*.xml)
function extractOfficeTextNative(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath)
    const ext = require('path').extname(filePath).toLowerCase()
    const entries = parseZipEntries(buf)
    const results: string[] = []

    for (const entry of entries) {
      if (!entry.name.endsWith('.xml') || entry.data.length === 0) {continue}
      // 跳过样式/主题/关系/设置等非内容 XML
      if (entry.name.includes('/theme/') || entry.name.includes('/styles')
        || entry.name.includes('/fontTable') || entry.name.includes('/webSettings')
        || entry.name.includes('settings.xml') || entry.name.includes('/_rels/')
        || entry.name.includes('[Content_Types]') || entry.name.includes('/slideMasters/')
        || entry.name.includes('/slideLayouts/') || entry.name.includes('/tableStyles')
        || entry.name.includes('/slideMacros/')) {continue}

      if (ext === '.pptx' && !entry.name.startsWith('ppt/slides/slide')) {continue}

      const text = entry.data.toString('utf-8')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(parseInt(n, 10)))
        .replace(/\s+/g, ' ')
        .trim()
      if (text) {results.push(text)}
    }

    return results.length > 0 ? results.join('\n\n---\n\n').slice(0, 50000) : null
  } catch { return null }
}

// ─── 极简 PDF 文本提取（纯 Node.js，无外部依赖）────
//   策略：1) 尝试从原始内容中提取 (text) Tj 模式
//         2) 尝试解压 FlateDecode 流后提取
function extractPdfTextNative(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath)
    const content = buf.toString('utf-8')
    const texts: string[] = []

    // 🔹 策略1: 直接从 raw content 提取 Tj 操作符中的文本
    //   匹配 (text) Tj 和 (text) ' 和 (text) "
    const tjPattern = /\(([^)]*)\)\s*Tj/g
    let match: RegExpExecArray | null
    while ((match = tjPattern.exec(content)) !== null) {
      const t = match[1]
        .replace(/\\(.)/g, '$1') // 处理转义 \( \) \\
        .trim()
      if (t) {texts.push(t)}
    }

    //   匹配 TJ 数组: [(text) 120 (text2)] TJ
    const tjArrayPattern = /\[([^\]]*)\]\s*TJ/g
    while ((match = tjArrayPattern.exec(content)) !== null) {
      const inner = match[1]
      const parts = inner.match(/\(([^)]*)\)/g)
      if (parts) {
        for (const p of parts) {
          const t = p.slice(1, -1).replace(/\\(.)/g, '$1').trim()
          if (t) {texts.push(t)}
        }
      }
    }

    // 🔹 策略2: 尝试解压 FlateDecode 流
    //   查找 stream...endstream 块，如果前面有 /Filter /FlateDecode
    const streamPattern = /\/Filter\s*\/FlateDecode.*?stream\s*([\s\S]*?)\s*endstream/g
    while ((match = streamPattern.exec(content)) !== null) {
      try {
        const rawData = match[1].trim()
        const buf2 = Buffer.from(rawData, 'binary')
        const decompressed = require('zlib').inflateSync(buf2)
        const decText = decompressed.toString('utf-8')
          // 从解压后的 PDF 操作符中提取文本
          .replace(/\(([^)]*)\)\s*Tj/g, (_: string, t: string) => ' ' + t.replace(/\\(.)/g, '$1') + ' ')
          .replace(/\[([^\]]*)\]\s*TJ/g, (_: string, inner: string) => {
            return ' ' + (inner.match(/\(([^)]*)\)/g) || [])
              .map((p: string) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join(' ') + ' '
          })
          .replace(/<[^>]+>\s*Tj/g, ' ') // hex strings
          .replace(/BT[\s\S]*?ET/g, (m: string) => {
            return m.replace(/\(([^)]*)\)/g, (_: string, t: string) => t.replace(/\\(.)/g, '$1'))
          })
          .replace(/[\x00-\x1f\x80-\xff]+/g, ' ')
          .replace(/\s+/g, ' ').trim()
        if (decText) {texts.push(decText)}
      } catch {}
    }

    const result = texts.join(' ').replace(/\s+/g, ' ').trim()
    return result.length > 10 ? result.slice(0, 50000) : null // 至少10个字符才认为有效
  } catch { return null }
}

// ─── 极简 ZIP 解析器（纯 Node.js，无外部依赖）───────
//   改版：用中央目录（Central Directory）获取准确大小，绕过数据描述符问题
interface ZipEntry { name: string; data: Buffer }
function parseZipEntries(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  const len = buf.length

  // 1. 找 EOCD（End of Central Directory）签名 PK\x05\x06
  let eocdOffset = -1
  for (let i = len - 22; i >= 0 && i > len - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break }
  }
  if (eocdOffset < 0) {return entries}

  // 2. 从 EOCD 读取中央目录偏移和条目数
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)
  const cdEntries = buf.readUInt16LE(eocdOffset + 10)

  // 3. 解析中央目录
  let cdPos = cdOffset
  for (let i = 0; i < cdEntries; i++) {
    if (cdPos + 46 > len) {break}
    const sig = buf.readUInt32LE(cdPos)
    if (sig !== 0x02014b50) {break}  // PK\x01\x02
    const compression = buf.readUInt16LE(cdPos + 10)
    const compressedSize = buf.readUInt32LE(cdPos + 20)
    const uncompressedSize = buf.readUInt32LE(cdPos + 24)
    const nameLen = buf.readUInt16LE(cdPos + 28)
    const extraLen = buf.readUInt16LE(cdPos + 30)
    const commentLen = buf.readUInt16LE(cdPos + 32)
    const localOffset = buf.readUInt32LE(cdPos + 42)
    const name = buf.toString('utf-8', cdPos + 46, cdPos + 46 + nameLen)

    // 跳到 local file header，获取 extraLen 以计算出 data 起始位置
    if (localOffset + 30 > len) { cdPos += 46 + nameLen + extraLen + commentLen; continue }
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + nameLen + localExtraLen

    if (compressedSize === 0) { cdPos += 46 + nameLen + extraLen + commentLen; continue }

    let data: Buffer
    if (compression === 0) {
      data = Buffer.from(buf.subarray(dataStart, dataStart + compressedSize))
    } else if (compression === 8) {
      try {
        const zlib = require('zlib')
        data = zlib.inflateRawSync(buf.subarray(dataStart, dataStart + compressedSize))
      } catch {
        cdPos += 46 + nameLen + extraLen + commentLen
        continue
      }
    } else {
      cdPos += 46 + nameLen + extraLen + commentLen
      continue
    }

    entries.push({ name, data })
    cdPos += 46 + nameLen + extraLen + commentLen
  }

  return entries
}

const bridgeStatus: Record<string, { running: boolean; connected: boolean }> = {
  discord: { running: false, connected: false },
  wechat: { running: false, connected: false },
  telegram: { running: false, connected: false },
  feishu: { running: false, connected: false },
}

export function registerBridgeIpc(mainWindow: BrowserWindow): void {
  // ─── Bridge (v2.7: 集成消息队列) ─────────────────

  ipcMain.handle('bridge:start', async (_event, platform: string) => {
    if (!bridgeStatus[platform]) {return { ok: false, error: `未知平台: ${platform}` }}
    bridgeStatus[platform].running = true
    bridgeStatus[platform].connected = true
    console.log(`[Bridge] ${platform} 已启动 (v2.7 消息队列模式)`)

    // 消息队列集成 — 每个平台桥接启动时创建专属队列消费者
    try {
      const { getMessageQueue } = require('../messageQueue')
      // 预热队列：为当前平台创建低优先级消费者
      getMessageQueue().enqueue(platform, 'system', 2, { type: 'bridge:started', platform })
    } catch { /* messageQueue 可能未初始化 */ }

    return { ok: true }
  })

  ipcMain.handle('bridge:stop', async (_event, platform: string) => {
    if (!bridgeStatus[platform]) {return { ok: false }}
    bridgeStatus[platform].running = false
    bridgeStatus[platform].connected = false

    // 清理该平台的所有队列
    try {
      const { getMessageQueue } = require('../messageQueue')
      getMessageQueue().clearChannel(platform, 'system')
    } catch { /* ignore */ }

    return { ok: true }
  })

  ipcMain.handle('bridge:status', async () => bridgeStatus)

  // 桥接消息入队
  ipcMain.handle('bridge:send-message', async (_event, platform: string, sessionId: string, priority: number, payload: any) => {
    try {
      const { getMessageQueue } = require('../messageQueue')
      const id = getMessageQueue().enqueue(platform, sessionId, priority as any, payload)
      return { ok: true, messageId: id }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // ─── Window ──────────────────────────────────────

  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {mainWindow.unmaximize()}
    else {mainWindow?.maximize()}
  })
  ipcMain.handle('window:close', () => mainWindow?.hide())

  // ─── Dialog ──────────────────────────────────────

  ipcMain.handle('dialog:save', async (_event, options: Electron.SaveDialogOptions) =>
    dialog.showSaveDialog(mainWindow, options))

  ipcMain.handle('dialog:open', async (_event, options: Electron.OpenDialogOptions) =>
    dialog.showOpenDialog(mainWindow, options))

  // ─── Export / Data ───────────────────────────────

  ipcMain.handle('export:chat', async (_event, filePath: string) => {
    try {
      mainWindow?.webContents.send('menu:do-export', filePath)
      return { success: true, path: filePath }
    } catch (err: any) { return { error: err.message } }
  })

  ipcMain.handle('data:clear-all', async () => {
    try {
      const memFile = join(app.getPath('userData'), 'memory.json')
      const confFile = join(app.getPath('userData'), 'lumina-config.json')
      if (fs.existsSync(memFile)) {fs.unlinkSync(memFile)}
      if (fs.existsSync(confFile)) {fs.unlinkSync(confFile)}
      return { success: true }
    } catch (err: any) { return { error: err.message } }
  })

  ipcMain.handle('settings:reset', async () => {
    try {
      const confFile = join(app.getPath('userData'), 'lumina-config.json')
      if (fs.existsSync(confFile)) {fs.unlinkSync(confFile)}
      return { success: true }
    } catch (err: any) { return { error: err.message } }
  })

  // ─── App ─────────────────────────────────────────

  ipcMain.handle('app:showAbout', async () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '关于 Lumina Life',
      message: 'Lumina Life 1.0 🌸',
      detail: [
        `版本: 1.0.0`,
        `Electron: ${process.versions.electron}`,
        `Chrome: ${process.versions.chrome}`,
        `Node.js: ${process.versions.node}`,
        '',
        '一个可爱的 AI 桌面伙伴，基于 Electron + LLM 技术栈。',
        '支持多 Agent 协作、技能扩展、情绪识别与定时任务。',
        '',
        '© 2026 Lumina Life Team',
      ].join('\n'),
    })
    return { ok: true }
  })

  ipcMain.handle('app:toggleDevtools', async () => {
    if (!mainWindow) {return { ok: false }}
    try {
      if (mainWindow.webContents.isDevToolsOpened()) {mainWindow.webContents.closeDevTools()}
      else {mainWindow.webContents.openDevTools({ mode: 'detach' })}
    } catch { mainWindow.webContents.toggleDevTools() }
    return { ok: true }
  })

  // ─── FS ──────────────────────────────────────────

  ipcMain.handle('fs:listDir', async (_event, dirPath: string) => {
    try {
      const absPath = join(__dirname, '..', '..', 'public', dirPath)
      if (!fs.existsSync(absPath)) {return []}
      return fs.readdirSync(absPath, { withFileTypes: true })
        .filter(e => e.isFile()).map(e => e.name)
    } catch { return [] }
  })

  // ─── File: 二进制文档文本提取 (.docx/.xlsx) ──────

  ipcMain.handle('file:extract-text', async (_event, filePath: string) => {
    try {
      const ext = require('path').extname(filePath).toLowerCase()
      if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
        const text = await extractOfficeTextNative(filePath)
        if (text) {
          console.log(`[file:extract-text] ${ext} OK: ${text.length} chars from ${filePath}`)
          return { text }
        }
        console.log(`[file:extract-text] ${ext} null from ${filePath}`)
        return { text: null }
      }
      if (ext === '.pdf') {
        const text = extractPdfTextNative(filePath)
        if (text) {
          console.log(`[file:extract-text] pdf OK: ${text.length} chars from ${filePath}`)
          return { text }
        }
        console.log(`[file:extract-text] pdf null from ${filePath}`)
        return { text: null }
      }
      return { text: null }
    } catch (e) { console.error(`[file:extract-text] error:`, e); return { text: null } }
  })

  // 接收渲染进程传输的文件内容（无 file.path 时）
  ipcMain.handle('file:extract-text-buffer', async (_event, ext: string, data: number[]) => {
    try {
      if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') {
        const buf = Buffer.from(data)
        const entries = parseZipEntries(buf)
        const results: string[] = []
        for (const entry of entries) {
          if (!entry.name.endsWith('.xml') || entry.data.length === 0) {continue}
          if (entry.name.includes('/theme/') || entry.name.includes('/styles')
            || entry.name.includes('/fontTable') || entry.name.includes('/webSettings')
            || entry.name.includes('settings.xml') || entry.name.includes('/_rels/')
            || entry.name.includes('[Content_Types]') || entry.name.includes('/slideMasters/')
            || entry.name.includes('/slideLayouts/') || entry.name.includes('/tableStyles')
            || entry.name.includes('/slideMacros/')) {continue}
          if (ext === 'pptx' && !entry.name.startsWith('ppt/slides/slide')) {continue}
          const text = entry.data.toString('utf-8')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(parseInt(n, 10)))
            .replace(/\s+/g, ' ').trim()
          if (text) {results.push(text)}
        }
        return { text: results.length > 0 ? results.join('\n\n---\n\n').slice(0, 50000) : null }
      }
      if (ext === 'pdf') {
        const buf = Buffer.from(data)
        const content = buf.toString('utf-8')
        const texts: string[] = []
        const tjPattern = /\(([^)]*)\)\s*Tj/g
        let match: RegExpExecArray | null
        while ((match = tjPattern.exec(content)) !== null) {
          const t = match[1].replace(/\\(.)/g, '$1').trim()
          if (t) {texts.push(t)}
        }
        const tjArrayPattern = /\[([^\]]*)\]\s*TJ/g
        while ((match = tjArrayPattern.exec(content)) !== null) {
          const parts = match[1].match(/\(([^)]*)\)/g)
          if (parts) {for (const p of parts) {
            const t = p.slice(1, -1).replace(/\\(.)/g, '$1').trim()
            if (t) {texts.push(t)}
          }}
        }
        // try FlateDecode streams
        const streamPattern = /\/Filter\s*\/FlateDecode.*?stream\s*([\s\S]*?)\s*endstream/g
        while ((match = streamPattern.exec(content)) !== null) {
          try {
            const rawData = match[1].trim()
            const buf2 = Buffer.from(rawData, 'binary')
            const decompressed = require('zlib').inflateSync(buf2)
            const decText = decompressed.toString('utf-8')
              .replace(/\(([^)]*)\)\s*Tj/g, (_: string, t: string) => ' ' + t.replace(/\\(.)/g, '$1') + ' ')
              .replace(/<[^>]+>\s*Tj/g, ' ')
              .replace(/[\x00-\x1f\x80-\xff]+/g, ' ')
              .replace(/\s+/g, ' ').trim()
            if (decText) {texts.push(decText)}
          } catch {}
        }
        const result = texts.join(' ').replace(/\s+/g, ' ').trim()
        return { text: result.length > 10 ? result.slice(0, 50000) : null }
      }
      return { text: null }
    } catch { return { text: null } }
  })

  // ─── STT (Web Speech API 后端占位) ────────────────

  ipcMain.handle('stt:start', async () => {
    mainWindow?.webContents.send('stt:status', { listening: true, engine: 'native' })
    return { ok: true }
  })

  ipcMain.handle('stt:stop', async () => {
    mainWindow?.webContents.send('stt:status', { listening: false, engine: 'native' })
    return { ok: true }
  })

  // ─── Audio ───────────────────────────────────────

  ipcMain.handle('audio:play', async (_event, filePath: string) => {
    await shell.openPath(filePath)
  })
}
