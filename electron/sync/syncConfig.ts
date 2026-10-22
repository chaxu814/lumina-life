// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/sync/syncConfig.ts — WebDAV 同步配置 + 加密密码管理（提案4）
//
// 配置分两层：
//   - webdav-sync-config.json：非敏感配置（URL、方向、开关、目录映射）
//   - webdav-secrets.enc：敏感凭据（WebDAV 密码、客户端加密口令）
//     用 Electron safeStorage 加密后落盘；非 Electron 环境（单测）退化为 base64。
// ============================================================

import * as fs from 'fs'
import * as path from 'path'

export type SyncDirection = 'bidirectional' | 'upload-only' | 'download-only'

export interface WebDavSyncConfig {
  /** WebDAV 服务地址，如 https://dav.jianguoyun.com/dav/lumina/ */
  url: string
  username: string
  /** 同步方向 */
  direction: SyncDirection
  /** 是否开机/启动后自动同步 */
  autoSync: boolean
  /** 自动同步间隔（分钟），0 表示不自动 */
  autoSyncMinutes: number
  /** 云端根目录下的同步目录名 */
  remoteDir: string
  /** 是否已配置好 */
  configured: boolean
  /** 上次同步时间 ms */
  lastSyncAt: number
  /** 预留：官方云配置接口（需自建服务端，当前为空） */
  officialCloud: { enabled: boolean; endpoint: string }
}

interface Secrets {
  webDavPassword: string
  /** 用户设置的客户端加密口令（PBKDF2 派生用）。仅存加密后的口令本身。 */
  encryptionPassword: string
}

const DEFAULT_CONFIG: WebDavSyncConfig = {
  url: '',
  username: '',
  direction: 'bidirectional',
  autoSync: false,
  autoSyncMinutes: 30,
  remoteDir: 'lumina-sync',
  configured: false,
  lastSyncAt: 0,
  officialCloud: { enabled: false, endpoint: '' },
}

function dataDir(): string {
  try {
    const electron = require('electron')
    const app = electron?.app
    if (app && typeof app.getPath === 'function') {return app.getPath('userData')}
  } catch {}
  return path.join(process.cwd(), 'userData')
}

function configPath(): string {
  return path.join(dataDir(), 'webdav-sync-config.json')
}

function secretsPath(): string {
  return path.join(dataDir(), 'webdav-secrets.enc')
}

// ── safeStorage 封装 ────────────────────────────────────────

function safe(): { encryptString(s: string): Buffer; decryptString(b: Buffer): string; isAvailable(): boolean } | null {
  try {
    const electron = require('electron')
    const ss = electron?.safeStorage
    if (ss && typeof ss.encryptString === 'function') {return ss}
  } catch {}
  return null
}

function encryptJson(obj: unknown): Buffer {
  const s = JSON.stringify(obj)
  const ss = safe()
  if (ss && ss.isAvailable && ss.isAvailable()) {
    return ss.encryptString(s)
  }
  // 非 Electron 环境：退化为 base64（仅测试用，明确不安全）
  return Buffer.from('base64:' + Buffer.from(s, 'utf-8').toString('base64'), 'utf-8')
}

function decryptJson(buf: Buffer): any {
  const s = buf.toString('utf-8')
  if (s.startsWith('base64:')) {
    return JSON.parse(Buffer.from(s.slice(7), 'base64').toString('utf-8'))
  }
  const ss = safe()
  if (ss && ss.isAvailable && ss.isAvailable()) {
    return JSON.parse(ss.decryptString(buf))
  }
  throw new Error('safeStorage 不可用且不是 base64 占位数据')
}

// ── 公开 API ────────────────────────────────────────────────

export function getSyncConfig(): WebDavSyncConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveSyncConfig(patch: Partial<WebDavSyncConfig>): WebDavSyncConfig {
  const cur = getSyncConfig()
  const next = { ...cur, ...patch }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

/** 读敏感信息（WebDAV 密码 / 加密口令）。读不到返回空串。 */
export function getSecrets(): Secrets {
  try {
    const buf = fs.readFileSync(secretsPath())
    return { webDavPassword: '', encryptionPassword: '', ...decryptJson(buf) }
  } catch {
    return { webDavPassword: '', encryptionPassword: '' }
  }
}

export function saveSecrets(patch: Partial<Secrets>): Secrets {
  const cur = getSecrets()
  const next = { ...cur, ...patch }
  fs.writeFileSync(secretsPath(), encryptJson(next))
  return next
}

/** 一次性写入 WebDAV 连接配置 + 凭据。 */
export function saveWebdavSettings(input: {
  url: string
  username: string
  password: string
  direction?: SyncDirection
  remoteDir?: string
}): WebDavSyncConfig {
  saveSecrets({ webDavPassword: input.password })
  return saveSyncConfig({
    url: input.url,
    username: input.username,
    remoteDir: input.remoteDir || 'lumina-sync',
    direction: input.direction || 'bidirectional',
    configured: true,
  })
}

/** 设置客户端加密口令（留空表示关闭端加密）。 */
export function setEncryptionPassword(pass: string): void {
  saveSecrets({ encryptionPassword: pass || '' })
}

export function hasEncryptionPassword(): boolean {
  return !!getSecrets().encryptionPassword
}
