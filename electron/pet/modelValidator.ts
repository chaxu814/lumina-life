// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// pet/modelValidator.ts — 🛡️ Live2D 模型包安全校验器 (v0.2 创新提案1)
//
// modelImporter 负责「把模型安全拷进来」，本模块负责「拷进来之前/之后
// 判定这个模型包安不安全、合不合法」：
//   1. model3.json schema 校验（复用 modelImporter.validateModel3：
//      必填 Version / FileReferences.Moc(.moc3)）；
//   2. 磁盘存在性校验：FileReferences.Moc 指向的 .moc3 文件必须真实存在；
//   3. 恶意脚本检测：Live2D Cubism 模型包理论上只应包含 .moc3/.png/.mtn/
//      .exp3.json/.cdi3.json 等资源，若目录下出现 .js/.mjs/.cjs/.html/.htm
//      等可执行/可脚本化文件，按恶意脚本嫌疑分级报警。
//
// 纯逻辑 + 一个轻量 fs 接口，便于单测注入内存实现。
// ============================================================

import * as fssync from 'node:fs'
import * as fspath from 'node:path'
import { validateModel3, type ValidationResult } from './modelImporter'

/** 模型包内禁止出现的可执行/脚本化扩展名（小写，含点） */
export const FORBIDDEN_MODEL_EXTS = ['.js', '.mjs', '.cjs', '.html', '.htm', '.bat', '.cmd', '.exe', '.dll', '.ps1', '.sh'] as const

/** 扫描/校验结果分级 */
export type ModelRiskLevel = 'pass' | 'warn' | 'block'

export interface ModelIssue {
  level: ModelRiskLevel
  code: string
  message: string
  /** 相关文件（相对模型目录），可执行文件检测时为命中的脚本路径 */
  file?: string
}

export interface ModelValidateOutcome {
  /** 综合分级：block > warn > pass */
  level: ModelRiskLevel
  /** schema 校验是否通过（Version/FileReferences/Moc 结构合法） */
  schemaValid: boolean
  issues: ModelIssue[]
}

/** 最小文件系统接口（默认 node:fs，测试可注入） */
export interface ModelValidatorFs {
  readText: (absPath: string) => Promise<string>
  fileExists: (absPath: string) => Promise<boolean>
  /** 递归列出目录下所有文件的相对 POSIX 路径（相对 modelDir） */
  listFiles: (modelDir: string) => Promise<string[]>
}

function worse(a: ModelRiskLevel, b: ModelRiskLevel): ModelRiskLevel {
  if (a === 'block' || b === 'block') {return 'block'}
  if (a === 'warn' || b === 'warn') {return 'warn'}
  return 'pass'
}

/** 对 model3.json 已解析对象做 schema 校验（复用 importer 逻辑） */
export function schemaCheck(data: unknown): ValidationResult {
  return validateModel3(data)
}

/**
 * 检查模型目录里有没有不该出现的可执行/脚本文件。
 * Live2D 模型包若带 .js，通常意味着 Cubism 脚本扩展或被植入恶意脚本。
 */
export function scanExecutableFiles(relFiles: string[]): ModelIssue[] {
  const out: ModelIssue[] = []
  for (const rel of relFiles) {
    const lower = rel.toLowerCase().replace(/\\/g, '/')
    // 跳过目录占位（listFiles 一般只给文件，这里兜底）
    if (!lower) {continue}
    const hit = FORBIDDEN_MODEL_EXTS.find((ext) => lower.endsWith(ext))
    if (!hit) {continue}
    // .html 在极少数 Live2D demo 里可能是预览页；按 warn 而非 block
    if (hit === '.html' || hit === '.htm') {
      out.push({
        level: 'warn',
        code: 'MODEL-HTML-PAGE',
        message: `模型包内含 HTML 页面（${rel}）：可能是预览页，也可能内嵌脚本，请确认来源可信`,
        file: rel,
      })
    } else if (hit === '.sh' || hit === '.bat' || hit === '.cmd' || hit === '.ps1') {
      out.push({
        level: 'block',
        code: 'MODEL-SCRIPT-EXEC',
        message: `模型包内含可执行脚本（${rel}）：桌宠模型不应携带 shell/批处理脚本，已拦截`,
        file: rel,
      })
    } else if (hit === '.exe' || hit === '.dll') {
      out.push({
        level: 'block',
        code: 'MODEL-BINARY',
        message: `模型包内含二进制可执行文件（${rel}）：Live2D 模型包绝不应该包含 .exe/.dll，已拦截`,
        file: rel,
      })
    } else {
      // .js/.mjs/.cjs
      out.push({
        level: 'block',
        code: 'MODEL-JS-SCRIPT',
        message: `模型包内含 JavaScript（${rel}）：第三方 Live2D 模型携带脚本是恶意载荷的典型特征，已拦截`,
        file: rel,
      })
    }
  }
  return out
}

/** 从 model3.json 对象里取出 FileReferences.Moc（字符串） */
export function extractMocRel(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {return null}
  const refs = (data as Record<string, unknown>)['FileReferences']
  if (typeof refs !== 'object' || refs === null) {return null}
  const moc = (refs as Record<string, unknown>)['Moc']
  return typeof moc === 'string' ? moc : null
}

/**
 * 一站式校验：读取 model3.json → schema 校验 → moc3 落盘存在性 → 可执行文件扫描。
 *
 * @param modelDir  模型目录绝对路径
 * @param entryRel  model3.json 相对 modelDir 的 POSIX 路径
 * @param fs        文件系统实现（默认 node:fs）
 */
export async function validateModelPackage(
  modelDir: string,
  entryRel: string,
  fs: ModelValidatorFs = defaultFs(),
): Promise<ModelValidateOutcome> {
  const issues: ModelIssue[] = []
  let level: ModelRiskLevel = 'pass'
  let schemaValid = false

  const entryAbs = fspath.join(modelDir, entryRel)
  let raw: string
  try {
    raw = await fs.readText(entryAbs)
  } catch {
    issues.push({ level: 'block', code: 'MODEL-NO-ENTRY', message: `找不到入口文件：${entryRel}` })
    return { level: 'block', schemaValid: false, issues }
  }

  let data: unknown
  try { data = JSON.parse(raw) }
  catch {
    issues.push({ level: 'block', code: 'MODEL-BAD-JSON', message: `入口 ${entryRel} 不是合法 JSON` })
    return { level: 'block', schemaValid: false, issues }
  }

  // 1) schema
  const s = schemaCheck(data)
  schemaValid = s.valid
  if (!s.valid) {
    for (const msg of s.errors) {
      issues.push({ level: 'block', code: 'MODEL-SCHEMA', message: msg })
    }
    level = worse(level, 'block')
  }

  // 2) moc3 文件落盘存在性（仅在 schema 通过时检查，否则 FileReferences 都没有）
  if (s.valid) {
    const mocRel = extractMocRel(data)
    if (mocRel) {
      // moc 相对 model3.json 所在目录
      const entryDir = entryRel.includes('/') ? entryRel.replace(/[^/]+$/, '') : ''
      const mocAbs = fspath.join(modelDir, entryDir, mocRel.replace(/\//g, fspath.sep))
      const exists = await fs.fileExists(mocAbs)
      if (!exists) {
        issues.push({
          level: 'block',
          code: 'MODEL-MISSING-MOC',
          message: `FileReferences.Moc 指向的 .moc3 文件不存在：${mocRel}`,
          file: mocRel,
        })
        level = worse(level, 'block')
      }
    }
  }

  // 3) 可执行/脚本文件扫描
  const allFiles = await fs.listFiles(modelDir)
  const execIssues = scanExecutableFiles(allFiles)
  issues.push(...execIssues)
  for (const i of execIssues) {level = worse(level, i.level)}

  return { level, schemaValid, issues }
}

/** 默认 node:fs 实现 */
export function defaultFs(): ModelValidatorFs {
  return {
    async readText(absPath) {
      return fssync.promises.readFile(absPath, 'utf8')
    },
    async fileExists(absPath) {
      try {
        await fssync.promises.access(absPath, fssync.constants.R_OK)
        return true
      } catch { return false }
    },
    async listFiles(modelDir) {
      const out: string[] = []
      async function walk(dir: string): Promise<void> {
        let entries: fssync.Dirent[]
        try { entries = await fssync.promises.readdir(dir, { withFileTypes: true }) }
        catch { return }
        for (const e of entries) {
          const abs = fspath.join(dir, e.name)
          if (e.isDirectory()) {
            if (/^(node_modules|\.git|__MACOSX)$/i.test(e.name)) {continue}
            await walk(abs)
          } else {
            out.push(fspath.relative(modelDir, abs).replace(/\\/g, '/'))
          }
        }
      }
      await walk(modelDir)
      return out
    },
  }
}
