// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// skills/skillRuntime.ts — 🧪 第三方技能运行时沙箱 (v0.2 创新提案2)
//
// 用 Node 内置 `vm` 模块在隔离上下文中执行技能包的 index.js：
//   - 只注入严格白名单 API（console / lumina.fetch / lumina.fs.readFile）；
//   - 不暴露 require / process / child_process / net；
//   - 权限声明（skill.json.permissions）与实际调用比对：技能未声明
//     'network' 却调用 lumina.fetch → 抛错拦截；未声明 'fs.read' 却读文件 → 拦截；
//   - optionalDependency isolated-vm 缺失时回退到 vm（当前默认 vm）。
//
// 注意：vm 不是安全边界（历史上被绕过多次），它是「防呆 + 最小权限」层。
// 真正的恶意代码仍需安装前静态扫描（staticScanner）+ 用户审批兜底。
// ============================================================

import * as vm from 'node:vm'
import * as fssync from 'node:fs'
import * as fspath from 'node:path'

/** 技能可声明的权限 */
export type SkillPermission = 'network' | 'fs.read' | 'fs.write'

export const ALL_PERMISSIONS: SkillPermission[] = ['network', 'fs.read', 'fs.write']

export interface SkillManifest {
  name: string
  version: string
  description?: string
  permissions: SkillPermission[]
  /** 技能对外暴露的工具名列表 */
  tools: string[]
  /** 预留计费字段（MVP 不做真实扣款） */
  pricing?: { model: 'buy' | 'subscription' | 'free'; priceCents?: number; currency?: string }
  /** 发布者签名（RSA+SHA256，由 security/staticScanner 校验） */
  signature?: string
  author?: string
}

export interface SkillTool {
  name: string
  description?: string
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface LoadedSkill {
  manifest: SkillManifest
  tools: SkillTool[]
}

export function isSkillPermission(p: unknown): p is SkillPermission {
  return typeof p === 'string' && (ALL_PERMISSIONS as string[]).includes(p)
}

/** 解析并校验 skill.json */
export function parseSkillManifest(raw: unknown): { manifest: SkillManifest | null; error?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { manifest: null, error: 'skill.json 不是合法 JSON 对象' }
  }
  const o = raw as Record<string, unknown>
  if (typeof o.name !== 'string' || !o.name.trim()) {
    return { manifest: null, error: 'skill.json 缺少 name 字段' }
  }
  if (typeof o.version !== 'string' || !o.version.trim()) {
    return { manifest: null, error: `技能 ${o.name} 缺少 version 字段` }
  }
  const perms = Array.isArray(o.permissions)
    ? (o.permissions.filter(isSkillPermission) as SkillPermission[])
    : []
  const tools = Array.isArray(o.tools)
    ? o.tools.filter((t): t is string => typeof t === 'string')
    : []
  const manifest: SkillManifest = {
    name: o.name.trim(),
    version: o.version.trim(),
    description: typeof o.description === 'string' ? o.description : undefined,
    permissions: perms,
    tools,
    author: typeof o.author === 'string' ? o.author : undefined,
    signature: typeof o.signature === 'string' ? o.signature : undefined,
  }
  if (o.pricing && typeof o.pricing === 'object') {
    const p = o.pricing as Record<string, unknown>
    manifest.pricing = {
      model: p.model === 'subscription' ? 'subscription' : p.model === 'buy' ? 'buy' : 'free',
      priceCents: typeof p.priceCents === 'number' ? p.priceCents : undefined,
      currency: typeof p.currency === 'string' ? p.currency : 'CNY',
    }
  }
  return { manifest }
}

/** 权限守卫：技能调用某能力前检查是否已声明 */
function makeGate(manifest: SkillManifest) {
  const has = (p: SkillPermission) => manifest.permissions.includes(p)
  return {
    assert(perm: SkillPermission, api: string) {
      if (!has(perm)) {
        throw new Error(`技能 "${manifest.name}" 未声明权限 '${perm}'，却调用了 ${api}（已被运行时拦截）`)
      }
    },
  }
}

export interface SandboxEnvOptions {
  /** 技能安装目录（fs 读取被限制在此之内） */
  skillDir: string
}

/**
 * 在 vm 沙箱里执行 index.js，取回 module.exports。
 * 支持两种导出形态：
 *   1) module.exports.default = async (args) => ...        （单工具）
 *   2) module.exports = { tools: [{name, description, handler}] }  （多工具）
 */
export function runSkillEntry(source: string, manifest: SkillManifest, opts: SandboxEnvOptions): LoadedSkill {
  const gate = makeGate(manifest)
  const captured: { exports: Record<string, any> } = { exports: {} }

  // ── 注入的白名单 lumina API ─────────────────────
  const luminaApi = {
    meta: { name: manifest.name, version: manifest.version },
    console: {
      log: (...a: unknown[]) => console.log(`[skill:${manifest.name}]`, ...a),
      warn: (...a: unknown[]) => console.warn(`[skill:${manifest.name}]`, ...a),
      error: (...a: unknown[]) => console.error(`[skill:${manifest.name}]`, ...a),
    },
    /** 受限 fetch：必须声明 network 权限 */
    async fetch(url: string, init?: Record<string, unknown>) {
      gate.assert('network', 'lumina.fetch')
      if (typeof fetch !== 'function') {throw new Error('当前运行环境不支持 fetch')}
      const res = await fetch(String(url), init as any)
      // 只回传纯文本/JSON，不暴露原始 Response 句柄
      const text = await res.text()
      return { status: res.status, ok: res.ok, body: text }
    },
    /** 受限 fs.readFile：必须声明 fs.read，且路径限制在技能目录内 */
    readFile(relPath: string): string {
      gate.assert('fs.read', 'lumina.readFile')
      const safe = restrictToSkillDir(relPath, opts.skillDir)
      return fssync.readFileSync(safe, 'utf8')
    },
    /** 受限 fs.writeFile：必须声明 fs.write */
    writeFile(relPath: string, content: string): void {
      gate.assert('fs.write', 'lumina.writeFile')
      const safe = restrictToSkillDir(relPath, opts.skillDir)
      fssync.writeFileSync(safe, content, 'utf8')
    },
  }

  const sandbox = {
    lumina: luminaApi,
    console: luminaApi.console,
    module: { exports: captured.exports },
    exports: captured.exports,
    // 故意不提供：require / process / globalThis / Buffer / __dirname
  }
  // createContext 后，sandbox 成为隔离上下文的全局对象；
  // runInContext 在此执行，技能代码访问不到主进程的 process/require。
  const context = vm.createContext(sandbox, { name: `lumina-skill:${manifest.name}` })

  // 用 IIFE 包裹源码并 return module.exports，在隔离上下文中执行
  const wrapped = `(function(){ ${source}


; return module.exports }).call(this)`
  let result: any
  try {
    result = vm.runInContext(wrapped, context, {
      filename: `${manifest.name}.index.js`,
    })
  } catch (e: any) {
    throw new Error(`技能 ${manifest.name} 的 index.js 执行失败：${e?.message || e}`)
  }
  result = result || captured.exports
  return buildLoadedSkill(manifest, result)
}

/** 把 module.exports 归一化为 LoadedSkill */
function buildLoadedSkill(manifest: SkillManifest, exported: any): LoadedSkill {
  const tools: SkillTool[] = []

  // 形态2：{ tools: [...] }
  if (exported && Array.isArray(exported.tools)) {
    for (const t of exported.tools) {
      if (t && typeof t.name === 'string' && typeof t.handler === 'function') {
        tools.push({ name: t.name, description: t.description, handler: t.handler })
      }
    }
  }
  // 形态1：default 函数 → 包装成与 manifest.tools[0] 同名的工具
  if (typeof exported?.default === 'function') {
    const toolName = manifest.tools[0] || manifest.name
    tools.push({ name: toolName, description: manifest.description, handler: exported.default })
  }
  // 兜底：module.exports 本身是函数
  if (!tools.length && typeof exported === 'function') {
    const toolName = manifest.tools[0] || manifest.name
    tools.push({ name: toolName, description: manifest.description, handler: exported })
  }

  if (!tools.length) {
    throw new Error(`技能 ${manifest.name} 的 index.js 既未导出 default 函数，也未导出 tools 数组`)
  }
  return { manifest, tools }
}

/** 把相对路径限制在技能目录内，防目录穿越 */
function restrictToSkillDir(relPath: string, skillDir: string): string {
  const normalized = fspath.normalize(relPath).replace(/^([a-zA-Z]:)[\\/]+/, '')
  if (normalized.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error(`禁止访问技能目录之外的路径：${relPath}`)
  }
  const abs = fspath.join(skillDir, normalized)
  const rel = fspath.relative(skillDir, abs)
  if (rel.startsWith('..') || fspath.isAbsolute(rel)) {
    throw new Error(`禁止访问技能目录之外的路径：${relPath}`)
  }
  return abs
}
