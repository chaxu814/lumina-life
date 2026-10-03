// ============================================================
// theme/themeManager.ts — 主题管理器
//
// 职责：
//   - 列出内置 + 用户目录（userData/themes/）主题
//   - 应用主题（解析 vars、持久化当前选择、返回 resolvedVars 供渲染进程注入）
//   - 导入 / 导出 / 删除用户主题
//   - 编辑器「保存为新主题 / 覆盖当前主题」
//
// fs 可注入：测试时传 mock fs，生产用 node:fs。
// ============================================================

import path from 'path'
import { appDataDir } from '../paths'
import { BUILT_IN_THEMES, BUILT_IN_BY_NAME, DEFAULT_THEME_NAME } from './builtInThemes'
import {
  resolveThemeVars,
  themeFileName,
  validateTheme,
  type LuminaTheme,
} from './types'

/** 最小文件系统接口（生产用 node:fs，测试用 mock） */
export interface ThemeFs {
  readFile(p: string): string
  writeFile(p: string, data: string): void
  exists(p: string): boolean
  readdir(p: string): string[]
  unlink(p: string): void
  mkdir(p: string): void
}

/** node:fs 适配器 */
const nodeFs: ThemeFs = {
  readFile: (p) => {
     
    const fs = require('fs') as typeof import('fs')
    return fs.readFileSync(p, 'utf-8')
  },
  writeFile: (p, data) => {
     
    const fs = require('fs') as typeof import('fs')
    fs.writeFileSync(p, data, 'utf-8')
  },
  exists: (p) => {
     
    const fs = require('fs') as typeof import('fs')
    return fs.existsSync(p)
  },
  readdir: (p) => {
     
    const fs = require('fs') as typeof import('fs')
    return fs.readdirSync(p)
  },
  unlink: (p) => {
     
    const fs = require('fs') as typeof import('fs')
    fs.unlinkSync(p)
  },
  mkdir: (p) => {
     
    const fs = require('fs') as typeof import('fs')
    fs.mkdirSync(p, { recursive: true })
  },
}

let fsAdapter: ThemeFs = nodeFs
let themesDirOverride: string | null = null

/** 测试钩子：注入 mock fs / 临时目录 */
export function __setThemeEnvForTest(fs: ThemeFs, dir: string): void {
  fsAdapter = fs
  themesDirOverride = dir
}

/** 仅供测试：恢复默认 */
export function __resetThemeEnvForTest(): void {
  fsAdapter = nodeFs
  themesDirOverride = null
}

function themesDir(): string {
  return themesDirOverride || path.join(appDataDir(), 'themes')
}

function currentFile(): string {
  return path.join(themesDir(), 'current.json')
}

/** 主题 vars 的基准默认值（= 默认浅色），用户主题缺失变量时回退 */
const BASE_VARS: Record<string, string> = BUILT_IN_BY_NAME.get(DEFAULT_THEME_NAME)!.vars

export interface AppliedTheme {
  theme: LuminaTheme
  /** 注入到 :root 的完整 CSS 变量（语义变量 + 旧令牌派生） */
  resolvedVars: Record<string, string>
}

function readUserThemes(): LuminaTheme[] {
  const dir = themesDir()
  if (!fsAdapter.exists(dir)) { return [] }
  const out: LuminaTheme[] = []
  for (const entry of fsAdapter.readdir(dir)) {
    if (!entry.endsWith('.lumina-theme')) { continue }
    const full = path.join(dir, entry)
    try {
      const raw = JSON.parse(fsAdapter.readFile(full)) as LuminaTheme
      const v = validateTheme(raw)
      if (!v.ok) { continue } // 跳过坏主题，不致命
      out.push({ ...raw, builtIn: false, filePath: full, isDark: !!raw.isDark })
    } catch {
      // 坏 JSON 跳过
    }
  }
  return out
}

/** 列出全部主题（内置在前，用户在后） */
export function listThemes(): LuminaTheme[] {
  return [...BUILT_IN_THEMES, ...readUserThemes()]
}

function findTheme(name: string): LuminaTheme | undefined {
  if (BUILT_IN_BY_NAME.has(name)) { return BUILT_IN_BY_NAME.get(name) }
  const user = readUserThemes().find((t) => t.name === name)
  return user
}

/** 应用主题：持久化当前选择，返回解析后的变量映射 */
export function applyTheme(name: string): AppliedTheme {
  const theme = findTheme(name)
  if (!theme) {
    throw new Error(`主题不存在: ${name}`)
  }
  fsAdapter.mkdir(themesDir())
  fsAdapter.writeFile(currentFile(), JSON.stringify({ name: theme.name }, null, 2))
  return { theme, resolvedVars: resolveThemeVars(theme.vars, BASE_VARS) }
}

/** 读取上次持久化的主题（默认回退到默认浅色） */
export function getCurrentTheme(): AppliedTheme {
  let name = DEFAULT_THEME_NAME
  try {
    if (fsAdapter.exists(currentFile())) {
      const saved = JSON.parse(fsAdapter.readFile(currentFile())) as { name?: string }
      if (saved.name && findTheme(saved.name)) { name = saved.name }
    }
  } catch {
    name = DEFAULT_THEME_NAME
  }
  const theme = findTheme(name) || BUILT_IN_BY_NAME.get(DEFAULT_THEME_NAME)!
  return { theme, resolvedVars: resolveThemeVars(theme.vars, BASE_VARS) }
}

/** 导入外部 .lumina-theme 文件到用户目录 */
export function importTheme(srcPath: string): LuminaTheme {
  const raw = JSON.parse(fsAdapter.readFile(srcPath)) as LuminaTheme
  const v = validateTheme(raw)
  if (!v.ok) {
    throw new Error(`主题文件校验失败: ${v.errors.join('; ')}`)
  }
  fsAdapter.mkdir(themesDir())
  const dest = path.join(themesDir(), themeFileName(raw.name))
  const toSave: LuminaTheme = { ...raw, builtIn: false }
  delete (toSave as Partial<LuminaTheme>).builtIn
  delete (toSave as Partial<LuminaTheme>).filePath
  fsAdapter.writeFile(dest, JSON.stringify(toSave, null, 2))
  return { ...toSave, filePath: dest }
}

/** 导出主题为 .lumina-theme 文件 */
export function exportTheme(name: string, destPath: string): void {
  const theme = findTheme(name)
  if (!theme) { throw new Error(`主题不存在: ${name}`) }
  const { builtIn: _b, filePath: _f, ...serializable } = theme
  fsAdapter.writeFile(destPath, JSON.stringify(serializable, null, 2))
}

/** 删除用户自定义主题（内置主题拒绝删除） */
export function deleteTheme(name: string): void {
  if (BUILT_IN_BY_NAME.has(name)) {
    throw new Error(`内置主题不可删除: ${name}`)
  }
  const theme = findTheme(name)
  if (!theme) { throw new Error(`主题不存在: ${name}`) }
  if (theme.filePath && fsAdapter.exists(theme.filePath)) {
    fsAdapter.unlink(theme.filePath)
  }
  // 若删的是当前主题，回退到默认
  try {
    const cur = getCurrentTheme()
    if (cur.theme.name === name) {
      applyTheme(DEFAULT_THEME_NAME)
    }
  } catch { /* ignore */ }
}

/** 编辑器保存：写入用户主题（同名覆盖） */
export function saveUserTheme(theme: LuminaTheme): LuminaTheme {
  const v = validateTheme(theme)
  if (!v.ok) {
    throw new Error(`主题校验失败: ${v.errors.join('; ')}`)
  }
  if (BUILT_IN_BY_NAME.has(theme.name)) {
    throw new Error('不能覆盖内置主题，请换个名字')
  }
  fsAdapter.mkdir(themesDir())
  const dest = path.join(themesDir(), themeFileName(theme.name))
  const toSave: LuminaTheme = { ...theme, builtIn: false, isDark: !!theme.isDark }
  fsAdapter.writeFile(dest, JSON.stringify(toSave, null, 2))
  return { ...toSave, filePath: dest }
}
