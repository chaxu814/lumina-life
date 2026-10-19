// ============================================================
// scripts/electron-postinstall.cjs
//
// 安装依赖后，把原生模块（better-sqlite3 等）重新编译/对齐到当前 Electron ABI。
// 这样「打包的 App」与「开发运行」始终用对原生模块；onnxruntime-node / sharp 是
// NAPI 预编译（ABI 无关），不受影响。
//
// 失败不致命：CI 会在打包阶段显式 rebuild，纯 Node 跑测试也对 better-sqlite3 做了
// 优雅降级，所以这里任何异常都只告警、不阻断 npm install（进程始终 exit 0）。
//
// v0.3 修正（2026-10-20）：
//   旧版「.node 文件存在即跳过」的判定是错的：npm ci 后 better-sqlite3 必然
//   带一份 Node ABI 的预编译件，导致 Electron 永远加载失败、记忆系统静默降级
//   （冒烟测试实测：fresh clone 的 doctor 报「记忆系统 Cannot find module」）。
//   现改为 dlopen 实测 ABI：能加载=Node ABI（需重编），版本不匹配=已对齐（跳过）。
//   CI 测试 job 可设 LUMINA_NATIVE_ABI=node 保留 Node ABI。
//
// v0.2 增强：
//   1) 先探测 better-sqlite3 是否已有预编译/已编译好的 .node——有就直接跳过，
//      避免在没装 C/C++ 工具链的机器上白白触发 node-gyp 编译而报错刷屏。
//   2) 对齐失败时按当前操作系统给出「可操作」的工具链安装指引，
//      而不是把晦涩的 node-gyp 堆栈丢给用户。
//   3) 同时给出降级提示：原生模块缺失时桌面陪伴核心仍可用，仅记忆/语音等功能降级。
// ============================================================
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/** 按当前平台返回原生编译所需工具链的中文指引 */
function toolchainHint() {
  const p = process.platform
  if (p === 'win32') {
    return [
      '  · 安装 Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」工作负载）',
      '    https://visualstudio.microsoft.com/visual-cpp-build-tools/',
      '  · 并安装 Python 3.10+（node-gyp 需要）：https://www.python.org/downloads/',
      '    （或一条命令装齐旧版：npm install --global windows-build-tools，需管理员 PowerShell）',
      '  · 装好后重新运行：npm run rebuild:electron',
    ].join('\n')
  }
  if (p === 'darwin') {
    return [
      '  · 安装 Xcode 命令行工具：xcode-select --install',
      '  · 确认 Python 3 可用：python3 --version',
      '  · 装好后重新运行：npm run rebuild:electron',
    ].join('\n')
  }
  // linux
  return [
    '  · 安装编译工具链与 Python 3（Debian/Ubuntu）：sudo apt install build-essential python3 make',
    '  · Fedora/RHEL：sudo dnf groupinstall "Development Tools" && sudo dnf install python3',
    '  · 装好后重新运行：npm run rebuild:electron',
  ].join('\n')
}

/** 列出本项目关心的原生模块及其预编译产物相对路径（相对 node_modules） */
function nativeTargets() {
  return [
    { name: 'better-sqlite3', rel: path.join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node') },
  ]
}

/**
 * 探测单个 .node 的 ABI 归属。
 *
 * 【为什么不能只看文件存在】2026-10-20 冒烟测试实测：fresh clone 跑完
 * npm ci 后 better-sqlite3 的 build/Release/better_sqlite3.node 一定存在
 * （better-sqlite3 自己的 install 脚本会装 Node ABI 的预编译件），
 * 于是旧版「存在即跳过」的判断永远成立 → Electron 永远加载不了它 →
 * 记忆系统静默降级。判定依据改为**实际 dlopen**：
 *   · 在 Node 下能加载 → 这是 Node ABI，对 Electron 是错的 → 需要 rebuild
 *   · 在 Node 下报 NODE_MODULE_VERSION 不匹配 → 已按 Electron ABI 编译 → 就绪
 */
function probeAbi(absPath) {
  try {
    process.dlopen({ exports: {} }, absPath)
    return { exists: true, nodeAbi: true, electronAligned: false, detail: 'Node ABI（需为 Electron 重编）' }
  } catch (err) {
    const msg = String((err && err.message) || err)
    if (/NODE_MODULE_VERSION|different Node\.js version|compiled against a different/i.test(msg)) {
      return { exists: true, nodeAbi: false, electronAligned: true, detail: 'Electron ABI（已对齐）' }
    }
    // 其他加载错误（缺 DLL/权限等）：保守视为未对齐，交给 rebuild 尝试修复
    return { exists: true, nodeAbi: false, electronAligned: false, detail: msg.slice(0, 120) }
  }
}

/** 检查每个原生模块是否已按 Electron ABI 就绪；返回 { ok, missing, details } */
function detectPrebuilt() {
  const nm = path.join(process.cwd(), 'node_modules')
  const missing = []
  const details = []
  for (const t of nativeTargets()) {
    const abs = path.join(nm, t.rel)
    if (!fs.existsSync(abs)) {
      missing.push(t.name + '（文件缺失）')
      continue
    }
    const probe = probeAbi(abs)
    details.push(`${t.name}: ${probe.detail}`)
    if (!probe.electronAligned) {
      missing.push(t.name + '（' + probe.detail + '）')
    }
  }
  return { ok: missing.length === 0, missing, details }
}

function main() {
  // 显式要求跳过（如只做纯 Node 环境的最小安装）时直接退出
  if (process.env.LUMINA_SKIP_REBUILD === '1') {
    console.log('[postinstall] LUMINA_SKIP_REBUILD=1，跳过原生模块 Electron 对齐')
    return
  }
  // 明确声明本机以 Node 运行（CI 测试 job / 纯 vitest 环境）：保留 Node ABI，
  // 否则重编成 Electron ABI 后 Node 测试只能走 JSON 兜底，原生路径失去覆盖。
  if (process.env.LUMINA_NATIVE_ABI === 'node') {
    console.log('[postinstall] LUMINA_NATIVE_ABI=node，保留 Node ABI（适用于 CI 测试 / 纯 Node 运行）')
    return
  }

  // 1) 按 ABI 探测：只有**确认已按 Electron 编译**才跳过。
  //    仅判断文件存在是错的——npm ci 后 Node ABI 预编译件必然存在（见 probeAbi 注释）。
  const pre = detectPrebuilt()
  if (pre.details && pre.details.length) {
    for (const d of pre.details) console.log('[postinstall]   · ' + d)
  }
  if (pre.ok) {
    console.log('[postinstall] ✔ 原生模块已按 Electron ABI 对齐，跳过重编')
    return
  }
  console.log('[postinstall] 原生模块需对齐到 Electron ABI：', pre.missing.join('; '))

  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'npx.cmd' : 'npx'
  const args = ['electron-builder', 'install-app-deps']
  console.log('[postinstall] 运行：', cmd, args.join(' '))
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false })
  if (r.status !== 0) {
    console.warn('\n[postinstall] ⚠ 原生模块自动对齐未完成（不阻断本次安装，但桌面运行前需修复）：')
    console.warn('  最常见原因：本机缺少 C/C++ 编译工具链或 Python 3。请按以下步骤准备后重跑：\n')
    console.warn(toolchainHint())
    console.warn('\n  降级方案：如果暂时只想体验核心功能，原生模块缺失时记忆/语音等')
    console.warn('  功能会自动降级，但桌面陪伴本体仍然可用，不影响先跑起来看看。')
    console.warn('\n  详细排查见 docs/TROUBLESHOOTING.md「原生依赖编译失败」。\n')
  } else {
    console.log('[postinstall] ✔ 原生模块 Electron 对齐完成')
  }
}

try {
  main()
} catch (e) {
  console.warn('[postinstall] 跳过原生模块对齐：', e && e.message ? e.message : e)
} finally {
  // 关键：无论成功失败都以 exit 0 结束，不要让原生模块编译失败阻塞整个 npm install。
  // 核心 JS 依赖此时已装好；原生模块缺失走运行时优雅降级。
  process.exit(0)
}
