// ============================================================
// core/pathsFallback.ts — app 未就绪时的安全路径兜底
// ============================================================
//
// 【要解决的问题】
// 本项目里大量模块在取不到 `app.getPath('userData')` 时退回 `process.cwd()`。
// 开发模式下 cwd == **项目根目录**，于是「取不到就退回」的副作用是：
// 把 lumina-quests.json / async-tasks.json / news-fingerprints.json / usage-stats.json
// / feature-flags.json … 一堆运行时状态直接写进 Git 工作区。
//
// 这不是洁癖问题，是真实后果：
//   1. 污染仓库，`git status` 一片脏，发布前很难看清哪些是真改动
//   2. 打包时 cwd 可能是只读或意外目录，状态就写丢了
//   3. 2026-10-03 发布审计时，根目录那些 .json 就是这么来的
//
// 【为什么不改那 20+ 个调用点】
// 逐个改风险大（容易漏），而且以后新加的模块还会再犯。
// 这里给出统一出口，改造时按模块替换即可；旧的调用点保持可用。
//
// 【核心原则】
// app 不可用时，状态文件应该去**系统临时目录**，而不是用户的代码仓库。
// 状态丢了顶多重来一次；往仓库里写文件是污染，不可接受。
// ============================================================

import * as os from 'os'
import * as path from 'path'

/** 拿到一个一定可写的、且不在项目里的基目录 */
export function safeFallbackBase(): string {
  try {
    return os.tmpdir()
  } catch {
    // os.tmpdir() 极少失败；再兜一层到系统根下的临时语义目录
    return process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp'
  }
}

/** 取 userData 风格的状态文件路径；app 未就绪时落到临时目录 */
export function stateFilePath(fileName: string): string {
  try {
    // 延迟 require：避免在 Electron 之外（如 vitest）加载时炸掉
     
    const electron = require('electron')
    const app = electron?.app
    if (app && typeof app.getPath === 'function') {
      const dir = app.getPath('userData')
      if (dir) {return path.join(dir, fileName)}
    }
  } catch { /* Electron 之外运行环境 / app 未就绪 */ }
  return path.join(safeFallbackBase(), fileName)
}

/**
 * 供文档与 code review 使用的说明（避免有人再写回 process.cwd()）
 */
export const FALLBACK_POLICY = [
  'app.getPath("userData") 可用 → 用它（打包后与开发态统一）',
  'app 不可用（模块顶层初始化 / vitest / CLI） → os.tmpdir()',
  '❌ 永远不要退回 process.cwd()：开发态 cwd 就是项目根，会把状态写进 Git 工作区',
].join('\n')
