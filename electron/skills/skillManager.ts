// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// skills/skillManager.ts — 📦 第三方技能包安装/卸载/注册 (v0.2 创新提案2+5)
//
// .lumina-skill 包（zip）生命周期：
//   prepareInstall(zipPath)  → 解压到临时目录、解析 skill.json、跑静态扫描、
//                              验签、列出权限清单（不落地到正式目录）。
//                              返回 stagedId + 审批数据（前端弹窗展示）。
//   confirmInstall(stagedId)→ 用户同意后，移入 userData/skills/<name>/，
//                              用 skillRuntime 在沙箱加载 index.js，
//                              把 tools 动态注册进 electron/tools/registry。
//   uninstall(name)         → 删除目录 + 反注册工具。
//   listInstalled()         → 列出已装技能。
//
// 安装 = 静态扫描(提案5) → 签名校验 → 用户审批 → 沙箱加载 → 动态注册。
// ============================================================

import AdmZip from 'adm-zip'
import * as fsp from 'node:fs/promises'
import * as fssync from 'node:fs'
import * as fspath from 'node:path'
import * as os from 'node:os'
import {
  parseSkillManifest, runSkillEntry,
  type SkillManifest, type LoadedSkill,
} from './skillRuntime'
import { scanJavascript, aggregateResults, type StaticScanResult } from '../security/staticScanner'
import { verifyManifestSignature } from '../security/signature'
import { registerTool } from '../tools/registry'
import type { ToolResult } from '../tools/types'

interface AdmZipLike {
  getEntries(): { entryName: string; getData: () => Buffer; isDirectory: () => boolean }[]
  extractAllTo(targetDir: string, overwrite: boolean): void
}

function openZip(buf: Buffer): AdmZipLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (AdmZip as any)(buf) as AdmZipLike
}

export interface StagedSkill {
  stagedId: string
  stageDir: string
  manifest: SkillManifest
  scan: StaticScanResult
  signatureStatus: 'verified' | 'unsigned' | 'invalid'
  signatureReason?: string
}

const staging = new Map<string, StagedSkill>()
const loaded = new Map<string, LoadedSkill>()
/** 已动态注册的工具名，便于卸载时反注册（registry 无 unregister API，这里仅记录） */
const registeredToolNames = new Map<string, string[]>()

export function skillsRoot(userDataDir: string): string {
  return fspath.join(userDataDir, 'skills')
}

/** 对已解压目录里所有 .js/.mjs/.cjs 跑 AST 扫描 */
async function scanDirJs(dir: string): Promise<StaticScanResult> {
  const results: StaticScanResult[] = []
  async function walk(d: string): Promise<void> {
    let entries: fssync.Dirent[]
    try { entries = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = fspath.join(d, e.name)
      if (e.isDirectory()) {
        if (/^(node_modules|\.git)$/.test(e.name)) {continue}
        await walk(abs)
      } else if (/\.(m?js|cjs)$/.test(e.name)) {
        const src = await fsp.readFile(abs, 'utf8').catch(() => '')
        results.push(scanJavascript(src, fspath.relative(dir, abs)))
      }
    }
  }
  await walk(dir)
  if (!results.length) {
    return { severity: 'pass', findings: [{ rule: 'STC-PASS', severity: 'pass', message: '包内无 JS 文件' }] }
  }
  return aggregateResults(results)
}

/**
 * 第一步：准备安装。解压 + 解析 + 扫描 + 验签，结果交给前端审批弹窗。
 * 不真正安装。返回 stagedId。
 */
export async function prepareInstallSkill(zipPath: string, userDataDir: string): Promise<StagedSkill> {
  const buf = await fsp.readFile(zipPath)
  const zip = openZip(buf)

  // zip-slip 防护
  for (const e of zip.getEntries()) {
    const norm = e.entryName.replace(/\\/g, '/')
    if (norm.split('/').some((seg) => seg === '..')) {
      throw new Error('压缩包包含越界路径（zip-slip 风险），已拒绝')
    }
  }

  const stageDir = await fsp.mkdtemp(fspath.join(os.tmpdir(), 'lumina-skill-'))
  zip.extractAllTo(stageDir, true)

  // 读 skill.json（可能在根目录或一层子目录）
  const manifestPath = await findFile(stageDir, 'skill.json')
  if (!manifestPath) {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    throw new Error('技能包内未找到 skill.json')
  }
  const rawManifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
  const { manifest, error } = parseSkillManifest(rawManifest)
  if (!manifest) {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(error || 'skill.json 非法')
  }

  // index.js 必须存在
  const entryPath = await findFile(stageDir, 'index.js')
  if (!entryPath) {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    throw new Error('技能包内未找到 index.js 入口')
  }

  // 静态扫描
  const scan = await scanDirJs(stageDir)

  // 签名
  const sig = verifyManifestSignature(rawManifest as Record<string, unknown>)

  const stagedId = `stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const staged: StagedSkill = {
    stagedId, stageDir, manifest, scan,
    signatureStatus: sig.status, signatureReason: sig.reason,
  }
  staging.set(stagedId, staged)
  return staged
}

/** 第二步：用户确认后正式安装 + 沙箱加载 + 动态注册工具 */
export async function confirmInstallSkill(stagedId: string, userDataDir: string): Promise<{ ok: boolean; skill?: LoadedSkill; error?: string }> {
  const staged = staging.get(stagedId)
  if (!staged) {return { ok: false, error: '安装会话已过期，请重新选择技能包' }}

  // 双重保险：block 级扫描结果 / invalid 签名禁止落地
  if (staged.scan.severity === 'block') {
    await fsp.rm(staged.stageDir, { recursive: true, force: true }).catch(() => {})
    staging.delete(stagedId)
    return { ok: false, error: '静态扫描发现高危内容，安装已拦截' }
  }
  if (staged.signatureStatus === 'invalid') {
    await fsp.rm(staged.stageDir, { recursive: true, force: true }).catch(() => {})
    staging.delete(stagedId)
    return { ok: false, error: '发布者签名校验失败，安装已拦截' }
  }

  const root = skillsRoot(userDataDir)
  await fsp.mkdir(root, { recursive: true })
  const destDir = fspath.join(root, staged.manifest.name)
  await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(destDir, { recursive: true })
  // 拷贝解压内容到正式目录
  await copyDir(staged.stageDir, destDir)

  // 沙箱加载
  const entrySrc = await fsp.readFile(fspath.join(destDir, 'index.js'), 'utf8')
  let loadedSkill: LoadedSkill
  try {
    loadedSkill = runSkillEntry(entrySrc, staged.manifest, { skillDir: destDir })
  } catch (e: any) {
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {})
    staging.delete(stagedId)
    return { ok: false, error: `技能沙箱加载失败：${e?.message || e}` }
  }

  // 动态注册工具到全局 registry
  const names: string[] = []
  for (const tool of loadedSkill.tools) {
    registerTool({
      name: tool.name,
      description: tool.description || `${loadedSkill.manifest.name} 提供的技能工具`,
      toolsets: [],
      category: 'skill',
    }, async (args: Record<string, any>): Promise<ToolResult> => {
      try {
        const out = await tool.handler(args || {})
        return { callId: '', ok: true, content: typeof out === 'string' ? out : JSON.stringify(out) }
      } catch (err: any) {
        return { callId: '', ok: false, content: '', error: err?.message || String(err) }
      }
    })
    names.push(tool.name)
  }
  registeredToolNames.set(loadedSkill.manifest.name, names)
  loaded.set(loadedSkill.manifest.name, loadedSkill)

  await fsp.rm(staged.stageDir, { recursive: true, force: true }).catch(() => {})
  staging.delete(stagedId)
  return { ok: true, skill: loadedSkill }
}

/** 卸载：删目录 + 记录移除（registry 无反注册 API，工具名保留但失效） */
export async function uninstallSkill(name: string, userDataDir: string): Promise<{ ok: boolean; error?: string }> {
  const dir = fspath.join(skillsRoot(userDataDir), name)
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  loaded.delete(name)
  registeredToolNames.delete(name)
  return { ok: true }
}

export interface InstalledSkillInfo {
  name: string
  version: string
  description?: string
  permissions: string[]
  tools: string[]
  pricing?: SkillManifest['pricing']
  author?: string
}

/** 列出已安装技能（读 userData/skills/<name>/skill.json） */
export async function listInstalledSkills(userDataDir: string): Promise<InstalledSkillInfo[]> {
  const root = skillsRoot(userDataDir)
  let entries: fssync.Dirent[]
  try { entries = await fsp.readdir(root, { withFileTypes: true }) } catch { return [] }
  const out: InstalledSkillInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory()) {continue}
    const sj = fspath.join(root, e.name, 'skill.json')
    try {
      const raw = JSON.parse(await fsp.readFile(sj, 'utf8'))
      const { manifest } = parseSkillManifest(raw)
      if (manifest) {
        out.push({
          name: manifest.name, version: manifest.version, description: manifest.description,
          permissions: manifest.permissions, tools: manifest.tools,
          pricing: manifest.pricing, author: manifest.author,
        })
      }
    } catch { /* 跳过损坏目录 */ }
  }
  return out
}

// ── 内部小工具 ──────────────────────────────────────────
async function findFile(dir: string, target: string): Promise<string | null> {
  let entries: fssync.Dirent[]
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    const abs = fspath.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') {continue}
      const found = await findFile(abs, target)
      if (found) {return found}
    } else if (e.name === target) {
      return abs
    }
  }
  return null
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  let entries: fssync.Dirent[]
  try { entries = await fsp.readdir(src, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const s = fspath.join(src, e.name)
    const d = fspath.join(dest, e.name)
    if (e.isDirectory()) {
      await copyDir(s, d)
    } else {
      await fsp.copyFile(s, d)
    }
  }
}
