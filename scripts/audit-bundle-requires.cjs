#!/usr/bin/env node
/**
 * 打包产物断链体检（增强版）
 *
 * 为什么需要它：`check-bundle-requires.cjs` 只告诉你「有几条断了」，
 * 但真正决定后果的是**这条 require 有没有 try/catch 兜底**：
 *   · 无兜底 → 打包后直接崩，用户看到「无法启动」
 *   · 有兜底 → 静默降级，用户只会觉得「某个功能莫名其妙不好使」
 * 第二种更危险，因为它能通过一切冒烟测试。
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const targets = process.argv.slice(2)
if (targets.length === 0) targets.push('out/main/index.js')

const REL = /require\(\s*["'](\.[^"']+)["']\s*\)/g

function resolvable(baseDir, spec) {
  // 打包产物里同级的 TS 模块被扁平化，源码相对路径必然失效。
  // 只有指向真实存在文件（含打包后被复制的资源）的才算可解析。
  const target = path.resolve(baseDir, spec)
  if (fs.existsSync(target)) return true
  if (fs.existsSync(`${target}.js`)) return true
  if (fs.existsSync(path.join(target, 'index.js'))) return true
  return false
}

const rows = []
for (const rel of targets) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) continue
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split(/\r?\n/)
  const baseDir = path.dirname(file)
  lines.forEach((line, i) => {
    REL.lastIndex = 0
    let m
    while ((m = REL.exec(line)) !== null) {
      const spec = m[1]
      if (resolvable(baseDir, spec)) continue
      // 向上找 12 行，判断是否在 try/catch 里
      const lookback = lines.slice(Math.max(0, i - 12), i + 1).join('\n')
      const guarded = /\btry\s*\{/.test(lookback)
      const swallow = /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(lookback) || /catch\s*(\([^)]*\))?\s*\{\s*\/\/[^\n]*\}/.test(lookback)
      rows.push({ file: rel, line: i + 1, spec, guarded, swallow })
    }
  })
}

const unguarded = rows.filter(r => !r.guarded)
const silent = rows.filter(r => r.guarded && r.swallow)

console.log(`断链总数        : ${rows.length}`)
console.log(`  无 try 兜底   : ${unguarded.length}  ← 打包后直接崩`)
console.log(`  空 catch 吞掉 : ${silent.length}  ← 静默降级，最危险`)
console.log(`  有兜底且留痕  : ${rows.length - unguarded.length - silent.length}`)
console.log('')
console.log('── 无 try 兜底（会直接崩）──')
unguarded.forEach(r => console.log(`  ${r.file}:${r.line}  ${r.spec}`))
console.log('')
console.log('── 空 catch 吞掉（静默降级）──')
silent.forEach(r => console.log(`  ${r.file}:${r.line}  ${r.spec}`))
