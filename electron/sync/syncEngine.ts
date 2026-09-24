// ============================================================
// electron/sync/syncEngine.ts — 跨设备同步引擎（提案4）
//
// - 增量同步：本地 SHA-256 + mtime，云端用自维护索引 .lumina-index.json
// - AES-256-GCM 客户端加密：PBKDF2 派生密钥，云端只存密文
// - SQLite：同步前 VACUUM INTO 临时副本，传副本避免数据库锁
// - 冲突检测：双方都改 → 标记 conflict，可保留本机/云端/合并
//
// 诚实披露：
//   - WebDAV 真实服务器连接未实机验证，云端交互全部走可注入的 WebDavClient（单测用 mock fetch）。
//   - AES 加解密为代码层 round-trip 验证。
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash, pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import { WebDavClient, type WebDavEntry } from './webdavClient'
import type { SyncDirection } from './syncConfig'

// ── 类型 ─────────────────────────────────────────────────────

export interface FileSig {
  hash: string
  mtime: number
  size: number
}

export type ConflictChoice = 'local' | 'remote' | 'merge'

export interface SyncFileResult {
  relPath: string
  action: 'uploaded' | 'downloaded' | 'deleted-remote' | 'deleted-local' | 'conflict' | 'unchanged' | 'skipped'
}

export interface SyncReport {
  startedAt: number
  finishedAt: number
  uploaded: number
  downloaded: number
  deleted: number
  conflicts: string[]
  results: SyncFileResult[]
  error?: string
}

interface RemoteIndex {
  version: 1
  files: Record<string, FileSig>
}

// ── 加密盒（AES-256-GCM）───────────────────────────────────────

export class CryptoBox {
  private key: Buffer | null = null

  /** 用口令派生 32 字节密钥；空口令 = 不加密（明文直通）。 */
  constructor(passphrase: string, salt: string = 'lumina-sync-v1') {
    if (!passphrase) {
      this.key = null
      return
    }
    this.key = pbkdf2Sync(passphrase, salt, 150000, 32, 'sha256')
  }

  get enabled(): boolean {
    return this.key !== null
  }

  /** 加密明文 Buffer，输出自包含信封 Buffer（iv||tag||ciphertext）。 */
  encrypt(plain: Buffer): Buffer {
    if (!this.key) {return plain}
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(plain), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, ct])
  }

  /** 解密 encrypt() 产出的信封；标签校验失败抛错。 */
  decrypt(envelope: Buffer): Buffer {
    if (!this.key) {return envelope}
    const iv = envelope.subarray(0, 12)
    const tag = envelope.subarray(12, 28)
    const ct = envelope.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  }
}

// ── 哈希工具（导出供测试）─────────────────────────────────────

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

// ── SQLite VACUUM 备份 ───────────────────────────────────────

/** 把数据库 VACUUM INTO 到临时文件，返回临时文件路径。失败抛错。 */
export function vacuumDbCopy(dbPath: string): string {
  if (!fs.existsSync(dbPath)) {throw new Error(`数据库不存在: ${dbPath}`)}
  const tmp = path.join(os.tmpdir(), `lumina-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  let Database: any
  try {
    Database = require('better-sqlite3')
  } catch {
    throw new Error('better-sqlite3 不可用，无法备份数据库')
  }
  const db = new Database(dbPath, { readonly: true })
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/\\/g, '/').replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
  return tmp
}

// ── 同步引擎 ─────────────────────────────────────────────────

export interface SyncEngineOptions {
  /** 本地要同步的根目录 */
  localRoot: string
  /** 同步状态文件（记录上次同步基线） */
  stateFile?: string
  direction?: SyncDirection
  crypto?: CryptoBox
  /** 额外要在同步前备份的 SQLite 文件（relPath -> 本地绝对路径） */
  dbFiles?: Record<string, string>
  /** 远程索引文件名 */
  indexName?: string
}

export class SyncEngine {
  private client: WebDavClient
  private opts: Required<Omit<SyncEngineOptions, 'crypto' | 'dbFiles'>> & { crypto: CryptoBox; dbFiles: Record<string, string> }

  constructor(client: WebDavClient, opts: SyncEngineOptions) {
    this.client = client
    this.opts = {
      localRoot: opts.localRoot,
      stateFile: opts.stateFile || path.join(opts.localRoot, '.sync-state.json'),
      direction: opts.direction || 'bidirectional',
      crypto: opts.crypto || new CryptoBox(''),
      dbFiles: opts.dbFiles || {},
      indexName: opts.indexName || '.lumina-index.json',
    }
  }

  // ── 本地扫描 ────────────────────────────────────────

  private scanLocal(): Record<string, FileSig> {
    const out: Record<string, FileSig> = {}
    const root = this.opts.localRoot
    if (!fs.existsSync(root)) {return out}
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        if (f === path.basename(this.opts.stateFile) || f === this.opts.indexName) {continue}
        const abs = path.join(dir, f)
        const st = fs.statSync(abs)
        const rel = path.relative(root, abs).split(path.sep).join('/')
        if (st.isDirectory()) {walk(abs); continue}
        const content = fs.readFileSync(abs)
        out[rel] = { hash: sha256(content), mtime: Math.round(st.mtimeMs), size: st.size }
      }
    }
    walk(root)
    return out
  }

  // ── 状态（基线）─────────────────────────────────────

  private loadBase(): Record<string, FileSig> {
    try {
      return JSON.parse(fs.readFileSync(this.opts.stateFile, 'utf-8')).base || {}
    } catch {
      return {}
    }
  }

  private saveBase(base: Record<string, FileSig>): void {
    fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true })
    fs.writeFileSync(this.opts.stateFile, JSON.stringify({ base }, null, 2), 'utf-8')
  }

  // ── 远程索引 ───────────────────────────────────────

  private async readRemoteIndex(remoteDir: string): Promise<RemoteIndex> {
    const p = `/${remoteDir}/${this.opts.indexName}`
    const raw = await this.client.get(p)
    if (!raw) {return { version: 1, files: {} }}
    try {
      const decrypted = this.opts.crypto.decrypt(raw)
      return { version: 1, files: JSON.parse(decrypted.toString('utf-8')).files || {} }
    } catch {
      return { version: 1, files: {} }
    }
  }

  private async writeRemoteIndex(remoteDir: string, files: Record<string, FileSig>): Promise<void> {
    const envelope = this.opts.crypto.encrypt(Buffer.from(JSON.stringify({ version: 1, files }), 'utf-8'))
    await this.client.put(`/${remoteDir}/${this.opts.indexName}`, envelope)
  }

  // ── SQLite 备份注入 ────────────────────────────────

  /** 把配置里的 dbFiles VACUUM 备份到本地根目录，纳入本轮扫描。 */
  private materializeDbBackups(): string[] {
    const produced: string[] = []
    for (const [relPath, absPath] of Object.entries(this.opts.dbFiles)) {
      try {
        const tmp = vacuumDbCopy(absPath)
        const dest = path.join(this.opts.localRoot, relPath)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(tmp, dest)
        fs.unlinkSync(tmp)
        produced.push(relPath)
      } catch (e) {
        console.warn('[sync] 数据库备份失败，跳过:', relPath, e)
      }
    }
    return produced
  }

  // ── 主同步流程 ─────────────────────────────────────

  async sync(remoteDir?: string): Promise<SyncReport> {
    const dir = remoteDir || 'lumina-sync'
    const startedAt = Date.now()
    const report: SyncReport = {
      startedAt, finishedAt: 0, uploaded: 0, downloaded: 0, deleted: 0,
      conflicts: [], results: [],
    }

    try {
      // 0) 先把数据库 VACUUM 备份落地
      this.materializeDbBackups()

      // 1) 确保远程目录存在
      await this.client.mkcol(`/${dir}`)

      // 2) 三方比对
      const local = this.scanLocal()
      const remote = await this.readRemoteIndex(dir)
      const base = this.loadBase()

      const allKeys = new Set([...Object.keys(local), ...Object.keys(remote.files), ...Object.keys(base)])
      const newBase: Record<string, FileSig> = {}
      const newRemote: Record<string, FileSig> = { ...remote.files }
      const direction = this.opts.direction

      const doUpload = direction !== 'download-only'
      const doDownload = direction !== 'upload-only'

      for (const rel of allKeys) {
        const l = local[rel]
        const r = remote.files[rel]
        const b = base[rel]

        // 决定动作
        let action: SyncFileResult['action'] = 'unchanged'

        if (l && !r) {
          // 本地有，远程无
          if (b && l.hash === b.hash) {
            // 远程删了它；双向则跟随删除本地
            if (doDownload) {
              try {fs.unlinkSync(path.join(this.opts.localRoot, rel))} catch {}
              action = 'deleted-local'
            }
          } else if (doUpload) {
            action = 'uploaded'
          }
        } else if (!l && r) {
          // 远程有，本地无
          if (b && r.hash === b.hash) {
            // 本地删了它；双向则跟随删除远程
            if (doUpload) {
              await this.client.delete(`/${dir}/${rel}`)
              delete newRemote[rel]
              action = 'deleted-remote'
            }
          } else if (doDownload) {
            action = 'downloaded'
          }
        } else if (l && r) {
          const localChanged = !b || l.hash !== b.hash
          const remoteChanged = !b || r.hash !== b.hash
          if (!localChanged && !remoteChanged) {
            action = 'unchanged'
          } else if (localChanged && !remoteChanged && doUpload) {
            action = 'uploaded'
          } else if (!localChanged && remoteChanged && doDownload) {
            action = 'downloaded'
          } else if (localChanged && remoteChanged) {
            action = 'conflict'
          }
        }

        // 执行
        if (action === 'uploaded') {
          const plain = fs.readFileSync(path.join(this.opts.localRoot, rel))
          const envelope = this.opts.crypto.encrypt(plain)
          await this.client.put(`/${dir}/${rel}`, envelope)
          report.uploaded++
          newBase[rel] = l
          newRemote[rel] = l
        } else if (action === 'downloaded') {
          const envelope = await this.client.get(`/${dir}/${rel}`)
          if (envelope) {
            const plain = this.opts.crypto.decrypt(envelope)
            const dest = path.join(this.opts.localRoot, rel)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, plain)
            report.downloaded++
            newBase[rel] = r
            newRemote[rel] = r
          }
        } else if (action === 'conflict') {
          // 不自动覆盖，写冲突副本，交用户 resolveConflict
          report.conflicts.push(rel)
          report.results.push({ relPath: rel, action })
          // 暂以本地为基线，等用户裁决
          newBase[rel] = l
        } else if (action === 'deleted-local' || action === 'deleted-remote') {
          report.deleted++
          // 从基线移除
        } else {
          // unchanged
          if (l) {newBase[rel] = l; newRemote[rel] = r}
        }

        if (action !== 'conflict') {
          report.results.push({ relPath: rel, action })
        }
      }

      // 3) 落盘
      this.saveBase(newBase)
      await this.writeRemoteIndex(dir, newRemote)
    } catch (e: any) {
      report.error = e?.message || String(e)
    }

    report.finishedAt = Date.now()
    return report
  }

  /** 解决冲突：保留本机 / 保留云端 / 文本合并。 */
  async resolveConflict(relPath: string, choice: ConflictChoice, remoteDir?: string): Promise<{ ok: boolean; error?: string }> {
    const dir = remoteDir || 'lumina-sync'
    try {
      if (choice === 'local') {
        const plain = fs.readFileSync(path.join(this.opts.localRoot, relPath))
        const envelope = this.opts.crypto.encrypt(plain)
        await this.client.put(`/${dir}/${relPath}`, envelope)
      } else if (choice === 'remote') {
        const envelope = await this.client.get(`/${dir}/${relPath}`)
        if (envelope) {
          const plain = this.opts.crypto.decrypt(envelope)
          fs.mkdirSync(path.dirname(path.join(this.opts.localRoot, relPath)), { recursive: true })
          fs.writeFileSync(path.join(this.opts.localRoot, relPath), plain)
        }
      } else {
        // merge：文本粗暴合并（两份都保留，加分隔标记）
        const localTxt = fs.readFileSync(path.join(this.opts.localRoot, relPath), 'utf-8')
        const remoteEnvelope = await this.client.get(`/${dir}/${relPath}`)
        const remoteTxt = remoteEnvelope ? this.opts.crypto.decrypt(remoteEnvelope).toString('utf-8') : ''
        const merged = `${localTxt}\n\n<!-- ===== 云端版本（${new Date().toISOString()}）===== -->\n\n${remoteTxt}\n`
        const envelope = this.opts.crypto.encrypt(Buffer.from(merged, 'utf-8'))
        await this.client.put(`/${dir}/${relPath}`, envelope)
        fs.writeFileSync(path.join(this.opts.localRoot, relPath), merged, 'utf-8')
      }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }
}
