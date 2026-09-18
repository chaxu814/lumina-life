// ============================================================
// scripts/electron-postinstall.cjs
//
// 安装依赖后，把原生模块（better-sqlite3 等）重新编译/对齐到当前 Electron ABI。
// 这样「打包的 App」与「开发运行」始终用对原生模块；onnxruntime-node / sharp 是
// NAPI 预编译（ABI 无关），不受影响。
//
// 失败不致命：CI 会在打包阶段显式 rebuild，纯 Node 跑测试也对 better-sqlite3 做了
// 优雅降级，所以这里任何异常都只告警、不阻断 npm install。
// ============================================================
const { spawnSync } = require('child_process')

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
    console.warn('[postinstall] 自动对齐未完成（不影响后续；可手动运行 npm run rebuild:electron）')
  }
}

try {
  main()
} catch (e) {
  console.warn('[postinstall] 跳过原生模块对齐：', e && e.message ? e.message : e)
}
