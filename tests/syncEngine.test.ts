// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// tests/syncEngine.test.ts — 同步引擎单测（提案4）
// 覆盖：AES-256-GCM round-trip、SHA-256、增量上传/下载、冲突检测。
import { describe, it, expect, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { CryptoBox, sha256, SyncEngine, type FileSig } from '../electron/sync/syncEngine'

// ── 内存假 WebDAV 服务端 ──────────────────────────────────
class FakeDav {
  store = new Map<string, Buffer>()
  async mkcol(_p: string) { return { ok: true, status: 200 } }
  async get(p: string) { return this.store.has(p) ? this.store.get(p)! : null }
  async put(p: string, body: Buffer) { this.store.set(p, Buffer.isBuffer(body) ? body : Buffer.from(body)); return { ok: true, status: 200 } }
  async delete(p: string) { this.store.delete(p); return { ok: true, status: 200 } }
}

function mkdt(p: string) { return fs.mkdtempSync(path.join(os.tmpdir(), p)) }

describe('CryptoBox AES-256-GCM', () => {
  it('有口令时加解密 round-trip 还原原文', () => {
    const box = new CryptoBox('my-strong-pass')
    const plain = Buffer.from('这是一段要同步的记忆内容 🧠', 'utf-8')
    const envelope = box.encrypt(plain)
    expect(envelope.equals(plain)).toBe(false) // 不是明文
    const back = box.decrypt(envelope)
    expect(back.toString('utf-8')).toBe(plain.toString('utf-8'))
  })

  it('篡改密文会被 GCM 标签校验拒绝', () => {
    const box = new CryptoBox('pass')
    const envelope = box.encrypt(Buffer.from('hello world'))
    envelope[envelope.length - 1] ^= 0xff // 翻转最后一字节
    expect(() => box.decrypt(envelope)).toThrow()
  })

  it('无口令时为明文直通', () => {
    const box = new CryptoBox('')
    const plain = Buffer.from('passthrough')
    expect(box.encrypt(plain).equals(plain)).toBe(true)
    expect(box.decrypt(plain).equals(plain)).toBe(true)
    expect(box.enabled).toBe(false)
  })

  it('不同口令解不开', () => {
    const boxA = new CryptoBox('password-A')
    const boxB = new CryptoBox('password-B')
    const env = boxA.encrypt(Buffer.from('secret'))
    expect(() => boxB.decrypt(env)).toThrow()
  })
})

describe('sha256', () => {
  it('确定性输出 64 位 hex，内容不同则哈希不同', () => {
    expect(sha256('abc')).toBe(sha256('abc'))
    expect(sha256('abc')).not.toBe(sha256('abd'))
    expect(sha256('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('SyncEngine 增量与冲突', () => {
  let localRoot: string
  let fake: FakeDav
  let engine: SyncEngine

  beforeEach(() => {
    localRoot = mkdt('lumina-sync-local-')
    fake = new FakeDav()
    engine = new SyncEngine(fake as any, {
      localRoot,
      direction: 'bidirectional',
      crypto: new CryptoBox('sync-pass'),
    })
  })

  it('新本地文件被上传并写入远程索引', async () => {
    fs.writeFileSync(path.join(localRoot, 'note.md'), '# hello')
    const report = await engine.sync('lumina-sync')
    expect(report.error).toBeUndefined()
    expect(report.uploaded).toBe(1)
    // 远程索引存在
    const idx = await fake.get('/lumina-sync/.lumina-index.json')
    expect(idx).not.toBeNull()
  })

  it('未改动的文件再次同步为 unchanged', async () => {
    fs.writeFileSync(path.join(localRoot, 'a.md'), 'v1')
    await engine.sync('lumina-sync')
    const r2 = await engine.sync('lumina-sync')
    expect(r2.uploaded).toBe(0)
    expect(r2.results.find((x) => x.relPath === 'a.md')?.action).toBe('unchanged')
  })

  it('本地改动 → 重新上传；远程改动 → 下载', async () => {
    fs.writeFileSync(path.join(localRoot, 'b.md'), 'v1')
    await engine.sync('lumina-sync')

    // 本地改
    fs.writeFileSync(path.join(localRoot, 'b.md'), 'v2-local')
    const r = await engine.sync('lumina-sync')
    expect(r.uploaded).toBe(1)

    // 远程被另一台设备改（直接改远程密文为新内容，模拟）
    const box = new CryptoBox('sync-pass')
    const idxRaw = JSON.parse(box.decrypt((await fake.get('/lumina-sync/.lumina-index.json'))!).toString('utf-8'))
    // 删掉本地，模拟本地没动、远程改：把本地文件回退到 base 一致的状态
    // 直接构造：远程 put 新内容并更新 index 中的 hash
    const newCipher = box.encrypt(Buffer.from('v3-remote'))
    await fake.put('/lumina-sync/b.md', newCipher)
    const newSig: FileSig = { hash: sha256('v3-remote'), mtime: 1, size: 9 }
    idxRaw.files['b.md'] = newSig
    await fake.put('/lumina-sync/.lumina-index.json', box.encrypt(Buffer.from(JSON.stringify(idxRaw))))

    // 本地文件改回与 base 一致（v2-local 已是 base），远程变了 → 下载
    const r2 = await engine.sync('lumina-sync')
    expect(r2.downloaded).toBe(1)
    expect(fs.readFileSync(path.join(localRoot, 'b.md'), 'utf-8')).toBe('v3-remote')
  })

  it('双方都改 → 标记 conflict，不自动覆盖', async () => {
    fs.writeFileSync(path.join(localRoot, 'c.md'), 'base')
    await engine.sync('lumina-sync')

    // 本地改
    fs.writeFileSync(path.join(localRoot, 'c.md'), 'local-edited')
    // 远程也改（绕过引擎直接动远程）
    const box = new CryptoBox('sync-pass')
    await fake.put('/lumina-sync/c.md', box.encrypt(Buffer.from('remote-edited')))
    const idxRaw = JSON.parse(box.decrypt((await fake.get('/lumina-sync/.lumina-index.json'))!).toString('utf-8'))
    idxRaw.files['c.md'] = { hash: sha256('remote-edited'), mtime: 2, size: 13 }
    await fake.put('/lumina-sync/.lumina-index.json', box.encrypt(Buffer.from(JSON.stringify(idxRaw))))

    const r = await engine.sync('lumina-sync')
    expect(r.conflicts).toContain('c.md')
    // 本地仍保留 local-edited
    expect(fs.readFileSync(path.join(localRoot, 'c.md'), 'utf-8')).toBe('local-edited')

    // 解决：保留云端
    const res = await engine.resolveConflict('c.md', 'remote', 'lumina-sync')
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(path.join(localRoot, 'c.md'), 'utf-8')).toBe('remote-edited')
  })
})
