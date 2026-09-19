// ============================================================
// services/loopEngine.ts — Lumina Loop 引擎 (Phase 1)
//
// 对标智谱清言「Loop 任务」：
//   动态拆解 → 跨 Session 持久追踪 → 自动感知触发 → 循环执行
//
// 四大关键机制：
//   1. 动态任务拆解：LLM 把 OKR 目标拆成子任务链 + 执行策略 + 建议触发器
//   2. 跨 Session 持久追踪：进度写入持久化后端（默认 localStorage），重启恢复
//   3. 自动感知触发：interval / cron / message / api_event 多维触发
//   4. 循环执行：感知 → 拆解 → 执行 → 修正 → 再感知，无需用户催促
//
// 用法（Phase 2 UI 接入后）：
//   const engine = new LoopEngine({ onChanged })
//   await engine.init()
//   await engine.createLoop('每天收盘后盯盘并给出次日操作建议')
//   await engine.confirmLoop(loop.id)
// ============================================================

import type {
  LoopTask,
  LoopTrigger,
  SubTask,
  LoopSubtaskResult,
  Decomposition,
  LoopRunLog,
} from './loopTypes'
import {
  localStorageBackend,
  cronMatches,
  genId,
  extractJson,
  type LoopPersistenceBackend,
} from './loopPersist'
import type { LLMConfig } from '../stores/appStore'
// 动态读取当前 LLM 配置；appStore 不依赖本模块，无循环依赖
import { useStore as useStoreRef } from '../stores/appStore'

// ═══════════════════════════════════════════════════════════
// 对外类型
// ═══════════════════════════════════════════════════════════

/** 子任务执行器：真正跑外部动作（搜索/写文件/发消息等）的钩子 */
export type LoopExecutor = (
  subtask: SubTask,
  loop: LoopTask,
) => Promise<LoopSubtaskResult>

export interface LoopEngineOptions {
  /** 获取当前 LLM 配置（用于动态拆解）。缺省时从 appStore 读取 */
  getLLMConfig?: () => LLMConfig | undefined
  /** 持久化后端（默认 localStorage） */
  persistence?: LoopPersistenceBackend
  /** 子任务执行器（默认：仅记录到产出，不真正跑外部动作） */
  executor?: LoopExecutor
  /** 触发检查间隔 ms（默认 30_000，与主进程 cron 节奏一致） */
  checkIntervalMs?: number
  /** 状态变更回调（UI store 订阅用） */
  onChanged?: (tasks: LoopTask[]) => void
  /** 每轮循环完成后的回调（被动确认模式：UI 据此推送轻量通知） */
  onCycleComplete?: (loop: LoopTask) => void
}

// ═══════════════════════════════════════════════════════════
// 引擎实现
// ═══════════════════════════════════════════════════════════

export class LoopEngine {
  private tasks: LoopTask[] = []
  private opts: LoopEngineOptions
  private persistence: LoopPersistenceBackend
  private timer: ReturnType<typeof setInterval> | null = null
  private cronCleanup: (() => void) | null = null
  /** 正在执行循环的 loopId 集合（防止并发重复触发） */
  private runningLoops = new Set<string>()
  /** cron 分钟级防重 key：`${loopId}:${triggerId}` → "HH:MM" */
  private lastCronHit = new Map<string, string>()

  constructor(opts: LoopEngineOptions = {}) {
    this.opts = opts
    this.persistence = opts.persistence ?? localStorageBackend
  }

  // ── 生命周期 ─────────────────────────────────────────────

  /** 初始化：加载持久化任务 + 启动触发检查 + 监听主进程 cron 事件 */
  async init(): Promise<void> {
    const restored = await this.persistence.load()
    // 跨 Session 恢复：把上次运行中的 Loop 置为「已恢复，待继续」，
    // 避免应用启动后立即自动执行（安全默认）
    for (const t of restored) {
      if (t.status === 'running') {
        t.status = 'paused'
        t.logs = t.logs || []
        t.logs.push({ time: Date.now(), event: 'restore', detail: '已从上次会话恢复，等待继续' })
      }
    }
    this.tasks = this.normalizeTasks(restored)
    this.emit()

    const intervalMs = this.opts.checkIntervalMs ?? 30_000
    this.timer = setInterval(() => this.checkTriggers(new Date()), intervalMs)

    // 复用主进程 cron 引擎：cron:triggered 事件 → 按名称/调度匹配 Loop
    try {
      this.cronCleanup = window.luminaAPI?.onMenuEvent?.('cron:triggered', (data: any) => {
        this.onExternalCronTrigger(data)
      }) ?? null
    } catch {
      this.cronCleanup = null
    }

    console.log(`[LoopEngine] 已启动 · 恢复 ${this.tasks.length} 个 Loop · 检查间隔 ${intervalMs / 1000}s`)
  }

  /** 停止引擎（应用退出/清理时调用） */
  dispose(): void {
    if (this.timer) {clearInterval(this.timer)}
    this.timer = null
    if (this.cronCleanup) {this.cronCleanup()}
    this.cronCleanup = null
  }

  /** 运行时注入真实 executor（构造后、init 前后均可调用） */
  setExecutor(executor: LoopExecutor): void {
    this.opts.executor = executor
  }

  // ── 查询 ─────────────────────────────────────────────

  getTasks(): LoopTask[] {
    return [...this.tasks]
  }

  getLoop(id: string): LoopTask | undefined {
    return this.tasks.find(t => t.id === id)
  }

  getActiveCount(): number {
    return this.tasks.filter(t => t.status === 'running').length
  }

  // ── 创建 & 动态拆解 ─────────────────────────────────────

  /** 创建 Loop：先进入 configuring，LLM 拆解后进入 reviewing 等用户确认 */
  async createLoop(
    goal: string,
    opts?: { agentId?: string; suggestedTriggers?: LoopTrigger[] },
  ): Promise<LoopTask | null> {
    const trimmed = (goal || '').trim()
    if (!trimmed) {return null}

    const now = Date.now()
    const id = genId('loop')
    const loop: LoopTask = {
      id,
      goal: trimmed,
      strategy: '',
      subtasks: [],
      triggers: opts?.suggestedTriggers ?? [],
      progress: {
        completed: [],
        current: null,
        persistenceKey: `${id}-progress`,
        history: [],
      },
      status: 'configuring',
      createdAt: now,
      outputs: [],
      runCount: 0,
      logs: [{ time: now, event: 'create', detail: `目标：${trimmed}` }],
      agentId: opts?.agentId,
    }
    this.tasks.push(loop)
    await this.persist()
    this.emit()

    // 动态拆解
    const decomposed = await this.decompose(goal)
    if (decomposed) {
      loop.strategy = decomposed.strategy
      loop.subtasks = decomposed.subtasks.map((s, i) => ({
        id: genId('st'),
        title: s.title,
        description: s.description,
        status: 'pending',
        retryCount: 0,
        maxRetries: 2,
      }))
      if (decomposed.trigger && loop.triggers.length === 0) {
        loop.triggers = this.buildTriggers(decomposed.trigger)
      }
      loop.logs.push({ time: Date.now(), event: 'decomposed', detail: `拆解为 ${loop.subtasks.length} 个子任务` })
    }
    // 兜底：LLM 不可用或拆解失败 → 用默认模板
    if (loop.subtasks.length === 0) {
      const fallback = this.fallbackDecompose(trimmed)
      loop.strategy = fallback.strategy
      loop.subtasks = fallback.subtasks
      loop.triggers = fallback.triggers
      loop.logs.push({ time: Date.now(), event: 'decomposed', detail: 'LLM 不可用，使用默认拆解模板' })
    }

    loop.status = 'reviewing'
    await this.persist()
    this.emit()
    return loop
  }

  /** LLM 动态拆解：goal → { strategy, subtasks, trigger } */
  private async decompose(goal: string): Promise<Decomposition | null> {
    const cfg = this.getLLMConfig()
    if (!cfg?.baseUrl || !cfg.model) {return null}

    const prompt = this.buildDecompositionPrompt(goal)
    try {
      const res = await window.luminaAPI?.llmChat?.({
        apiKey: cfg.apiKey || '',
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        maxTokens: 2048,
        systemPrompt:
          '你是 Lumina 的 Loop 任务规划器。你只输出严格 JSON，不输出任何其他文字。' +
          '你的职责：把一个长程 OKR 目标拆解为可执行的子任务链，并给出合理的循环触发建议。',
      })
      const raw = res?.content
      if (!raw) {return null}
      const parsed = extractJson(raw) as Record<string, any> | null
      return this.normalizeDecomposition(parsed)
    } catch (e: any) {
      console.warn('[LoopEngine] 动态拆解失败，使用默认模板:', e?.message)
      return null
    }
  }

  private buildDecompositionPrompt(goal: string): string {
    return `请把下面的目标拆解为一个可持续循环执行的 Loop 任务。

目标：${goal}

请输出严格 JSON（不要 markdown 围栏），结构如下：
{
  "strategy": "一句话概括整体执行策略",
  "subtasks": [
    { "title": "子任务1标题", "description": "该子任务要做什么、输出什么" },
    { "title": "子任务2标题", "description": "..." }
  ],
  "trigger": {
    "type": "interval | cron | message",
    "intervalHours": 24,
    "cronSchedule": "0 15 * * 1-5",
    "keywords": ["股票", "收盘"]
  }
}

要求：
- subtasks 3~6 个，按「感知信息 → 分析处理 → 整合产出 → 自检修正」的链路组织；
- trigger 只给一个最合理的：周期性任务用 interval/cron，被动监听用 message；
- 全部用简体中文。`
  }

  private normalizeDecomposition(parsed: Record<string, any> | null): Decomposition | null {
    if (!parsed || typeof parsed !== 'object') {return null}
    const strategy = typeof parsed.strategy === 'string' ? parsed.strategy.trim() : ''
    const rawSubs = Array.isArray(parsed.subtasks) ? parsed.subtasks : []
    const subtasks = rawSubs
      .filter((s: any) => s && typeof s === 'object')
      .slice(0, 6)
      .map((s: any) => ({
        title: String(s.title || '').trim(),
        description: String(s.description || '').trim(),
      }))
      .filter(s => s.title)

    const triggerRaw = parsed.trigger && typeof parsed.trigger === 'object' ? parsed.trigger : null
    let trigger: Decomposition['trigger']
    if (triggerRaw) {
      const t = triggerRaw as Record<string, any>
      const type = ['interval', 'cron', 'message'].includes(t.type) ? t.type : 'interval'
      trigger = {
        type: type as 'interval' | 'cron' | 'message',
        intervalHours: Number(t.intervalHours) > 0 ? Number(t.intervalHours) : undefined,
        cronSchedule: typeof t.cronSchedule === 'string' ? t.cronSchedule : undefined,
        keywords: Array.isArray(t.keywords) ? t.keywords.map(String) : undefined,
      }
    }
    if (!strategy && subtasks.length === 0) {return null}
    return { strategy: strategy || '按子任务链循环执行', subtasks, trigger }
  }

  /** LLM 不可用时的默认拆解模板 */
  private fallbackDecompose(goal: string): { strategy: string; subtasks: SubTask[]; triggers: LoopTrigger[] } {
    const now = Date.now()
    const subtasks: SubTask[] = [
      { id: genId('st'), title: '收集信息', description: `围绕「${goal}」收集最新、权威的一手信息`, status: 'pending', retryCount: 0, maxRetries: 2 },
      { id: genId('st'), title: '分析处理', description: '对收集到的信息进行筛选、归纳、交叉验证', status: 'pending', retryCount: 0, maxRetries: 2 },
      { id: genId('st'), title: '整合产出', description: `根据分析结果生成「${goal}」的交付产出`, status: 'pending', retryCount: 0, maxRetries: 2 },
      { id: genId('st'), title: '自检修正', description: '检查产出质量，补充遗漏，修正偏差', status: 'pending', retryCount: 0, maxRetries: 2 },
    ]
    return {
      strategy: `围绕「${goal}」循环执行：收集 → 分析 → 产出 → 自检。`,
      subtasks,
      triggers: [{ id: genId('trg'), type: 'interval', config: { intervalMs: 24 * 3600 * 1000 }, enabled: true }],
    }
  }

  private buildTriggers(trigger: NonNullable<Decomposition['trigger']>): LoopTrigger[] {
    if (trigger.type === 'cron' && trigger.cronSchedule) {
      return [{ id: genId('trg'), type: 'cron', config: { schedule: trigger.cronSchedule }, enabled: true }]
    }
    if (trigger.type === 'message' && trigger.keywords?.length) {
      return [{ id: genId('trg'), type: 'message', config: { keywords: trigger.keywords }, enabled: true }]
    }
    const hours = trigger.intervalHours && trigger.intervalHours > 0 ? trigger.intervalHours : 24
    return [{ id: genId('trg'), type: 'interval', config: { intervalMs: hours * 3600 * 1000 }, enabled: true }]
  }

  // ── 状态流转（用户确认/暂停/恢复/停止） ─────────────────

  /** 用户审阅确认 → 开始运转 */
  async confirmLoop(id: string): Promise<LoopTask | undefined> {
    const loop = this.getLoop(id)
    if (!loop || (loop.status !== 'reviewing' && loop.status !== 'paused' && loop.status !== 'configuring')) {return loop}
    loop.status = 'running'
    loop.logs.push({ time: Date.now(), event: 'confirm', detail: '用户确认，开始运转' })
    await this.persist()
    this.emit()
    return loop
  }

  async pauseLoop(id: string): Promise<LoopTask | undefined> {
    const loop = this.getLoop(id)
    if (!loop) {return loop}
    loop.status = 'paused'
    loop.progress.current = null
    loop.logs.push({ time: Date.now(), event: 'pause' })
    await this.persist()
    this.emit()
    return loop
  }

  async resumeLoop(id: string): Promise<LoopTask | undefined> {
    const loop = this.getLoop(id)
    if (!loop) {return loop}
    loop.status = 'running'
    loop.logs.push({ time: Date.now(), event: 'resume' })
    await this.persist()
    this.emit()
    return loop
  }

  async stopLoop(id: string): Promise<LoopTask | undefined> {
    const loop = this.getLoop(id)
    if (!loop) {return loop}
    loop.status = 'done'
    loop.progress.current = null
    loop.logs.push({ time: Date.now(), event: 'stop' })
    await this.persist()
    this.emit()
    return loop
  }

  async removeLoop(id: string): Promise<void> {
    this.tasks = this.tasks.filter(t => t.id !== id)
    await this.persist()
    this.emit()
  }

  // ── 自动感知触发 ────────────────────────────────────────

  /** 定时检查所有触发器（interval + cron） */
  checkTriggers(now: Date = new Date()): void {
    for (const loop of this.tasks) {
      if (loop.status !== 'running') {continue}
      if (this.runningLoops.has(loop.id)) {continue}
      for (const trigger of loop.triggers) {
        if (!trigger.enabled) {continue}
        if (this.triggerMatches(loop, trigger, now)) {
          void this.runCycle(loop.id, trigger)
          break // 一个循环一次只跑一个触发器
        }
      }
    }
  }

  private triggerMatches(loop: LoopTask, trigger: LoopTrigger, now: Date): boolean {
    switch (trigger.type) {
      case 'interval': {
        const intervalMs = Number(trigger.config?.intervalMs)
        if (!(intervalMs > 0)) {return false}
        // 从未跑过：以启动时刻为基准，避免启动即触发
        if (!loop.lastRunAt) {return false}
        return now.getTime() - loop.lastRunAt >= intervalMs
      }
      case 'cron': {
        const schedule = String(trigger.config?.schedule || '')
        if (!schedule) {return false}
        if (!cronMatches(schedule, now)) {return false}
        // 同一分钟防重
        const key = `${loop.id}:${trigger.id}`
        const minuteKey = `${now.getHours()}:${now.getMinutes()}`
        if (this.lastCronHit.get(key) === minuteKey) {return false}
        this.lastCronHit.set(key, minuteKey)
        return true
      }
      case 'message':
      case 'api_event':
        // 由 notifyMessage / notifyEvent 驱动，不在定时检查内
        return false
      default:
        return false
    }
  }

  /** 外部消息监听触发：文本里包含关键词 → 跑一轮 */
  async notifyMessage(text: string): Promise<string[]> {
    const fired: string[] = []
    for (const loop of this.tasks) {
      if (loop.status !== 'running' || this.runningLoops.has(loop.id)) {continue}
      const hit = loop.triggers.some(t =>
        t.enabled && t.type === 'message' && this.keywordsHit(t.config?.keywords, text),
      )
      if (hit) {
        await this.runCycle(loop.id)
        fired.push(loop.id)
      }
    }
    return fired
  }

  /** 外部事件触发（api_event，未来 webhook/轮询扩展） */
  async notifyEvent(eventName: string, _payload?: unknown): Promise<string[]> {
    const fired: string[] = []
    for (const loop of this.tasks) {
      if (loop.status !== 'running' || this.runningLoops.has(loop.id)) {continue}
      const hit = loop.triggers.some(t =>
        t.enabled && t.type === 'api_event' && String(t.config?.event) === eventName,
      )
      if (hit) {
        await this.runCycle(loop.id)
        fired.push(loop.id)
      }
    }
    return fired
  }

  /** 复用主进程 cron 引擎：cron:triggered 事件按名称/调度匹配 Loop */
  private async onExternalCronTrigger(data: any): Promise<void> {
    if (!data || typeof data !== 'object') {return}
    const name = String(data.name || '')
    const schedule = String(data.schedule || '')
    const action = String(data.action || '')
    for (const loop of this.tasks) {
      if (loop.status !== 'running' || this.runningLoops.has(loop.id)) {continue}
      for (const trigger of loop.triggers) {
        if (!trigger.enabled) {continue}
        const tSchedule = String(trigger.config?.schedule || '')
        const tName = String(trigger.config?.name || '')
        if (trigger.type === 'cron' && (tSchedule === schedule || (tName && name.includes(tName)))) {
          await this.runCycle(loop.id, trigger)
          break
        }
        // 也允许普通 cron 任务通过 message 关键词触发
        if (trigger.type === 'message' && this.keywordsHit(trigger.config?.keywords, name + action)) {
          await this.runCycle(loop.id, trigger)
          break
        }
      }
    }
  }

  // ── 循环执行（核心） ─────────────────────────────────────

  /**
   * 手动触发一轮循环（用户点「立即执行」或对话中触发）。
   * 一轮 = 顺序执行所有未完成/失败的子任务 → 汇总产出 → 重置子任务（为下一轮准备）
   */
  async runCycle(id: string, trigger?: LoopTrigger): Promise<LoopTask | undefined> {
    const loop = this.getLoop(id)
    if (!loop || loop.status !== 'running') {return loop}
    if (this.runningLoops.has(id)) {return loop}

    this.runningLoops.add(id)
    const now = Date.now()
    loop.lastRunAt = now
    loop.logs.push({
      time: now,
      event: 'trigger',
      detail: trigger ? `触发：${trigger.type}` : '手动触发',
    })
    this.emit()

    try {
      // 1) 顺序执行每个 pending/failed 且未耗尽重试的子任务
      for (const st of loop.subtasks) {
        if (st.status === 'done') {continue}
        if (st.status === 'failed' && st.retryCount >= st.maxRetries) {continue}

        st.status = 'running'
        st.startedAt = Date.now()
        st.retryCount += 1
        loop.progress.current = st.id
        this.emit()

        const result = await this.executeSubtask(st, loop)

        st.finishedAt = Date.now()
        if (result.ok) {
          st.status = 'done'
          st.result = result.content || ''
          loop.progress.completed = Array.from(new Set([...loop.progress.completed, st.id]))
          loop.logs.push({ time: Date.now(), event: 'subtask_done', detail: st.title })
        } else {
          st.status = 'failed'
          st.result = result.error || result.content || ''
          loop.logs.push({ time: Date.now(), event: 'subtask_failed', detail: `${st.title}：${st.result.slice(0, 80)}` })
        }
        loop.progress.current = null
        this.emit()
      }

      // 2) 汇总本轮产出
      const doneTitles = loop.subtasks.filter(s => s.status === 'done').map(s => s.title)
      const failedTitles = loop.subtasks.filter(s => s.status === 'failed').map(s => s.title)
      const outputLines: string[] = []
      if (doneTitles.length) {outputLines.push(`✅ 完成：${doneTitles.join('、')}`)}
      if (failedTitles.length) {outputLines.push(`⚠️ 未完成：${failedTitles.join('、')}`)}
      outputLines.push(`🔄 第 ${loop.runCount + 1} 轮循环结束于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)

      loop.runCount += 1
      loop.outputs.push({ time: Date.now(), content: outputLines.join('\n') })
      loop.progress.history = loop.progress.history.concat(doneTitles).slice(-30)
      loop.logs.push({ time: Date.now(), event: 'cycle', detail: `第 ${loop.runCount} 轮完成` })

      // 4) 被动确认模式：通知外部（UI 推送轻量提示，不弹窗打断）
      try {
        this.opts.onCycleComplete?.(loop)
      } catch (e: any) {
        console.warn('[LoopEngine] onCycleComplete 回调失败:', e?.message)
      }

      // 5) 重置子任务 → 下一轮循环随时可再触发
      for (const st of loop.subtasks) {
        st.status = 'pending'
        st.retryCount = 0
        st.result = undefined
        st.startedAt = undefined
        st.finishedAt = undefined
      }
      loop.progress.completed = []
      loop.progress.current = null
    } catch (e: any) {
      loop.logs.push({ time: Date.now(), event: 'error', detail: String(e?.message || e) })
    } finally {
      this.runningLoops.delete(id)
      await this.persist()
      this.emit()
    }
    return loop
  }

  /** 执行单个子任务（可注入 executor；默认仅记录） */
  private async executeSubtask(st: SubTask, loop: LoopTask): Promise<LoopSubtaskResult> {
    const executor = this.opts.executor
    if (executor) {
      try {
        return await executor(st, loop)
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) }
      }
    }
    // 默认执行器：把子任务说明当作产出记录（Phase 2 接入真实工具链时替换）
    return { ok: true, content: `【${st.title}】${st.description}` }
  }

  // ── 内部工具 ─────────────────────────────────────────────

  private getLLMConfig(): LLMConfig | undefined {
    if (this.opts.getLLMConfig) {return this.opts.getLLMConfig()}
    try {
      // 动态读取，避免在引擎构造时依赖 store 已初始化
      return useStoreRef.getState().llmConfig
    } catch {
      return undefined
    }
  }

  private keywordsHit(keywords: unknown, text: string): boolean {
    const kw = Array.isArray(keywords) ? keywords.map(String) : []
    if (kw.length === 0) {return false}
    const lower = text.toLowerCase()
    return kw.some(k => k && lower.includes(k.toLowerCase()))
  }

  private async persist(): Promise<void> {
    try {
      await this.persistence.save([...this.tasks])
    } catch (e: any) {
      console.warn('[LoopEngine] 持久化失败:', e?.message)
    }
  }

  private emit(): void {
    this.opts.onChanged?.([...this.tasks])
  }

  /** 恢复时兜底规范化，防止脏数据 */
  private normalizeTasks(raw: LoopTask[]): LoopTask[] {
    return raw
      .filter(t => t && typeof t === 'object' && t.id)
      .map(t => ({
        id: t.id,
        goal: t.goal || '',
        strategy: t.strategy || '',
        subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
        triggers: Array.isArray(t.triggers) ? t.triggers : [],
        progress: {
          completed: Array.isArray(t.progress?.completed) ? t.progress.completed : [],
          current: t.progress?.current ?? null,
          persistenceKey: t.progress?.persistenceKey || `${t.id}-progress`,
          history: Array.isArray(t.progress?.history) ? t.progress.history : [],
        },
        status: t.status,
        createdAt: t.createdAt || Date.now(),
        lastRunAt: t.lastRunAt,
        outputs: Array.isArray(t.outputs) ? t.outputs : [],
        runCount: t.runCount || 0,
        logs: Array.isArray(t.logs) ? t.logs : [],
        agentId: t.agentId,
      }))
  }
}

// ═══════════════════════════════════════════════════════════
// OKR 意图检测（聊天侧自动创建 Loop 用，纯函数便于测试）
// ═══════════════════════════════════════════════════════════

export interface LoopIntent {
  goal: string
  /** slug 化后的精简目标（展示用） */
  shortGoal: string
  trigger: LoopTrigger
}

const FREQ_HOURS: Record<string, number> = {
  '每天': 24, '每日': 24, '每周': 168, '每星期': 168, '每月': 720, '每个月': 720,
}

const OKR_VERBS = ['盯盘', '盯', '看', '收集', '追踪', '整理', '汇总', '生成', '写', '检查', '监控', '复盘', '分析', '抓取', '读', '报道', '汇报', '产出', '更新', '调研', '学习', '拆解']

/**
 * 从自然语言中检测「创建自动任务」意图。
 * 命中条件：出现「帮我 + 频率词 + 动词」或「频率词 + 动词」。
 * 返回建议的 goal + 触发器；未命中返回 null。
 * 例：「帮我每天收盘后盯盘并给出次日操作建议」→ goal + interval（每天）。
 */
export function detectLoopIntent(text: string): LoopIntent | null {
  const t = (text || '').trim()
  if (!t) {return null}

  const hasHelp = /帮我|请帮我|能不能|你可以|安排/.test(t)
  let freq: string | null = null
  for (const k of Object.keys(FREQ_HOURS)) {
    if (t.includes(k)) { freq = k; break }
  }
  // 频率不明确，但有「定期/定时/自动循环」提示
  const hasSchedule = freq !== null || /定期|定时|按时|循环|自动/.test(t)

  const verb = OKR_VERBS.find(v => t.includes(v))

  // 需要至少：有动词 + （有「帮我」或「频率/定期」）
  if (!verb) {return null}
  if (!hasHelp && !hasSchedule && !freq) {return null}

  // 触发规则
  const intervalMs = freq ? (FREQ_HOURS[freq] ?? 24) * 3600 * 1000 : 24 * 3600 * 1000
  const trigger: LoopTrigger = {
    id: genId('trg'),
    type: 'interval',
    config: { intervalMs },
    enabled: true,
  }

  // 精简目标：去掉「帮我/请帮我」前缀，去掉丰满度尾语，保留核心动作短语
  const shortGoal = t
    .replace(/^请帮我[，,：:]?/, '')
    .replace(/^帮我[，,：:]?/, '')
    .replace(/^(你可以|能不能)[，,：:]?/, '')
    .slice(0, 40)

  return {
    goal: t.slice(0, 120),
    shortGoal,
    trigger,
  }
}
