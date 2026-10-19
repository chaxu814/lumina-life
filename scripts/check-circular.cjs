#!/usr/bin/env node
// ============================================================
// scripts/check-circular.cjs — 运行时循环依赖棘轮门禁
//
// 【背景】2026-10-19 测评（P2-6）：ARCHITECTURE.md「已知技术债」
//   长期挂着「无 madge / dependency-cruiser 持续检测」。实测确认
//   默认配置下 electron/ + src/ 共 20 个环；剔除 type-only 边后
//   **13 个运行时环**（electron/ 13、src/ 0）。
//
// 【为什么这 13 个环现在还在，以及为什么"全修"不是本轮选项】
//   ① 它们绝大多数是「注册表 ↔ 消费者」结构：tools/index.ts 导入
//      全部 impl，而 impl（team/dynamicWorker/socialEngine…）又要
//      在运行时拿 AgentRunner/委托管理器——拿的方式是函数内惰性
//      单例（getDelegationManager/getAgentRunner），模块 init 期
//      不触碰对方绑定，所以当前 4,607 项测试与生产构建都是绿的。
//   ② 但循环依赖是**初始化顺序敏感**的脆弱结构：换入口（CLI/GUI/
//      API）、换打包器 chunk 顺序，都可能把"惰性"变成"init 期
//      undefined"——bundledRequires 测试已经为这类事故买过单。
//   ③ 一次拆 13 个环要动 agentRunner/delegationManager/tools 注册
//      表这三个最热的文件，风险与 agentRunner.ts 拆分同级。因此
//      采用与 lint 棘轮（scripts/lint-ratchet.cjs）同构的策略：
//      **基线锁存 + 只减不增 + --update 需在提交信息里说明**。
//
// 【口径】type-only 环不计入基线：编译后类型边被擦除，没有运行时
//   风险；把它们纳入会稀释真实信号（决策讨论见报告 6.1 节）。
//
// 用法：
//   node scripts/check-circular.cjs            # 门禁：出现新环 exit 1
//   node scripts/check-circular.cjs --report   # 打印现有环清单（含 type-only 标记）
//   node scripts/check-circular.cjs --update   # 重采基线（只应在拆环后使用）
// ============================================================

const fs = require('fs')
const path = require('path')
const madge = require('madge')

const ROOT = path.join(__dirname, '..')
const BASELINE_FILE = path.join(__dirname, 'circular-baseline.json')
const REPORT = process.argv.includes('--report')
const UPDATE = process.argv.includes('--update')
const TARGETS = ['electron', 'src']

// ⚠️ 历史教训：madge API 的正确选项名是 fileExtensions（不是 extensions）——
//    写错会让扫描退化成只查 .js 文件、得到假绿。改这个文件前先跑 --report 核对总数。
const OPTIONS = {
  fileExtensions: ['ts', 'tsx'],
  tsConfig: path.join(ROOT, 'tsconfig.json'),
  // type-only import 编译后不存在，不算运行时环（口径见文件头）
  detectiveOptions: { ts: { skipTypeImports: true } },
  baseDir: ROOT,
}

/** 把 madge 返回的环规范成可稳定比较的字符串（旋转对齐 + 排序） */
function normalizeCycle(cycle) {
  const rel = cycle.map((p) => path.relative(ROOT, p).split(path.sep).join('/'))
  // 旋转：让字典序最小的成员开头，消除"同一环不同起点"的误报
  let minIdx = 0
  for (let i = 1; i < rel.length; i++) {if (rel[i] < rel[minIdx]) {minIdx = i}}
  const rotated = rel.slice(minIdx).concat(rel.slice(0, minIdx))
  return rotated.join(' > ')
}

async function scanRuntime(dir) {
  const res = await madge(path.join(ROOT, dir), OPTIONS)
  return res.circular().map(normalizeCycle)
}

async function scanAll(dir) {
  const { detectiveOptions, ...loose } = OPTIONS
  const res = await madge(path.join(ROOT, dir), loose)
  return res.circular().map(normalizeCycle)
}

;(async () => {
  const runtime = {}
  for (const dir of TARGETS) {runtime[dir] = await scanRuntime(dir)}

  const currentCount = TARGETS.reduce((n, d) => n + runtime[d].length, 0)
  for (const dir of TARGETS) {
    console.log(`[check-circular] ${dir}/: 运行时环 ${runtime[dir].length}`)
    if (REPORT) {
      runtime[dir].forEach((c, i) => console.log(`   R${i + 1}) ${c}`))
      const typeOnly = (await scanAll(dir)).filter((c) => !runtime[dir].includes(c))
      if (typeOnly.length) {
        console.log(`   （另有 type-only 环 ${typeOnly.length} 个，不计入门禁）`)
        if (REPORT) {typeOnly.forEach((c, i) => console.log(`   T${i + 1}) ${c}`))}
      }
    }
  }

  // ── --update：重采基线 ──
  if (UPDATE) {
    const payload = {
      generatedBy: 'scripts/check-circular.cjs --update',
      note: '运行时循环依赖基线（type-only 不计）。门禁：不得新增环；拆环后请 --update 并说明。',
      baseline: runtime,
      count: currentCount,
    }
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(payload, null, 2) + '\n')
    console.log(`\n📝 基线已重采：${currentCount} 个环 → scripts/circular-baseline.json`)
    process.exit(0)
  }

  // ── 门禁：与基线比对 ──
  let baseline = { baseline: {}, count: 0 }
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'))
  } catch {
    console.error('❌ 缺少 scripts/circular-baseline.json，请先 --update 生成基线')
    process.exit(1)
  }

  const newCycles = []
  for (const dir of TARGETS) {
    const known = new Set(baseline.baseline?.[dir] || [])
    for (const c of runtime[dir]) {if (!known.has(c)) {newCycles.push(`${dir}/${c}`)}}
  }

  if (newCycles.length) {
    console.error(`\n❌ 发现 ${newCycles.length} 个新的运行时循环依赖（基线 ${baseline.count} → 当前 ${currentCount}）：`)
    for (const c of newCycles) {console.error(`   ${c}`)}
    console.error('   新增 import 造成环时，优先：依赖注入 / 类型下沉 / 函数内惰性单例。')
    console.error('   确认是有意重构后，用 --update 重采基线并在提交信息说明。')
    process.exit(1)
  }

  if (currentCount < baseline.count) {
    console.log(`\n✅ 运行时环 ${currentCount} 个（低于基线 ${baseline.count}——拆环见效，记得 --update 重采）`)
  } else {
    console.log(`\n✅ 运行时循环依赖 ${currentCount} 个，与基线一致，无新增`)
  }
  process.exit(0)
})().catch((err) => {
  console.error('[check-circular] 执行失败:', err.message)
  process.exit(1)
})
