// ============================================================
// electron/memory/federation.ts — 团队记忆共享 Federation (提案3, Level 1)
//
// 目标：把自己的记忆（MEMORY.md / 每日笔记 / SOUL_*.md / PROFILE.md / AGENTS.md）
//       打包成可交换的 JSON 包，并把别人/别处导入的记忆隔离存放，
//       绝不覆盖用户原文件。
//
// 设计要点：
//   - 用户自己的记忆 confidence = 1.0；导入的默认 0.7，用户可调整。
//   - 导入的记忆落到 <dataDir>/memory/federated/<source>/ 下，
//     与用户原始记忆物理隔离；冲突时打 conflict 标记，交用户选择。
//   - 本模块尽量做成「纯函数 + 显式目录参数」，Electron 不可用（单测/CLI）也能跑。
//
// Level 2/3 见：
//   - docs/templates/memory-pool-worker.js   （公共记忆池：Cloudflare Workers + KV）
//   - docs/federation-e2ee-design.md         （E2EE + P2P 架构，未实现 / 隐私红线）
// ============================================================

import * as fs from 'fs'
import * as path from 'path'

// ── 类型 ─────────────────────────────────────────────────────

export type MemoryKind = 'memory' | 'daily' | 'soul' | 'profile' | 'agents' | 'other'

export interface MemoryEntry {
  /** 相对记忆根的路径，例如 "MEMORY.md"、"2026-09-21.md" */
  path: string
  /** 文件正文（utf-8） */
  content: string
  /** 来源标签：自己的记忆为 "self"，导入时为对方的 source 名 */
  source: string
  /** 文件 mtime（ms） */
  timestamp: number
  /** 可信度：自己的 1.0，导入默认 0.7，用户可在 0~1 间调整 */
  confidence: number
  /** 文件分类，便于前端分组展示 */
  kind: MemoryKind
}

export interface MemoryExport {
  version: 1
  app: 'lumina-life'
  /** 导出者身份（设备名/昵称），导入方以此为来源标签 */
  source: string
  exportedAt: number
  entries: MemoryEntry[]
}

export interface ImportOptions {
  /** 导入根目录：<root>/federated/<source>/... 默认 appDataDir/memory */
  destRoot?: string
  /** 覆盖导入记忆的默认可信度（默认 0.7） */
  confidence?: number
  /** 冲突策略：'mark'（默认，标记 conflict 等用户选） | 'overwrite' | 'skip' */
  onConflict?: 'mark' | 'overwrite' | 'skip'
}

export interface ImportedRecord {
  source: string
  importedAt: number
  confidence: number
  entryCount: number
  /** 相对 destRoot 的清单文件路径列表 */
  files: string[]
  /** 冲突文件（相对路径） */
  conflicts: string[]
  status: 'ok' | 'conflict'
}

export interface ImportResult {
  ok: boolean
  imported: number
  skipped: number
  conflicts: string[]
  destRoot: string
  error?: string
}

// ── 默认目录解析 ──────────────────────────────────────────────

/** 找「记忆根」：显式传入则原样使用（哪怕为空目录）；未传才自动探测候选位置。 */
export function resolveMemoryRoot(explicit?: string): string {
  if (explicit) {return explicit}

  const candidates: string[] = []
  // 1) 环境变量（测试 / Docker 可挂载）
  if (process.env.LUMINA_WORKDIR) {candidates.push(process.env.LUMINA_WORKDIR)}
  // 2) 当前工作目录（dev 下即仓库根，AGENTS.md 所在处）
  candidates.push(process.cwd())
  // 3) __dirname 的上两级（本文件在 electron/memory/，仓库根是 ../../）
  try {candidates.push(path.join(__dirname, '..', '..'))} catch {}

  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'AGENTS.md')) || fs.existsSync(path.join(c, 'MEMORY.md'))) {
        return c
      }
    } catch {}
  }
  // 兜底：返回 cwd，由上层读文件时自然报缺失
  return process.cwd()
}

/** 联邦记忆落地根目录（Electron userData/memory），测试可注入。 */
export function resolveFederatedRoot(explicit?: string): string {
  if (explicit) {return explicit}
  try {
    const electron = require('electron')
    const app = electron?.app
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'memory')
    }
  } catch {}
  return path.join(process.cwd(), 'memory')
}

// ── 分类工具 ──────────────────────────────────────────────────

function classify(relPath: string): MemoryKind {
  const base = path.basename(relPath)
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(base)) {return 'daily'}
  if (base === 'MEMORY.md') {return 'memory'}
  if (base.startsWith('SOUL_') && base.endsWith('.md')) {return 'soul'}
  if (base === 'PROFILE.md') {return 'profile'}
  if (base === 'AGENTS.md') {return 'agents'}
  return 'other'
}

/** 收集要导出的记忆文件：顶层 4 个核心 md + memory/ 子目录每日笔记 */
function collectFiles(root: string): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = []
  const topFiles = ['MEMORY.md', 'SOUL_LUMINA.md', 'PROFILE.md', 'AGENTS.md']
  for (const f of topFiles) {
    const abs = path.join(root, f)
    if (fs.existsSync(abs)) {out.push({ rel: f, abs })}
  }
  // memory/ 子目录：每日笔记 + 可能的 MEMORY.md
  const sub = path.join(root, 'memory')
  if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
    for (const f of fs.readdirSync(sub)) {
      if (!f.endsWith('.md')) {continue}
      const abs = path.join(sub, f)
      if (fs.statSync(abs).isFile()) {
        out.push({ rel: path.join('memory', f), abs })
      }
    }
  }
  return out
}

// ── 导出 ─────────────────────────────────────────────────────

/**
 * 把记忆根目录下的核心记忆打包为可交换 JSON。
 * @param opts.source 导出者身份标签（默认主机名）
 */
export function exportMemory(opts: { memoryRoot?: string; source?: string } = {}): MemoryExport {
  const root = resolveMemoryRoot(opts.memoryRoot)
  const files = collectFiles(root)
  const entries: MemoryEntry[] = []

  for (const { rel, abs } of files) {
    try {
      const stat = fs.statSync(abs)
      const content = fs.readFileSync(abs, 'utf-8')
      entries.push({
        path: rel.split(path.sep).join('/'),
        content,
        source: 'self',
        timestamp: Math.round(stat.mtimeMs),
        confidence: 1.0,
        kind: classify(rel),
      })
    } catch (e) {
      console.warn('[federation] 跳过读取失败的记忆文件:', rel, e)
    }
  }

  return {
    version: 1,
    app: 'lumina-life',
    source: opts.source || safeHostname(),
    exportedAt: Date.now(),
    entries,
  }
}

function safeHostname(): string {
  try {return require('os').hostname() || 'unknown-device'} catch {return 'unknown-device'}
}

// ── 导入 ──────────────────────────────────────────────────────

function safeSourceName(source: string): string {
  // 防止路径穿越：只保留字母数字 - _ 中文
  const s = (source || 'unknown').trim().replace(/[^\w\u4e00-\u9fa5.\-]/g, '_')
  return s || 'unknown'
}

function manifestPath(destRoot: string): string {
  return path.join(destRoot, 'federated', '_manifest.json')
}

function readManifest(destRoot: string): { sources: Record<string, ImportedRecord> } {
  const p = manifestPath(destRoot)
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return { sources: {} }
  }
}

function writeManifest(destRoot: string, m: { sources: Record<string, ImportedRecord> }): void {
  const p = manifestPath(destRoot)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(m, null, 2), 'utf-8')
}

/**
 * 导入记忆包。导入的记忆写到 <destRoot>/federated/<source>/，
 * 不触碰用户原始文件。冲突默认打标记。
 */
export function importMemory(
  json: MemoryExport | string,
  options: ImportOptions = {},
): ImportResult {
  const destRoot = resolveFederatedRoot(options.destRoot)
  const pkg: MemoryExport = typeof json === 'string' ? JSON.parse(json) : json
  if (!pkg || pkg.app !== 'lumina-life' || !Array.isArray(pkg.entries)) {
    return { ok: false, imported: 0, skipped: 0, conflicts: [], destRoot, error: '记忆包格式不正确（需要 lumina-life v1）' }
  }

  const source = safeSourceName(pkg.source || 'imported')
  const conf = options.confidence ?? 0.7
  const onConflict = options.onConflict ?? 'mark'
  const targetDir = path.join(destRoot, 'federated', source)
  fs.mkdirSync(targetDir, { recursive: true })

  const files: string[] = []
  const conflicts: string[] = []
  let imported = 0
  let skipped = 0

  for (const e of pkg.entries) {
    const rel = (e.path || '').split('/').filter(Boolean).join('/')
    if (!rel) {continue}
    // 防路径穿越
    const safeRel = rel.replace(/\.\.(\/|\\|$)/g, '')
    const dest = path.join(targetDir, safeRel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    let isConflict = false
    if (fs.existsSync(dest)) {
      const existing = fs.readFileSync(dest, 'utf-8')
      if (existing !== e.content) {isConflict = true}
    }

    if (isConflict) {
      if (onConflict === 'skip') {skipped++; continue}
      if (onConflict === 'overwrite') {
        fs.writeFileSync(dest, e.content, 'utf-8')
        conflicts.push(safeRel + ' (已覆盖)')
      } else {
        // mark：写入 .conflict 副本，不动原文件
        fs.writeFileSync(dest + '.conflict', e.content, 'utf-8')
        conflicts.push(safeRel)
        skipped++
      }
    } else {
      fs.writeFileSync(dest, e.content, 'utf-8')
      imported++
    }
    files.push(safeRel)
  }

  // 更新 manifest
  const manifest = readManifest(destRoot)
  manifest.sources[source] = {
    source,
    importedAt: Date.now(),
    confidence: conf,
    entryCount: files.length,
    files,
    conflicts,
    status: conflicts.length && onConflict === 'mark' ? 'conflict' : 'ok',
  }
  writeManifest(destRoot, manifest)

  return { ok: true, imported, skipped, conflicts, destRoot }
}

// ── 列表 ─────────────────────────────────────────────────────

export interface FederatedListing {
  source: string
  importedAt: number
  confidence: number
  entryCount: number
  conflicts: string[]
  status: 'ok' | 'conflict'
}

/** 列出已导入的联邦记忆来源（分组）。 */
export function listFederatedMemories(destRoot?: string): FederatedListing[] {
  const root = resolveFederatedRoot(destRoot)
  const m = readManifest(root)
  return Object.values(m.sources).sort((a, b) => b.importedAt - a.importedAt)
}

/** 调整某来源的可信度（用户可在 0~1 间微调）。 */
export function setFederatedConfidence(source: string, confidence: number, destRoot?: string): { ok: boolean; error?: string } {
  const root = resolveFederatedRoot(destRoot)
  const m = readManifest(root)
  const s = safeSourceName(source)
  if (!m.sources[s]) {return { ok: false, error: '未找到该来源' }}
  m.sources[s].confidence = Math.max(0, Math.min(1, confidence))
  writeManifest(root, m)
  return { ok: true }
}
