// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/cli-entry.ts — CLI 构建入口 (给 electron-vite 用)
//
// electron-vite 会把此文件编译到 out/cli-entry/index.js
// 然后通过 electron out/cli-entry/index.js <args> 运行
// ============================================================

// 告诉 Electron 这是 headless 模式
process.env.LUMINA_CLI_MODE = '1'

import { app } from 'electron'

app.whenReady().then(async () => {
  // 动态导入 CLI 主模块
  const { default: runCLI } = await import('./cli/index')
  await runCLI(process.argv)
  app.quit()
})

export {}
