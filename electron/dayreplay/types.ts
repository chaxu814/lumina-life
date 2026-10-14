// ============================================================
// dayreplay/types.ts — Day Replay（可回放的一天）对外契约
//
// 【谁会依赖这个文件】
//   后续两个功能直接消费：睡前复盘（evening review）、交班卡片（handoff card）。
//   所以这里的名字与形状是对外契约，不许改。
//
// 【口径】
//   · 一切时间区间按「本地时区的一天 00:00:00.000 – 次日 00:00:00.000」切割；
//   · items 按 ts 升序，越早的越靠前；
//   · 拿不到的数据源就让对应统计保持 0、不编数据（诚实输出优先）。
// ============================================================

/** 时间线条目种类 */
export type TimelineKind =
  | 'command'   // 沙箱里执行的一条命令
  | 'task'      // 任务看板上的一个任务节点
  | 'delegate'  // 招来的临时工（子智能体）
  | 'pet'       // 桌宠相关事件（仅事件总线有推送时才有）
  | 'llm'       // 一次模型调用
  | 'file'      // 从命令里 best-effort 提取到的文件变更
  | 'todo'      // 待办 / 每日任务事件（仅事件接入时才有）
  | 'system'    // 应用级系统事件

/** 时间线里的一条记录 */
export interface TimelineItem {
  /** epoch ms */
  ts: number
  kind: TimelineKind
  /** 一句话标题（克制、可直接当素材） */
  title: string
  /** 补充说明（可选） */
  detail?: string
  /** 谁做的：lumina / yak / recha / system（可选） */
  actor?: string
  /** 本条涉及的文件路径（可选） */
  filesChanged?: string[]
  /** 附加元信息（内部排查用，渲染层不直接展示） */
  meta?: Record<string, unknown>
}

/** 一天的回放聚合结果 */
export interface DailyReplay {
  /** 本地时区 YYYY-MM-DD */
  date: string
  /** 时间线条目，按 ts 升序 */
  items: TimelineItem[]
  stats: {
    /** 沙箱审计看到的命令条数 */
    commands: number
    /** best-effort 提取到的变更文件数（去重） */
    filesChanged: number
    /** 成功跑完的模型轮次 */
    turns: number
    /** 当天委托（招来的临时工）数 */
    delegates: number
    /** 当天模型调用总数（含失败） */
    llmCalls: number
    /** 花费（人民币元） */
    costYuan: number
    promptTokens: number
    completionTokens: number
    /** 按发起方分组的调用数 */
    byAgent: Record<string, number>
    /** 按用途分组的调用数 */
    byPurpose: Record<string, number>
  }
  /** 这份回放是什么时候生成的 */
  generatedAt: number
}
