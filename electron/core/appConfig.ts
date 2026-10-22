// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// core/appConfig.ts — 主配置（lumina-config.json）读取的单一入口
//
// 【为什么需要它】
// 2026-10-04 打包产物体检发现两处真实故障：
//
//   theaterBridge.ts:
//     const { getConfig } = require('./agentConfig')   // ← 运行时 require
//     const cfg: any = getConfig()                      // ← getConfig 根本不存在
//
//   agentRunner.ts:
//     const { getConfig } = require('./agentConfig')    // ← 同上
//
// 三个问题叠在一起：
//   1. `require('./agentConfig')` 在**打包后必然失败**（模块被压平进 out/main/index.js，
//      相对路径不存在）。dev 模式能解析，所以 187 个测试全绿也看不出来。
//   2. 即便解析成功，`agentConfig.ts` 也**只导出 getAgentConfig / initAgentConfig**，
//      没有 getConfig —— 解构出来是 undefined，调用即 TypeError。
//   3. 两处都被 `catch {}` 吞掉，于是 `features.theater` / `features.emotionGating`
//      **永远读到 undefined**，等于这两个用户开关从未生效过 —— 而 UI 上是给用户看的。
//
// 第 3 点最严重：不是崩溃，是**静默失效**。用户关了「情绪门控」，系统照常收紧工具。
//
// 【本模块的职责边界】
// 只负责「安全地把主配置读成对象」，不解释业务语义。
// 读取失败一律返回空对象 —— 让调用方走各自的默认值，而不是让整条链路挂掉。
// ============================================================

import * as fs from 'fs'
import { stateFilePath } from './pathsFallback'

const CONFIG_FILE = 'lumina-config.json'

/** 读取结果缓存，避免每轮对话都打一次磁盘 */
let _cache: { at: number; data: Record<string, unknown> } | null = null
/** 缓存有效期。configWatcher 有热重载，但那是另一条链路；这里给个短 TTL 兜底 */
const TTL_MS = 2000

/**
 * 读主配置。任何异常（文件不存在、JSON 损坏、权限不足）都退化为空对象。
 *
 * 【为什么不抛错】
 * 配置读不到是一个**可降级**状态，不是一个致命状态 ——
 * 项目里 configCorruptionGuard.test.ts 已经确立了「配置坏了要能用默认值启动」的契约。
 * 在这里抛错会把一个降级问题升级成启动失败。
 */
export function readAppConfig(): Record<string, unknown> {
  const now = Date.now()
  if (_cache && now - _cache.at < TTL_MS) {return _cache.data}
  let data: Record<string, unknown> = {}
  try {
    const p = stateFilePath(CONFIG_FILE)
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      // 只接受对象：JSON 可能是数组或标量，那不是配置
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>
      }
    }
  } catch {
    data = {}
  }
  _cache = { at: now, data }
  return data
}

/** 强制下次读取落盘（配置写入方调用，避免写完立刻读到旧值） */
export function invalidateAppConfigCache(): void {
  _cache = null
}

/**
 * 读一个布尔功能开关。
 *
 * 语义与项目其余部分一致：**键缺失 = 默认开**，只有显式 `false` 才关。
 * 原因见 memoryIpc.ts 的 CONFIG_DEFAULTS 注释 —— 「界面显示开着但实际不工作」
 * 是最糟的一类 bug，所以默认值必须写死在一处，而不是靠各处 `=== true` 判空。
 */
export function readFeatureFlag(key: string, defaultOn = true): boolean {
  const features = readAppConfig().features
  if (!features || typeof features !== 'object') {return defaultOn}
  const v = (features as Record<string, unknown>)[key]
  if (v === undefined || v === null) {return defaultOn}
  return v !== false
}
