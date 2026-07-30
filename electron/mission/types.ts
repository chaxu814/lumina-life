// ============================================================
// mission/types.ts — Mission 模式类型定义 (v3.5)
//
// 借鉴 QwenPaw Mission Mode:
//   Phase 1: 探索代码库 → 生成 PRD (用户确认)
//   Phase 2: 逐 story 实现 → 自动验证 → 全部通过
// ============================================================

export type MissionPhase = 'idle' | 'phase1_prd' | 'phase2_execute' | 'done' | 'failed'

export type StoryStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped'

export interface UserStory {
  id: string
  title: string
  description: string
  acceptanceCriteria: string[]
  status: StoryStatus
  /** 实现说明 */
  implementation?: string
  /** 关联文件 */
  files?: string[]
  /** 完成时间 */
  completedAt?: string
}

export interface PRD {
  /** 项目/任务名称 */
  title: string
  /** 一句话概述 */
  summary: string
  /** 约束条件 */
  constraints: string[]
  /** 用户故事列表 */
  stories: UserStory[]
  /** 验证命令 */
  verifyCommands: string[]
  /** 最大迭代次数 */
  maxIterations: number
  /** 当前迭代 */
  currentIteration: number
  /** 创建时间 */
  createdAt: string
  /** 最后更新时间 */
  updatedAt: string
}

export interface MissionConfig {
  /** 任务描述 */
  taskText: string
  /** 验证命令 (逗号分隔) */
  verifyCommands?: string
  /** 最大迭代次数 (默认 20) */
  maxIterations?: number
  /** 工作目录 */
  workingDir: string
}

export interface MissionState {
  phase: MissionPhase
  prd?: PRD
  config: MissionConfig
  /** 输出目录 */
  loopDir: string
  /** 开始时间 */
  startedAt: string
  /** 进度文件路径 */
  progressFile: string
}
