#!/usr/bin/env node
// ============================================================
// lint-ratchet.cjs — ESLint 质量棘轮
//
// 【为什么需要它】
// 仓库里现有 5075 条 lint warning。清零不现实（要改 5000 处），
// 但 `--max-warnings 0` 之外又不能什么都不做 —— 否则门禁形同虚设，
// 明天有人新增 500 条 warning 也不会有人发现。
//
// 【棘轮机制】
//   1. 跑 eslint，拿到当前 warning / error 总数
//   2. 与 scripts/lint-baseline.json 里记录的基线比较
//   3. 比基线**多** → 失败，并打印多出来的部分（新增债务必须当场还）
//   4. 比基线**少** → 提示可以收紧基线（顺手更新 json 即可）
//
// 【基线怎么降】
// 每修掉一批 warning 就改小 .json 里的数字。数字只允许变小。
// 这样 lint 质量是单调递增的，而不是「反正有 5000 条摆烂了」。
//
// 用法：
//   node scripts/lint-ratchet.cjs            # 只检查
//   node scripts/lint-ratchet.cjs --update   # 有意收紧基线时显式更新
// ============================================================

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const BASELINE_FILE = path.join(__dirname, 'lint-baseline.json')
const shouldUpdate = process.argv.includes('--update')

function readBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) {
    return { warnings: Infinity, errors: 0, note: 'no baseline yet' }
  }
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
}

function runEslint() {
  let out = ''
  try {
    out = execSync('npx eslint . --format json', {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) {
    // eslint 在有 error 时 exit code 非 0，但 stdout 仍是完整 JSON
    out = e.stdout || ''
  }
  if (!out.trim()) {return { errors: 0, warnings: 0, files: [] }}
  let results
  try {
    results = JSON.parse(out)
  } catch {
    return { errors: 0, warnings: 0, files: [], parseFailed: true }
  }
  const files = results.filter(r => r.errorCount || r.warningCount)
  return {
    errors: files.reduce((s, r) => s + r.errorCount, 0),
    warnings: files.reduce((s, r) => s + r.warningCount, 0),
    files: files.map(r => ({
      file: path.relative(process.cwd(), r.filePath).replace(/\\/g, '/'),
      errors: r.errorCount,
      warnings: r.warningCount,
    })),
  }
}

const current = runEslint()
const baseline = readBaseline()

if (current.parseFailed) {
  console.error('[lint-ratchet] 无法解析 eslint 输出，按失败处理')
  process.exit(1)
}

console.log(`[lint-ratchet] 当前: ${current.errors} errors, ${current.warnings} warnings`)
console.log(`[lint-ratchet] 基线: ${baseline.errors} errors, ${baseline.warnings} warnings`)

if (shouldUpdate) {
  const next = {
    errors: current.errors,
    warnings: current.warnings,
    note: '基线只允许变小。修掉一批 lint 问题后跑 `node scripts/lint-ratchet.cjs --update` 收紧。',
    updatedAt: new Date().toISOString().slice(0, 10),
  }
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  console.log(`[lint-ratchet] 基线已更新 → ${JSON.stringify(next)}`)
  process.exit(current.errors > 0 ? 1 : 0)
}

const newErrors = current.errors - baseline.errors
const newWarnings = current.warnings - baseline.warnings

if (newErrors > 0) {
  console.error(`\n✗ eslint error 比基线多了 ${newErrors} 条 —— error 级规则（prefer-const / no-var）不允许新增。`)
  process.exit(1)
}
if (newWarnings > 0) {
  const worst = current.files
    .filter(f => f.warnings > 0)
    .sort((a, b) => b.warnings - a.warnings)
    .slice(0, 10)
  console.error(`\n✗ eslint warning 比基线多了 ${newWarnings} 条。新增的技术债必须当场还，`)
  console.error(`  或者在确实有正当理由时跑 --update 显式抬高基线（会留下记录）。`)
  console.error(`\n  当前 warning 最多的文件：`)
  for (const f of worst) { console.error(`    ${String(f.warnings).padStart(5)}  ${f.file}`) }
  process.exit(1)
}

const saved = baseline.warnings - current.warnings
if (saved > 0) {
  console.log(`\n✓ 比基线少 ${saved} 条 warning。跑 \`node scripts/lint-ratchet.cjs --update\` 收紧基线。`)
}
console.log('✓ lint 棘轮检查通过')
