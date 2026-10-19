// ============================================================
// check-bundle-requires.cjs — 打包产物守卫：运行时相对 require 在打包后必然失效
//
// 【为什么必须跑在真实构建产物上】2026-10-03 真机事故：delegationManager 的
//   require('./core/agentOrchestrator') 在 dev 能解析、打包后必然失败，
//   抛错被 catch 吞掉后三 Agent 团队整个失效，而 187 个测试全绿。
//
// 【2026-10-20 冒烟测试补充】实测当前产物：86 个运行时相对 require，
//   其中 56 个路径在 out/main/ 下不存在（多数在 try/catch 兜底路径里，
//   一旦触发即静默降级）。同日已修 jsonMemoryStore（静态 import），57→56。
//   剩余 56 个属于存量债务，用基线棘轮锁定：不得新增，修一个少一个。
//
// 用法：
//   node scripts/check-bundle-requires.cjs [outDir]        # 门禁（超基线 exit 1）
//   node scripts/check-bundle-requires.cjs [outDir] --update  # 重采基线
// ============================================================
const fs = require('fs')
const path = require('path')

const OUT = process.argv[2] || 'K:/2/Lumina AI/out/main'
const BASELINE_FILE = path.join(__dirname, 'bundle-requires-baseline.json')
const UPDATE = process.argv.includes('--update')
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

// ── 基线棘轮：spec 列表 + 总数双闸门（沿用 2026-10-04 的 baseline 格式）──
//   ① 任何**不在 specs 列表里**的坏引用 = 新增债务 → 失败（比只比总数更准，
//      防止「修一个旧的、加一个新的」被总数掩盖）；
//   ② 总数超过 baseline.total = 水位上涨 → 失败。
let baseline = null
try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8')) } catch { /* 无基线=严格模式 */ }

if (UPDATE) {
  const known = new Set(missing)
  const payload = {
    updatedAt: new Date().toISOString().slice(0, 10),
    total: missing.length,
    history: Array.isArray(baseline && baseline.history) ? baseline.history : [],
    accepted: (baseline && baseline.accepted) || {},
    specs: [...known].sort(),
  }
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(payload, null, 2) + '\n')
  console.log(`\n📝 基线已重采：${missing.length} 条 → ${path.basename(BASELINE_FILE)}`)
  process.exit(0)
}

if (baseline && typeof baseline.total === 'number') {
  const known = new Set(Array.isArray(baseline.specs) ? baseline.specs : [])
  const added = missing.filter((x) => !known.has(x.p))
  if (added.length) {
    console.log(`\n❌ 新增 ${added.length} 个打包后解析不到的相对 require：`)
    for (const x of added) {console.log(`    out/main/index.js:${x.line}  require("${x.p}")`)}
    console.log('   修法：改静态 import（注意别造成循环依赖）或 await import()；确认是有意保留则 --update 并说明。')
    process.exit(1)
  }
  if (missing.length > baseline.total) {
    console.log(`\n❌ 坏引用 ${missing.length} 个，超过基线 ${baseline.total}`)
    process.exit(1)
  }
  if (missing.length < baseline.total) {
    console.log(`\n✅ 坏引用 ${missing.length} 个（低于基线 ${baseline.total}——已修复，记得 --update 重采）`)
  } else {
    console.log(`\n✅ 坏引用 ${missing.length} 个，与基线一致，无新增`)
  }
  process.exit(0)
}

process.exit(missing.length > 0 ? 1 : 0)
