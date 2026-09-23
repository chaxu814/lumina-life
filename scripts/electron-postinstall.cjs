// ============================================================
// scripts/electron-postinstall.cjs
//
// 安装依赖后，把原生模块（better-sqlite3 等）重新编译/对齐到当前 Electron ABI。
// 这样「打包的 App」与「开发运行」始终用对原生模块；onnxruntime-node / sharp 是
// NAPI 预编译（ABI 无关），不受影响。
//
// 失败不致命：CI 会在打包阶段显式 rebuild，纯 Node 跑测试也对 better-sqlite3 做了
// 优雅降级，所以这里任何异常都只告警、不阻断 npm install。
//
// v0.2 增强：对齐失败时按当前操作系统给出「可操作」的工具链安装指引，
// 而不是把晦涩的 node-gyp 堆栈丢给用户。
// ============================================================
const { spawnSync } = require('child_process')

/** 按当前平台返回原生编译所需工具链的中文指引 */
function toolchainHint() {
  const p = process.platform
  if (p === 'win32') {
    return [
      '  · 安装 Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」工作负载）',
      '    https://visualstudio.microsoft.com/visual-cpp-build-tools/',
      '  · 并安装 LTS 版 Python 3（node-gyp 需要）：https://www.python.org/downloads/',
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

function main() {
  // 显式要求跳过（如只做纯 Node 环境的最小安装）时直接退出
  if (process.env.LUMINA_SKIP_REBUILD === '1') {
    console.log('[postinstall] LUMINA_SKIP_REBUILD=1，跳过原生模块 Electron 对齐')
    return
  }
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'npx.cmd' : 'npx'
  const args = ['electron-builder', 'install-app-deps']
  console.log('[postinstall] 对齐原生模块到 Electron ABI：', cmd, args.join(' '))
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false })
  if (r.status !== 0) {
    console.warn('\n[postinstall] ⚠ 原生模块自动对齐未完成（不阻断本次安装，但桌面运行前需修复）：')
    console.warn('  最常见原因：本机缺少 C/C++ 编译工具链或 Python 3。请按以下步骤准备后重跑：\n')
    console.warn(toolchainHint())
    console.warn('\n  详细排查见 docs/TROUBLESHOOTING.md「原生依赖编译失败」。\n')
  }
}

try {
  main()
} catch (e) {
  console.warn('[postinstall] 跳过原生模块对齐：', e && e.message ? e.message : e)
}
