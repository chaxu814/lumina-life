// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// ipc/webdavSyncIpc.ts — 跨设备云同步（WebDAV）IPC（提案4）
//
//   webdav-sync:get-config          读取配置
//   webdav-sync:save-settings       保存 WebDAV 连接（密码加密落盘）
//   webdav-sync:set-encryption-password  设置/清空客户端加密口令
//   webdav-sync:test-connection     测试 WebDAV 连接
//   webdav-sync:run                 立即同步
//   webdav-sync:resolve-conflict    解决冲突
// ============================================================

import { ipcMain } from 'electron'
import {
  getSyncConfig,
  saveWebdavSettings,
  setEncryptionPassword,
  hasEncryptionPassword,
} from '../sync/syncConfig'
import { WebDavClient } from '../sync/webdavClient'
import { SyncEngine, CryptoBox } from '../sync/syncEngine'
import { appDataDir, getMemoryDbPath } from '../paths'
import * as path from 'path'

/** 构造一个带当前凭据的客户端 */
function buildClient() {
  const cfg = getSyncConfig()
  // 延迟读密码（测试时 safeStorage 退化为 base64）
   
  const { getSecrets } = require('../sync/syncConfig') as typeof import('../sync/syncConfig')
  const secrets = getSecrets()
  return new WebDavClient({
    baseUrl: cfg.url,
    username: cfg.username,
    password: secrets.webDavPassword,
  })
}

function buildEngine() {
  const cfg = getSyncConfig()
   
  const { getSecrets } = require('../sync/syncConfig') as typeof import('../sync/syncConfig')
  const secrets = getSecrets()
  const client = new WebDavClient({
    baseUrl: cfg.url,
    username: cfg.username,
    password: secrets.webDavPassword,
  })
  const localRoot = path.join(appDataDir(), 'memory')
  const engine = new SyncEngine(client, {
    localRoot,
    direction: cfg.direction,
    crypto: new CryptoBox(secrets.encryptionPassword),
    dbFiles: { 'lumina-memory.db': getMemoryDbPath() },
  })
  return { cfg, engine }
}

export function registerWebdavSyncIpc(): void {
  ipcMain.handle('webdav-sync:get-config', () => {
    const cfg = getSyncConfig()
    return { ok: true, config: cfg, hasEncryption: hasEncryptionPassword() }
  })

  ipcMain.handle('webdav-sync:save-settings', (_e, input: {
    url: string; username: string; password: string
    direction?: 'bidirectional' | 'upload-only' | 'download-only'; remoteDir?: string
  }) => {
    try {
      const cfg = saveWebdavSettings(input)
      return { ok: true, config: cfg }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('webdav-sync:set-encryption-password', (_e, password: string) => {
    try {
      setEncryptionPassword(password || '')
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('webdav-sync:test-connection', async () => {
    try {
      const client = buildClient()
      return await client.testConnection()
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('webdav-sync:run', async () => {
    try {
      const { cfg, engine } = buildEngine()
      const report = await engine.sync(cfg.remoteDir)
      return { ok: !report.error, report }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('webdav-sync:resolve-conflict', async (_e, relPath: string, choice: 'local' | 'remote' | 'merge') => {
    try {
      const { cfg, engine } = buildEngine()
      return await engine.resolveConflict(relPath, choice, cfg.remoteDir)
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  console.log('[webdav-sync] 📡 IPC 已注册 (webdav-sync:*)')
}
