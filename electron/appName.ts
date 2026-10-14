// ============================================================
// appName.ts — 锁定应用名（必须在所有其它模块之前执行）
//
// 【为什么单独一个文件】
// Electron 的 userData 目录名取自 app.getName()：
//   · dev（未打包）→ "Electron"      → %APPDATA%/Electron
//   · 打包版       → productName     → %APPDATA%/lumina-life
// 结果：同一个配置在两个目录各存一份、互相漂移 —— 用户感知是
// 「设置全没了 / 改了不生效 / 每次都要重新配一次模型」。
//
// 【为什么不能只在 main.ts 里写 app.setName()】
// ES 的 import 是**提升**的：main.ts 顶部所有 import 的模块体，
// 都会在 main.ts 第一行语句**之前**执行完。只要其中任何一个模块
// 在顶层调用了 app.getPath('userData')，目录名就被**提前锁死**，
// 之后再 setName 也来不及。
//
// 【正确做法】
// 把 setName 放进这个**零依赖**的小模块，并让 main.ts 把它作为
// **第一个 import**（`import './appName'`）—— 这样它在任何其它
// 模块加载之前执行，userData 目录名从此固定为 "Lumina Life"。
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import { APP_NAME, canonicalUserDataDir } from './core/userDataPath'

// ────────────────────────────────────────────────────────────
// 🛡️ 启动自检：Electron 必须真的以 GUI 模式运行
//
// 【为什么要这条】若环境里设了 `ELECTRON_RUN_AS_NODE`，electron.exe 会退化成
//   纯 Node，此时 `require('electron')` 返回的是**路径字符串**而不是 API，
//   `app` 就是 undefined。原始表现是一行让人看不懂的
//   `TypeError: Cannot read properties of undefined (reading 'setName')`，
//   排查成本极高。这里换成一句**可操作的**说明。
// ────────────────────────────────────────────────────────────
if (!app || typeof (app as any).setName !== 'function') {
  console.error(
    '\n[Lumina] ❌ 启动失败：Electron 没有以 GUI 模式运行。\n' +
    '  常见原因：环境变量 ELECTRON_RUN_AS_NODE 被设置（会让 electron.exe 退化成纯 Node）。\n' +
    '  解决办法：移除该变量后重启，例如在命令行执行：\n' +
    '    env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS npm run dev\n',
  )
  process.exit(1)
}

app.setName(APP_NAME)

// ────────────────────────────────────────────────────────────
// 🔒 显式锁定 userData 目录（2026-10-10）
//
// 【为什么 setName 不够】setName 只改「默认值的计算方式」；只要 Electron 在
//   改名之前**已经计算并缓存**过 userData（例如内部 session/cache 初始化），
//   之后再 setName 也**不会**改变已缓存的路径。
//   实测后果：%APPDATA%/Lumina Life **从未被创建**，配置一直漂在
//   %APPDATA%/lumina-life（有真实 key）与 %APPDATA%/Electron（空 key）两处 ——
//   启动时读到哪个目录取决于运行形态，用户感知就是「每次打开都要重新配模型」。
//
// 【为什么 setPath 能修好】setPath 是**显式覆盖**，直接写入路径值，能压过
//   默认值缓存。这样 dev 与打包版一定落在同一个目录，配置不再漂移。
//
// 【为什么放这里】本模块是 main.ts 的第一个 import，在任何其它模块碰
//   app.getPath('userData') 之前执行 —— 这是能最早锁定路径的位置。
// ────────────────────────────────────────────────────────────
try {
  const target = canonicalUserDataDir()
  fs.mkdirSync(target, { recursive: true })
  app.setPath('userData', target)
} catch { /* 锁定失败也不能阻止启动：退回到 setName 的默认行为 */ }
