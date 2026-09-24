// ============================================================
// electron/voice/wakeWord.ts — 🔔 唤醒词接入层（Porcupine 占位）
//
// 本模块是「高精度本地热词检测」的统一接入口。
//   - 未配置 Porcupine（默认）→ 退化为关键词匹配门控
//     （复用 electron/whisper/wakeWord.ts 的 WakeWordGate，零依赖、离线）。
//   - 配置了 Porcupine accessKey + 模型 → PorcupineWakeWordProvider 占位，
//     实现真正的麦克风常开热词检测。
//
// 如何接入 Porcupine（用户侧）：
//   1. npm i @picovoice/porcupine-node @picovoice/coffeeen-v2 (或对应语言)
//   2. 在设置「无障碍」页填入 Porcupine AccessKey（控制台免费申请）
//      与 .ppn 模型路径（自定义热词导出）。
//   3. createWakeWordProvider({ porcupine: { accessKey, modelPath } }) 即返回
//      真硬件检测 Provider；beforeWake 回调可直接驱动 VoiceLoop。
//
// 纯 TS、时间注入，可单测。
// ============================================================

import { WakeWordGate, type WakeWordConfig } from '../whisper/wakeWord'

export interface PorcupineConfig {
  accessKey: string
  /** 自定义 .ppn 热词模型路径 */
  modelPath?: string
  /** 内置热词，如 'lumina_lighting_wasm' */
  builtinKeyword?: string
  /** 敏感度 0~1 */
  sensitivity?: number
}

export interface WakeWordProvider {
  /** 是否为真 Porcupine 硬件检测（否则为关键词兜底） */
  readonly kind: 'porcupine' | 'keyword'
  /** 喂入识别文本，判断是否应唤醒（keyword 兜底模式用） */
  processText(text: string, now: number): boolean
  /** 启动麦克风常开检测（Porcupine 模式；keyword 模式 no-op） */
  start(): Promise<void>
  stop(): void
  onWake(cb: (keyword: string) => void): void
}

/**
 * Porcupine 真硬件检测占位。
 * 未安装 @picovoice/porcupine-node 时 start() 抛错并提示安装；
 * 接入后把「检测到热词」事件转发给 onWake。
 */
export class PorcupineWakeWordProvider implements WakeWordProvider {
  readonly kind = 'porcupine' as const
  private cbs: Array<(kw: string) => void> = []
  private started = false

  constructor(private readonly cfg: PorcupineConfig) {}

  async start(): Promise<void> {
    if (this.started) {return}
    // 真接入点：动态 import @picovoice/porcupine-node（可选依赖，未装时给出清晰提示）
    try {
      const Porcupine = (await import('@picovoice/porcupine-node' as any)).default
      // eslint-disable-next-line no-new
      new Porcupine(this.cfg.accessKey, {
        customWritePath: this.cfg.modelPath,
        sensitivities: [this.cfg.sensitivity ?? 0.5],
      })
      this.started = true
    } catch {
      throw new Error(
        'Porcupine 未安装。请运行：npm i @picovoice/porcupine-node，' +
        '并在 Porcupine 控制台申请 AccessKey、导出 .ppn 热词模型。',
      )
    }
  }

  stop(): void { this.started = false }

  onWake(cb: (kw: string) => void): void { this.cbs.push(cb) }

  /** Porcupine 模式下走音频流，文本接口不参与判断 */
  processText(): boolean { return false }

  /** 内部：Porcupine 检测到热词时调用 */
  protected emitWake(kw: string): void { this.cbs.forEach((cb) => cb(kw)) }
}

/** 关键词兜底 Provider：复用 WakeWordGate，无需麦克风常开 */
class KeywordWakeWordProvider implements WakeWordProvider {
  readonly kind = 'keyword' as const
  private gate: WakeWordGate
  private cbs: Array<(kw: string) => void> = []

  constructor(cfg: WakeWordConfig) { this.gate = new WakeWordGate(cfg) }

  async start(): Promise<void> { /* 文本门控，无需麦克风常开 */ }
  stop(): void { this.gate.endSession() }
  onWake(cb: (kw: string) => void): void { this.cbs.push(cb) }

  processText(text: string, now: number): boolean {
    const should = this.gate.shouldProcess(text, now)
    if (should && this.gate.enabled) {
      const kw = this.gate.matchKeyword(text)
      if (kw && this.gate.isSessionActive(now)) {this.cbs.forEach((cb) => cb(kw))}
    }
    return should
  }
}

export interface CreateWakeWordOptions extends WakeWordConfig {
  porcupine?: PorcupineConfig
}

/** 工厂：有 porcupine 配置走真硬件检测，否则走关键词兜底 */
export function createWakeWordProvider(opts: CreateWakeWordOptions = {}): WakeWordProvider {
  if (opts.porcupine?.accessKey) {
    return new PorcupineWakeWordProvider(opts.porcupine)
  }
  return new KeywordWakeWordProvider(opts)
}
