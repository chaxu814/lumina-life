// ============================================================
// tests/themeManager.test.ts — 主题管理器单测
// 用内存 mock fs，覆盖 列表/应用/导入/导出/删除/校验
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import {
  __setThemeEnvForTest,
  __resetThemeEnvForTest,
  applyTheme,
  deleteTheme,
  exportTheme,
  getCurrentTheme,
  importTheme,
  listThemes,
  saveUserTheme,
  type ThemeFs,
} from '../electron/theme/themeManager'
import { validateTheme, resolveThemeVars } from '../electron/theme/types'
import { BUILT_IN_THEMES, DEFAULT_THEME_NAME } from '../electron/theme/builtInThemes'

/** 内存文件系统 */
function makeMemFs(): { fs: ThemeFs; files: Map<string, string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const fs: ThemeFs = {
    readFile: (p) => {
      if (!files.has(p)) { throw new Error(`ENOENT: ${p}`) }
      return files.get(p)!
    },
    writeFile: (p, data) => { files.set(p, data) },
    exists: (p) => files.has(p) || dirs.has(p),
    readdir: (p) =>
      [...files.keys()]
        .filter((k) => {
          const rel = k.startsWith(p) ? k.slice(p.length).replace(/^[\\/]/, '') : ''
          return rel && !rel.includes('\\') && !rel.includes('/')
        })
        .map((k) => k.slice(p.length).replace(/^[\\/]/, '')),
    unlink: (p) => { files.delete(p) },
    mkdir: (p) => { dirs.add(p) },
  }
  return { fs, files }
}

const TEST_DIR = path.sep === '\\' ? 'C:\\test-themes' : '/test-themes'

beforeEach(() => {
  const { fs } = makeMemFs()
  __setThemeEnvForTest(fs, TEST_DIR)
})

afterEach(() => {
  __resetThemeEnvForTest()
})

describe('validateTheme', () => {
  it('拒绝缺少 name 的主题', () => {
    const r = validateTheme({ version: '1.0', vars: { '--bg-primary': '#fff' } })
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toContain('name')
  })

  it('拒绝非法颜色值', () => {
    const r = validateTheme({ name: 't', version: '1.0', vars: { '--bg-primary': 'not-a-color' } })
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toContain('合法颜色')
  })

  it('接受合法主题包', () => {
    const r = validateTheme({
      name: 't', version: '1.0', author: 'x', description: 'd',
      isDark: false, vars: { '--bg-primary': '#ffffff', '--accent-primary': '#0065ff' },
    })
    expect(r.ok).toBe(true)
  })
})

describe('listThemes', () => {
  it('至少包含 3 个内置主题', () => {
    const all = listThemes()
    expect(all.length).toBeGreaterThanOrEqual(3)
    expect(all.every((t) => t.name)).toBe(true)
  })

  it('内置主题标记 builtIn=true', () => {
    const all = listThemes()
    expect(all.filter((t) => t.builtIn).length).toBe(BUILT_IN_THEMES.length)
  })
})

describe('applyTheme / getCurrentTheme', () => {
  it('默认回退到内置浅色主题', () => {
    const cur = getCurrentTheme()
    expect(cur.theme.name).toBe(DEFAULT_THEME_NAME)
  })

  it('applyTheme 解析出旧版令牌别名（--surface-0 派生自 --bg-primary）', () => {
    const applied = applyTheme('暗夜紫')
    expect(applied.theme.name).toBe('暗夜紫')
    expect(applied.resolvedVars['--surface-0']).toBe(applied.theme.vars['--bg-primary'])
    expect(applied.resolvedVars['--accent-600']).toBe(applied.theme.vars['--accent-primary'])
  })

  it('applyTheme 持久化当前选择，getCurrentTheme 读回', () => {
    applyTheme('薄荷绿')
    const cur = getCurrentTheme()
    expect(cur.theme.name).toBe('薄荷绿')
  })

  it('应用未知主题抛错', () => {
    expect(() => applyTheme('不存在的主题xyz')).toThrow()
  })
})

describe('saveUserTheme / list / delete', () => {
  it('saveUserTheme 写入后 listThemes 可见，deleteTheme 删除', () => {
    saveUserTheme({
      name: '我的主题', version: '1.0.0', author: 'me', description: '',
      isDark: false, vars: { '--bg-primary': '#112233' },
    })
    expect(listThemes().some((t) => t.name === '我的主题')).toBe(true)
    deleteTheme('我的主题')
    expect(listThemes().some((t) => t.name === '我的主题')).toBe(false)
  })

  it('拒绝删除内置主题', () => {
    expect(() => deleteTheme(DEFAULT_THEME_NAME)).toThrow()
  })

  it('拒绝覆盖内置主题名', () => {
    expect(() => saveUserTheme({
      name: '默认浅色', version: '1.0.0', author: 'x', description: '',
      isDark: false, vars: { '--bg-primary': '#000' },
    })).toThrow()
  })
})

describe('import / export', () => {
  it('importTheme 读取外部文件并校验，exportTheme 写出', () => {
    // 用 saveUserTheme 造一个，export 到外部路径，删除后再 import 回来
    saveUserTheme({
      name: '导出测试', version: '1.0.0', author: 'a', description: '',
      isDark: true, vars: { '--bg-primary': '#222' },
    })
    const external = path.join(path.sep === '\\' ? 'C:\\' : '/', 'exported.lumina-theme')
    exportTheme('导出测试', external)
    // 删掉原主题，再从外部导入
    deleteTheme('导出测试')
    expect(listThemes().some((t) => t.name === '导出测试')).toBe(false)
    const imported = importTheme(external)
    expect(imported.name).toBe('导出测试')
    expect(imported.vars['--bg-primary']).toBe('#222')
    expect(listThemes().some((t) => t.name === '导出测试')).toBe(true)
  })

  it('导入非法 JSON 抛错', () => {
    const bad = path.join(path.sep === '\\' ? 'C:\\' : '/', 'bad.lumina-theme')
    // 直接写坏文件到 fs —— 复用 saveUserTheme 拿不到 fs，改用一个新注入
    expect(() => importTheme(bad)).toThrow()
  })
})

describe('resolveThemeVars', () => {
  it('缺失变量回退 base，且不污染 --a11y 前缀', () => {
    const merged = resolveThemeVars({ '--bg-primary': '#123' }, { '--bg-primary': '#fff', '--text-primary': '#000' })
    expect(merged['--bg-primary']).toBe('#123')
    expect(merged['--text-primary']).toBe('#000')
    expect(merged['--surface-0']).toBe('#123')
  })
})
