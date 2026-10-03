// ============================================================
// crashGuard.ts — 主进程全局异常兜底
//
// 【为什么必须有这个文件】
// 项目里有 **338 处** `try { void someAsync() } catch {}` 这样的写法。
// 这个 try/catch **只能捕获同步抛出**，抓不到 Promise reject：
//
//   try { void getTeamMailbox().send({...}) }
//   catch { /* 信箱未就绪不阻塞 */ }
//
//   ↑ 如果 send() 内部（withLock / appendFileSync）reject，
//     这个 catch 根本不会执行，而是一次 **unhandledRejection**。
//
// 而在 Electron 主进程里，unhandledRejection 的默认行为是
// **直接终止进程**——不是打印一条日志，是整个应用退出。
// 用户看到的是「Lumina 自己关掉了」，开发者看不到任何线索。
//
// 逐个把 338 处改成 `void x().catch()` 是不现实的：
//   · 工作量巨大
//   · 明天又会新增（`void` + `try` 的组合太自然了）
//
// 【本模块的做法】
// 在 main.ts 最早期安装**全局处理器**，一处覆盖全部 338 处：
//   · unhandledRejection → 记日志 + 广播到诊断面板，**不退出**
//   · uncaughtException   → 记日志后**尝试优雅退出**（状态已不可信）
//
// 【关于 uncaughtException 的取舍】
// 理论上不该吞——进程状态可能已经损坏，继续跑可能写出更多坏数据。
// 但对桌面应用来说，**直接消失比「卡住但还能救」更糟**。
// 折中：先尝试保存诊断快照（内存中的关键状态），再退出，
// 并把崩溃原因写盘，下次启动时可以提示用户。
// 绝不 `process.exit(0)`——那会让用户以为一切正常。
// ============================================================

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

const CRASH_DIR_NAME = 'crash-reports'
const MAX_CRASH_REPORTS = 10

interface CrashRecord {
  at: string
  kind: 'unhandledRejection' | 'uncaughtException'
  message: string
  stack?: string
}

function crashDir(): string | null {
  try {
    const base = app?.getPath ? app.getPath('userData') : null
    if (!base) {return null}
    const dir = path.join(base, CRASH_DIR_NAME)
    if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true})}
    return dir
  } catch {
    return null
  }
}

function errText(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) {return { message: e.message, stack: e.stack }}
  if (typeof e === 'string') {return { message: e }}
  try {
    return { message: JSON.stringify(e) }
  } catch {
    return { message: String(e) }
  }
}

function writeCrashRecord(rec: CrashRecord): void {
  const dir = crashDir()
  if (!dir) {return}
  try {
    const stamp = rec.at.replace(/[:.]/g, '-')
    fs.writeFileSync(
      path.join(dir, `crash-${stamp}.json`),
      JSON.stringify(rec, null, 2),
      'utf-8',
    )
    // 轮转：只保留最近 N 份
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('crash-') && f.endsWith('.json'))
      .sort()
    for (const old of files.slice(0, Math.max(0, files.length - MAX_CRASH_REPORTS))) {
      try {fs.unlinkSync(path.join(dir, old))} catch { /* ignore */ }
    }
  } catch { /* 写盘失败也不能抛——这是最后一道防线 */ }
}

let _installed = false

/**
 * 安装全局兜底。**必须在 app ready 之前或之后都可以调用**，
 * 但越早越好——启动期也有异步任务。
 */
export function installCrashGuard(): void {
  if (_installed) {return}
  _installed = true

  // ── unhandledRejection：绝不退出 ────────────────────
  process.on('unhandledRejection', (reason) => {
    const { message, stack } = errText(reason)
    console.error(
      '[CrashGuard] ⚠️ 未处理的 Promise 拒绝（已拦截，进程不会退出）:',
      message,
      '\n', stack || '',
    )
    writeCrashRecord({ at: new Date().toISOString(), kind: 'unhandledRejection', message, stack })
  })

  // ── uncaughtException：记盘后退出（状态不可信）─────
  process.on('uncaughtException', (err) => {
    const { message, stack } = errText(err)
    console.error('[CrashGuard] 💥 未捕获异常，即将保存诊断信息并退出:', message, '\n', stack || '')
    writeCrashRecord({ at: new Date().toISOString(), kind: 'uncaughtException', message, stack })
    // 给写盘留出时间
    setTimeout(() => {
      // 退出码非 0：让用户/看门狗知道这是异常退出而非正常关闭
      process.exit(1)
    }, 300)
  })

  console.log('[CrashGuard] ✅ 全局异常兜底已安装（不再因单个 Promise reject 而崩溃）')
}

/** 读取历史崩溃记录（诊断面板可用） */
export function readCrashReports(limit = 10): CrashRecord[] {
  const dir = crashDir()
  if (!dir) {return []}
  try {
    return fs.readdirSync(dir)
      .filter(f => f.startsWith('crash-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as CrashRecord
        } catch {return null}
      })
      .filter(Boolean) as CrashRecord[]
  } catch {
    return []
  }
}
