// ============================================================
// whisper/audioLevel.ts — 🎚️ 实时音频电平 / 自适应噪声门 (v0.2)
//
// recorder.ts 旧实现只把整段录音写成 WAV 文件，没有实时电平，VAD 与 barge-in
// 都缺一个「现在有没有人说话 / 多大声」的信号源。本模块对 PCM 帧做纯计算：
// RMS、峰值、过零率，并维护一个会随环境自适应的噪声门限。
// 纯 TS、零依赖，可单测；麦克风采集（AnalyserNode / AudioWorklet）在接线层注入样本。
// ============================================================

export interface LevelFrame {
  /** 均方根响度 0~1 */
  rms: number
  /** 峰值 0~1 */
  peak: number
  /** 过零率 0~1（辅助区分语音/稳态噪声） */
  zcr: number
}

/** 计算一帧 PCM 采样（-1~1）的电平特征 */
export function analyzeFrame(samples: ArrayLike<number>): LevelFrame {
  const n = samples.length
  if (n === 0) {return { rms: 0, peak: 0, zcr: 0 }}
  let sumSq = 0
  let peak = 0
  let crossings = 0
  let prev = samples[0]
  for (let i = 0; i < n; i++) {
    const s = samples[i]
    const x = s > 1 ? 1 : s < -1 ? -1 : s
    sumSq += x * x
    const ax = x < 0 ? -x : x
    if (ax > peak) {peak = ax}
    if (i > 0 && ((prev >= 0 && x < 0) || (prev < 0 && x >= 0))) {crossings++}
    prev = x
  }
  return { rms: Math.sqrt(sumSq / n), peak, zcr: crossings / (n - 1 || 1) }
}

export interface NoiseGateOptions {
  /** 初始噪声地板 */
  floor?: number
  /** 判定为有声的倍数（相对噪声地板） */
  factor?: number
  /** 绝对最小门限，避免极安静时误触发 */
  offset?: number
  /** 过零率上限（超过视为非语音噪声，可选，0 表示不启用） */
  zcrMax?: number
  /** 噪声地板向下/向上跟踪速度 */
  downRate?: number
  upRate?: number
}

/** 自适应噪声门：估计环境本底噪声，给出动态语音门限 */
export class NoiseGate {
  floor: number
  private factor: number
  private offset: number
  private zcrMax: number
  private downRate: number
  private upRate: number

  constructor(opts: NoiseGateOptions = {}) {
    this.floor = opts.floor ?? 0.02
    this.factor = opts.factor ?? 2.6
    this.offset = opts.offset ?? 0.015
    this.zcrMax = opts.zcrMax ?? 0.35
    this.downRate = opts.downRate ?? 0.05
    this.upRate = opts.upRate ?? 0.008
  }

  /** 当前动态门限 */
  get threshold(): number {
    return this.floor * this.factor + this.offset
  }

  /**
   * 用一帧电平更新噪声地板。
   * @param isVoicedHint 上层已知该帧为语音（可选），语音帧不抬升地板
   */
  update(frame: LevelFrame, isVoicedHint?: boolean): void {
    const level = frame.rms
    if (level < this.floor) {
      this.floor += (level - this.floor) * this.downRate
    } else if (!isVoicedHint) {
      // 非语音但比地板响：缓慢上抬以适应持续背景噪声
      const target = level * 0.6
      if (target > this.floor) {this.floor += (target - this.floor) * this.upRate}
    }
  }

  /** 该帧是否判定为有声（语音） */
  isVoiced(frame: LevelFrame): boolean {
    if (frame.rms < this.threshold) {return false}
    if (this.zcrMax > 0 && frame.zcr > this.zcrMax && frame.peak < 0.25) {return false}
    return true
  }
}
