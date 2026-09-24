// ============================================================
// theme/types.ts — 主题包格式定义与校验
//
// .lumina-theme 文件 = JSON：
// {
//   "name": "暗夜紫",
//   "version": "1.0.0",
//   "author": "Lumina",
//   "description": "...",
//   "isDark": true,
//   "vars": { "--bg-primary": "#0f0e1a", ... },
//   "preview": "data:image/png;base64,..."   // 可选
// }
// ============================================================

/** 合法的 CSS 颜色值（hex / rgb(a) / rgba / 命名色）的宽松校验 */
const COLOR_RE =
  /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|rgba?\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*(?:,\s*(?:\d*\.?\d+)\s*)?\)|transparent|currentColor|inherit)$/

/** 合法的 CSS 变量名：--foo-bar */
const VAR_NAME_RE = /^--[a-zA-Z0-9-]+$/

export interface LuminaTheme {
  name: string
  version: string
  author: string
  description: string
  /** 主题是深色还是浅色（决定 color-scheme / 原生控件配色） */
  isDark: boolean
  /** CSS 变量映射：{ "--bg-primary": "#xxx", ... } */
  vars: Record<string, string>
  /** 可选预览缩略图（data:image/...） */
  preview?: string
  /** 内置主题为 true；用户导入/新建的为 false */
  builtIn?: boolean
  /** 用户主题所在文件路径（内置主题没有） */
  filePath?: string
}

export interface ThemeValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * 校验一个对象是否为合法主题包。
 * 纯函数，便于单测。
 */
export function validateTheme(obj: unknown): ThemeValidationResult {
  const errors: string[] = []
  if (typeof obj !== 'object' || obj === null) {
    return { ok: false, errors: ['主题文件必须是 JSON 对象'] }
  }
  const t = obj as Record<string, unknown>

  if (typeof t.name !== 'string' || !t.name.trim()) {
    errors.push('缺少必填字段 name（主题名称）')
  }
  if (typeof t.version !== 'string' || !t.version.trim()) {
    errors.push('缺少必填字段 version')
  }
  if (typeof t.vars !== 'object' || t.vars === null || Array.isArray(t.vars)) {
    errors.push('缺少必填字段 vars（CSS 变量映射对象）')
  } else {
    const vars = t.vars as Record<string, unknown>
    if (Object.keys(vars).length === 0) {
      errors.push('vars 不能为空：至少需要一个颜色变量')
    }
    for (const [k, v] of Object.entries(vars)) {
      if (!VAR_NAME_RE.test(k)) {
        errors.push(`非法变量名: ${k}（必须以 -- 开头）`)
      }
      if (typeof v !== 'string' || !COLOR_RE.test(v.trim())) {
        errors.push(`变量 ${k} 的值不是合法颜色: ${String(v)}`)
      }
    }
  }
  if ('isDark' in t && typeof t.isDark !== 'boolean') {
    errors.push('isDark 必须是布尔值')
  }
  if (typeof t.preview === 'string' && t.preview && !t.preview.startsWith('data:image/')) {
    errors.push('preview 必须是 data:image/... 格式')
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 旧版设计令牌 → 语义变量 的派生映射。
 * 主题包只写语义变量（--bg-* 等），这里把它展开成组件实际消费的
 * 旧令牌（--surface-* / --accent-500 等），从而不用逐个组件改色。
 * 注意：--a11y-* 前缀属于无障碍子代理，这里不碰。
 */
const LEGACY_ALIAS: Record<string, string> = {
  '--surface-0': '--bg-primary',
  '--surface-50': '--bg-secondary',
  '--surface-100': '--bg-tertiary',
  '--surface-200': '--bg-hover',
  '--surface-300': '--bg-hover',
  '--text-tertiary': '--text-muted',
  '--accent-400': '--accent-secondary',
  '--accent-500': '--accent-secondary',
  '--accent-600': '--accent-primary',
  '--accent-700': '--accent-hover',
  '--border-light': '--border-color',
  '--border-medium': '--border-color',
}

/**
 * 把主题的语义 vars 解析成完整注入映射：
 * 1) 语义 vars 原样
 * 2) 派生出旧版令牌别名（若主题没直接覆盖）
 * 3) 主题未提供的语义变量回退到 BASE_THEME_VARS 默认值
 */
export function resolveThemeVars(
  partialVars: Record<string, string>,
  baseVars: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...baseVars, ...partialVars }
  const resolved: Record<string, string> = { ...merged }

  for (const [legacy, semantic] of Object.entries(LEGACY_ALIAS)) {
    if (!(legacy in partialVars)) {
      const value = merged[semantic]
      if (value !== undefined) {
        resolved[legacy] = value
      }
    }
  }
  return resolved
}

/** 主题文件名（安全化） */
export function themeFileName(name: string): string {
  const safe = name.trim().replace(/[\\/:*?"<>|]/g, '_')
  return `${safe}.lumina-theme`
}
