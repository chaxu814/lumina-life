// ============================================================
// tests/fontConsistency.test.ts — 全局字体统一为微软雅黑（2026-10-11）
//
// 【设计意图】
//   src/styles/global.css 定义：
//     --font-sans:    'Microsoft YaHei', '微软雅黑', 'Inter', -apple-system, ... , sans-serif
//     --font-display: 同上（标题/面板名，同族保证观感一致）
//   且 html/body/#root 绑定 var(--font-sans)，h1~h6 等绑定 var(--font-display)。
//   → 全局 UI 文本的「打底字体」必须是微软雅黑。
//
// 【曾经踩的坑（本次修复前）】
//   DeepResearchPanel / SkillMarketPanel 的 container 写成 fontFamily:'system-ui'，
//   MomentsPanel / ProactiveSidebar 写成 'system-ui, -apple-system, sans-serif'，
//   AchievementWall / NewsPanel 的弹层写成 "'Segoe UI', system-ui, sans-serif"，
//   petWindow.ts 的 body 写成 'Segoe UI', sans-serif —— 这些**不含微软雅黑**，
//   在 Windows 上会回退成 Segoe UI，破坏全局字体一致性。
//
// 【本测试钉住的】
//   src 与 electron（排除第三方/构建产物）里所有 CSS-in-JS 的 fontFamily / CSS 的
//   font-family 字面量，要么是：
//     · 引用设计令牌 var(--font-*)（sans/display=雅黑打底，mono=等宽，brand=得意黑，emoji=emoji）
//     · 显式含 'Microsoft YaHei' / '微软雅黑'
//     · 等宽字体（monospace / ui-monospace / Consolas / JetBrains Mono / Cascadia Code / Fira Code）—— 代码/ID/数值/路径
//     · emoji 字体（*Emoji）—— 表情符号
//     · inherit —— 继承 body（body 已是 var(--font-sans) = 雅黑）
//   不允许出现「裸 system-ui / 'Segoe UI' / 纯 sans-serif」作为字体栈且不带上述任一例外。
// ============================================================

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = process.cwd()

// 递归收集 src / electron 下需要扫描的文件（排除第三方与构建产物）
function collectFiles(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'out', 'coverage', '.git', 'pet/assets/libs'].includes(e.name)) continue
      collectFiles(full, acc)
    } else {
      if (e.name.endsWith('.min.js') || e.name.endsWith('.map')) continue
      if (/\.(tsx?|jsx?|css|html)$/.test(e.name)) acc.push(full)
    }
  }
  return acc
}

// 字体字面量是否被白名单覆盖（合法）
function isAllowedFontLiteral(value: string): boolean {
  const v = value.trim()
  // 引用设计令牌
  if (v.includes('var(--font-')) return true
  // 显式微软雅黑
  if (v.includes('Microsoft YaHei') || v.includes('微软雅黑')) return true
  // 等宽字体（代码/ID/数值/路径/cron/JSON/日志）—— 设计上故意不用雅黑
  if (/monospace|ui-monospace|Consolas|JetBrains Mono|Cascadia Code|Fira Code|SF Mono|Menlo/.test(v)) return true
  // emoji 字体
  if (/Emoji/.test(v)) return true
  // 继承 body（body 已是 var(--font-sans) = 雅黑）
  if (v === 'inherit') return true
  return false
}

// 命中裸 system-ui / 'Segoe UI' / 纯 sans-serif 但没带任何合法标记 → 视为违规
function isViolation(value: string): boolean {
  const v = value.trim()
  if (isAllowedFontLiteral(v)) return false
  // 仍是裸 sans-serif/system-ui/Segoe UI 且无雅黑/等宽/emoji/变量 → 违规
  const hasForbiddenLead = /(^|,|\s)(system-ui|'Segoe UI'|"Segoe UI"|sans-serif)(,|\s|$)/.test(v)
  return hasForbiddenLead
}

describe('全局字体统一 · 所有 UI 文本字体栈不得绕开微软雅黑', () => {
  const files = [...collectFiles(path.join(ROOT, 'src')), ...collectFiles(path.join(ROOT, 'electron'))]

  it('扫描范围非空（确认目录正确）', () => {
    expect(files.length, 'src/electron 下没有扫描到任何文件，检查 ROOT 与目录名').toBeGreaterThan(0)
  })

  it('所有 fontFamily / font-family 字面量要么带雅黑，要么走设计变量/等宽/emoji', () => {
    const violations: Array<{ file: string; line: number; value: string }> = []
    const litRe = /(?:font-family|fontFamily)\s*:\s*['"]([^'"]*)['"]/g

    for (const f of files) {
      const text = fs.readFileSync(f, 'utf-8')
      const lines = text.split('\n')
      // 1) 逐行匹配 font-family / fontFamily 的字面量
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        let m: RegExpExecArray | null
        litRe.lastIndex = 0
        while ((m = litRe.exec(line)) !== null) {
          if (isViolation(m[1])) {
            violations.push({ file: f.replace(ROOT, ''), line: i + 1, value: m[1] })
          }
        }
      }
      // 2) 也检查被引号包住的 CSS（如 petWindow.ts 的模板字符串里 font-family: 'Segoe UI', sans-serif;）
      //    这类以 font-family: 开头、内容可能跨行，简单按整文件再扫一次 font-family: 之后的片段
      const cssFragRe = /font-family\s*:\s*([^;}\n]{1,160})/g
      let cm: RegExpExecArray | null
      while ((cm = cssFragRe.exec(text)) !== null) {
        const frag = cm[1].trim()
        // 只关心「字符串字面量」片段（带引号），跳过动态 ${...} 模板
        if (frag.includes('${')) continue
        if (isViolation(frag)) {
          const lineNo = text.slice(0, cm.index).split('\n').length
          violations.push({ file: f.replace(ROOT, ''), line: lineNo, value: frag })
        }
      }
    }

    expect(
      violations,
      '以下字体声明绕开了微软雅黑（在 Windows 上会回退成 Segoe UI）：\n' +
        violations.map((x) => `  ${x.file}:${x.line}  ${x.value}`).join('\n'),
    ).toEqual([])
  })

  it('具体回归：DeepResearchPanel / SkillMarketPanel 容器不再裸 system-ui', () => {
    const deep = fs.readFileSync(path.join(ROOT, 'src/panels/DeepResearchPanel.tsx'), 'utf-8')
    const skill = fs.readFileSync(path.join(ROOT, 'src/panels/SkillMarketPanel.tsx'), 'utf-8')
    expect(deep).toMatch(/container:[\s\S]*?fontFamily:\s*'var\(--font-sans\)'/)
    expect(skill).toMatch(/container:[\s\S]*?fontFamily:\s*'var\(--font-sans\)'/)
  })

  it('具体回归：MomentsPanel / ProactiveSidebar 容器不再裸 system-ui', () => {
    const moments = fs.readFileSync(path.join(ROOT, 'src/components/MomentsPanel.tsx'), 'utf-8')
    const proactive = fs.readFileSync(path.join(ROOT, 'src/components/ProactiveSidebar.tsx'), 'utf-8')
    expect(moments).toMatch(/fontFamily:\s*'var\(--font-sans\)'/)
    expect(proactive).toMatch(/fontFamily:\s*'var\(--font-sans\)'/)
  })
})
