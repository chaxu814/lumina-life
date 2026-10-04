#!/usr/bin/env node
/**
 * bundle-requires-gate.cjs — 打包产物断链门禁
 *
 * 【为什么要有这道门】
 * 2026-10-04 对 out/main/index.js 做体检，发现 **68 条运行时相对 require 指向不存在的路径**。
 * 根因是「为断循环依赖而写的运行时 require」在 electron-vite 扁平化打包后必然失效：
 * 模块已经被打进同一个文件了，那个字符串路径却还在。
 *
 * 这类故障的杀伤力在于它**不会让构建失败，也不会让测试失败**：
 *   · dev 模式能解析 → 一切正常
 *   · 187 个单测跑在源码上 → 一切正常
 *   · 只有用户拿到安装包 → 某个功能莫名其妙不好使
 * 已知实例：require('./agentConfig').getConfig() 双重错误（模块无此导出 + 路径不存在），
 * 被 catch 吞掉后「情绪门控」开关**从未生效过**，而 UI 上它是给用户看的。
 *
 * 【门禁策略：棘轮】
 * 历史断链不可能一次清完（有些是真循环，必须双向登记才能解）。
 * 所以：已知的记进 baseline，新增的直接让 CI 红。
 * 与 scripts/lint-ratchet.cjs 同一个思路 —— 门禁的价值是拦住**真新增**。
 *
 * 用法：
 *   node scripts/bundle-requires-gate.cjs            # 比对基线，有新增则退出码 1
 *   node scripts/bundle-requires-gate.cjs --update   # 重新采集基线
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const BUNDLE = 'out/main/index.js'
const BASELINE = path.join(root, 'scripts', 'bundle-requires-baseline.json')
const REL = /require\(\s*["'](\.[^"']+)["']\s*\)/g

/** 已知的、**经过人工判断为可接受**的断链。
 *  每条都必须写明理由 —— 「不知道」不是理由。 */
const ACCEPTED = {
  // 这两条 catch 是**故意**的：agentOrchestrator 与 delegationManager 互相静态 import，
  // 运行时 require 正是为了断环。解法是双向登记（registerDelegationManagerInstance），
  // 失败后 fallback 到已登记的同一个实例，runners 不会丢。
  // 详见 delegationManager.ts 1299-1342 的注释。
  './core/agentOrchestrator': '有意 catch：与 DelegationManager 成环，靠双向登记解，已在 delegationManager.ts:1299 写明',
}

function scan() {
  const file = path.join(root, BUNDLE)
  if (!fs.existsSync(file)) {
    console.error(`❌ 找不到构建产物 ${BUNDLE}。请先执行 npm run build。`)
    process.exit(2)
  }
  const src = fs.readFileSync(file, 'utf8')
  const baseDir = path.dirname(file)
  const found = new Set()
  let m
  REL.lastIndex = 0
  while ((m = REL.exec(src)) !== null) {
    const spec = m[1]
    const target = path.resolve(baseDir, spec)
    if (fs.existsSync(target) || fs.existsSync(`${target}.js`) || fs.existsSync(path.join(target, 'index.js'))) {
      continue
    }
    found.add(spec)
  }
  return found
}

const current = scan()

if (process.argv.includes('--update')) {
  fs.writeFileSync(BASELINE, JSON.stringify({
    updatedAt: new Date().toISOString().slice(0, 10),
    total: current.size,
    accepted: ACCEPTED,
    specs: [...current].sort(),
  }, null, 2) + '\n')
  console.log(`✅ 基线已更新：${current.size} 条`)
  process.exit(0)
}

let baseline = { specs: [] }
if (fs.existsSync(BASELINE)) {
  try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) } catch { /* 基线损坏按空处理 */ }
}
const known = new Set(baseline.specs || [])

const added = [...current].filter(s => !known.has(s)).sort()
const removed = [...known].filter(s => !current.has(s)).sort()

console.log(`断链总数 ${current.size}（基线 ${known.size}）`)
if (removed.length) {
  console.log(`\n✅ 已修复 ${removed.length} 条（建议收紧基线：npm run ... --update）：`)
  removed.forEach(s => console.log(`   ${s}`))
}
if (added.length) {
  console.log(`\n❌ 新增 ${added.length} 条断链 —— 这些在 dev 与单测里都是好的，只有安装包会坏：`)
  added.forEach(s => {
    const why = ACCEPTED[s]
    console.log(`   ${s}${why ? `\n      已登记理由：${why}` : ''}`)
  })
  console.log('\n修法：')
  console.log('  · 不构成循环依赖 → 改成静态 import（最常见，且最安全）')
  console.log('  · 真构成循环 → 改双向登记（见 delegationManager.ts:1299 的做法）')
  console.log('  · 确认可接受 → 写进本脚本的 ACCEPTED 并注明理由')
  process.exit(1)
}
console.log('\n✅ 无新增断链')
process.exit(0)
