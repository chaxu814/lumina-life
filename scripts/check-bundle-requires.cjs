// 打包产物守卫：运行时相对 require 在打包后必然失效
const fs = require('fs')
const path = require('path')

const OUT = process.argv[2] || 'K:/2/Lumina AI/out/main'
const mainFile = path.join(OUT, 'index.js')
if (!fs.existsSync(mainFile)) {
  console.log('  (out/main/index.js 不存在，跳过 —— 构建产物未生成)')
  process.exit(0)
}

const s = fs.readFileSync(mainFile, 'utf8')
const re = /\brequire\(\s*["'](\.[^"']*)["']\s*\)/g
const hits = new Map()
let m
while ((m = re.exec(s)) !== null) {
  const p = m[1]
  if (!hits.has(p)) hits.set(p, s.slice(0, m.index).split('\n').length)
}

const missing = []
for (const [p, line] of hits) {
  if (fs.existsSync(path.join(OUT, p)) || fs.existsSync(path.join(OUT, p + '.js'))) continue
  missing.push({ p, line })
}

// 机器可读的一行（测试按这个解析；改格式时同步改 tests/bundledRequires.test.ts）
console.log(`BROKEN_RELATIVE_REQUIRES=${missing.length} TOTAL_RELATIVE_REQUIRES=${hits.size}`)
console.log(`  编译产物中的运行时相对 require: ${hits.size} 个`)
console.log(`  打包后路径不存在（必然抛错）: ${missing.length} 个`)
if (missing.length) {
  console.log('\n  按出现行号排序（前 25）：')
  for (const x of missing.sort((a, b) => a.line - b.line).slice(0, 25)) {
    console.log(`    out/main/index.js:${x.line}  require("${x.p}")`)
  }
}
process.exit(missing.length > 0 ? 1 : 0)
