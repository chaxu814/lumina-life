// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// registrationFlag.ts — 工具注册标志位（零依赖叶子模块）
//
// 【为什么需要这个文件】
// 历史上 `let _registered` 直接放在 tools/index.ts 里，而
// `electron/agentRunner.ts` 在**模块顶层**调用 registerAllTools()。
// 依赖链是：
//     tools/index.ts ──import──> impl/* ──> asyncTaskManager.ts
//                    ──import──> agentRunner.ts:111 registerAllTools()
//                                              │
//                     读 _registered ─────────>  tools/index.ts:200
//
// 当 agentRunner 先被求值时，tools/index.ts 的函数体还没执行到
// 第 196 行的 `let _registered`，于是抛出：
//     ReferenceError: Cannot access '_registered' before initialization
//
// 生产环境之所以没炸，纯粹是因为 main.ts 的 import 顺序碰巧对了。
// 任何外部贡献者调整一次 import 顺序（或写一个从 agentRunner
// 入口 import 的测试）就会踩到 —— 这正是 CI 之外最容易复发的那类雷。
//
// 【修法】
// 把标志位移进一个**没有任何 import** 的叶子模块。叶子模块一定先于
// 依赖它的模块完成求值，读取时不可能落在 TDZ。
// 调用点一处都不用挪，行为完全不变。
// ============================================================

let _registered = false

export function isToolsRegistered(): boolean {
  return _registered
}

/** 首次调用返回 true（拿到「注册权」），之后一律 false。
 *  用 CAS 语义代替原来的 `if (x) return; x = true`，避免两个调用方
 *  同时进入注册流程导致工具被重复注册。 */
export function claimToolsRegistration(): boolean {
  if (_registered) {return false}
  _registered = true
  return true
}

/** 仅测试用：重置标志位（配合 vi.resetModules） */
export function __resetToolsRegistrationForTest(): void {
  _registered = false
}
