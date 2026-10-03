// ============================================================
// tests/windowIcon.test.ts — 所有 BrowserWindow 都必须显式设 icon
// ============================================================
//
// 【为什么要守这个】
// 2026-10-03：用户报「任务栏图标不对」。查下来不是 icon.ico 有问题
// （7 个尺寸齐全），也不是 package.json 配错（已正确指向）——
// 而是**10 个 BrowserWindow 创建点里只有 1 个设了 icon**。
// 其中 petChatWindow 是 `skipTaskbar: false`（会显示在任务栏），
// 于是任务栏上就是 Electron 默认的原子图标。
//
// 这类问题编译器不会报、运行时也不崩溃，纯粹靠肉眼发现 —— 所以要有守卫。
//
// 【判定标准】
// 任何 `new BrowserWindow({...})` 里没有 `icon:` 的，就是潜在原子图标。
// 允许的例外：无（全部都该设，设置了也无害）。
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'electron')

/** 递归收集 electron/ 下所有 .ts */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      collectTs(p, out)
    } else if (e.name.endsWith('.ts')) {
      out.push(p)
    }
  }
  return out
}

/**
 * 取出 `new BrowserWindow({ ... })` 的参数块。
 * 用括号配对而不是正则，因为参数块里有嵌套对象/数组/函数。
 */
function extractWindowBlocks(src: string): string[] {
  const blocks: string[] = []
  const re = /new BrowserWindow\s*\(\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length
    let depth = 1
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (ch === '{') {depth++}
      else if (ch === '}') {depth--}
      i++
    }
    blocks.push(src.slice(m.index, i))
  }
  return blocks
}

interface WindowSite {
  file: string
  line: number
  hasIcon: boolean
}

function collectWindowSites(): WindowSite[] {
  const sites: WindowSite[] = []
  for (const file of collectTs(SRC)) {
    const src = fs.readFileSync(file, 'utf-8')
    for (const block of extractWindowBlocks(src)) {
      sites.push({
        file: path.relative(ROOT, file),
        line: src.slice(0, src.indexOf(block)).split('\n').length,
        hasIcon: /\bicon\s*:/.test(block),
      })
    }
  }
  return sites
}

describe('窗口图标', () => {
  const sites = collectWindowSites()

  it('能扫到 BrowserWindow 创建点（守卫本身没坏）', () => {
    expect(sites.length).toBeGreaterThan(0)
  })

  it('每个 BrowserWindow 都显式设置了 icon', () => {
    const missing = sites.filter(s => !s.hasIcon)
    const detail = missing.map(s => `  ${s.file}:${s.line}`).join('\n')
    expect(
      missing.length,
      `以下 BrowserWindow 没有设置 icon，会在任务栏/Alt-Tab 显示 Electron 默认原子图标：\n${detail}\n\n` +
      `修法：加 icon: getAppIconPath(256)，并从 electron/appIcon 引入 getAppIconPath。`,
    ).toBe(0)
  })

  it('至少覆盖到 8 个创建点（防止扫描规则失效后“全绿”）', () => {
    expect(sites.length).toBeGreaterThanOrEqual(8)
  })
})

describe('图标资源', () => {
  it('icon.ico 存在且是多尺寸（electron-builder 需要多尺寸才能正确缩放）', () => {
    const ico = path.join(ROOT, 'resources', 'icon.ico')
    expect(fs.existsSync(ico)).toBe(true)
    const buf = fs.readFileSync(ico)
    const count = buf.readUInt16LE(4)
    expect(count).toBeGreaterThanOrEqual(3)
  })

  it('icon.png 存在（窗口/任务栏实际加载的图）', () => {
    expect(fs.existsSync(path.join(ROOT, 'resources', 'icon.png'))).toBe(true)
  })

  it('package.json 的打包图标指向真实文件', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
    const b = pkg.build
    for (const key of ['win', 'mac', 'linux'] as const) {
      const p = path.join(ROOT, b[key].icon)
      expect(fs.existsSync(p), `${key}.icon 指向不存在的文件: ${b[key].icon}`).toBe(true)
    }
    expect(fs.existsSync(path.join(ROOT, b.nsis.installerIcon))).toBe(true)
  })
})
