/**
 * Lumina Life 性能基准 — TypeScript 类型定义
 * 供 benchmark.js（CommonJS）与未来 TypeScript 基准扩展共用。
 */

/** 单个采样点 */
export interface SamplePoint {
  index: number;
  timestamp: string;
  /** 进程常驻内存 Resident Set Size (MB) */
  rssMB: number;
  /** V8 堆已用 (MB) */
  heapUsedMB: number;
  /** V8 堆总量 (MB) */
  heapTotalMB: number;
  /** 外部内存 (MB) */
  externalMB: number;
  arrayBuffersMB: number;
  /** 占整机逻辑核心总容量的 CPU 百分比 */
  cpuMachinePct: number;
  /** 占一个核心的 CPU 百分比 */
  cpuPerCorePct: number;
  /** 系统当前可用内存 (GB) */
  systemFreeMemGB: number;
  /** Electron getProcessMemoryInfo 细分类（仅 Electron 环境） */
  electron?: {
    privateMB: number;
    sharedMB: number;
    residentMB: number;
  };
}

/** 一组数值的统计摘要 */
export interface StatSummary {
  avg: number;
  max: number;
  min: number;
  stddev: number;
}

/** 硬件与运行环境信息 */
export interface HardwareInfo {
  platform: string;
  arch: string;
  release: string;
  nodeVersion: string;
  electronVersion: string | null;
  chromeVersion: string | null;
  cpuModel: string;
  cpuCores: number;
  cpuSpeedMHz: number | null;
  totalMemGB: number;
  freeMemGB: number;
}

/** 单个 Electron 进程的指标（app.getAppMetrics） */
export interface ElectronProcessMetric {
  pid: number;
  type: string;
  rssMB: number;
  cpuPercent: number;
}

export interface ElectronMetrics {
  processCount: number;
  totalRssMB: number;
  processes: ElectronProcessMetric[];
}

/** 场景名 */
export type ScenarioName =
  | 'idle'
  | 'chat'
  | 'live2d'
  | 'onnx-loaded'
  | 'computer-use';

/** 单个场景的完整测量结果 */
export interface ScenarioMetrics {
  scenario: ScenarioName;
  isElectron: boolean;
  workloadNote: string;
  sampleCount: number;
  intervalMs: number;
  logicalCores: number;
  summary: {
    rssMB: StatSummary;
    heapUsedMB: StatSummary;
    heapTotalMB: StatSummary;
    externalMB: StatSummary;
    cpuMachinePct: StatSummary;
    cpuPerCorePct: StatSummary;
  };
  samples: SamplePoint[];
  electronMetrics: ElectronMetrics | null;
}

/** 完整基准报告 */
export interface BenchmarkReport {
  tool: string;
  version: string;
  startedAt: string;
  endedAt: string;
  hardware: HardwareInfo;
  result: ScenarioMetrics;
}
