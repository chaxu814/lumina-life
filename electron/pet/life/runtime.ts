// ============================================================
// pet/life/runtime.ts — 🎬 桌宠表演运行时（渲染侧高层封装，v0.2）
//
// 把情绪核心 / 面部原语 / 五元音口型 / 分层混合器 / 表演 DSL / 参数 profile
// 组装成一个对渲染页极友好的引擎 PetPerformanceEngine：
//   const engine = new LuminaLife.PetPerformanceEngine(cdi3)
//   model.motion(...); 每帧：engine.update(now).forEach(p => setParameterValueById(p.id,p.value))
//   engine.setMood('开心 😊'); engine.speak('你好呀', now); engine.perform(dsl, now)
// 零外部依赖，可被 esbuild 打成 IIFE 单文件 pet-life.js 供 pet-live2d.html <script> 引入，
// 也能在主进程/单测中直接 import（同构）。
// ============================================================

import { discoverProfile, toParamPatches, maoProfile, type ModelProfile } from '../live2d/parameterProfile'
import { AnimationMixer } from './animationMixer'
import {
  poseForEmotion, visemePose, gazePose, breathPose,
  type StandardPose, type Viseme,
} from './faceRig'
import { moodToCore, normalizeMood, type MoodLabel, type CoreEmotion } from './emotionCore'
import { textToVisemeSegments, sampleViseme, opennessFromRms, type VisemeSeg } from './lipsync'
import { safePerformance } from './performanceDsl'

export type { CoreEmotion }
export interface ParamPatch { id: string; value: number }
export interface PerformHints {
  gesture?: string
  builtin?: boolean
  effect?: { name: string; amount: number }
  motion?: string
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** 可用语义参数姿态合成的手势（其余手势交给渲染层播 motion3） */
function parametricGesture(name: string, intensity: number): StandardPose {
  const i = clamp01(intensity)
  switch (name) {
    case 'shrug': return { shoulderL: i, shoulderR: i, headRoll: 4 * i }
    case 'tilt': return { headRoll: 14 * i }
    case 'sad': return { headPitch: 8 * i, browLAngle: 0.6 * i, browRAngle: 0.6 * i, mouthDown: 0.5 * i }
    case 'angry': return { browLAngle: 0.8 * i, browRAngle: 0.8 * i, mouthAngry: 0.5 * i, headPitch: -4 * i }
    default: return {}
  }
}

export class PetPerformanceEngine {
  profile: ModelProfile
  mixer = new AnimationMixer({ maxDeltaAngle: 12, maxDeltaNorm: 0.4 })
  private emo: CoreEmotion
  private segs: VisemeSeg[] = []
  private speakStart = 0
  private speaking = false
  private audioOpen = 0
  private speechLevel = 0
  private levelMode = false
  private autoBlink = true
  private nextBlinkAt = 2200
  private blinkStart = -1
  /** 可替换的随机源（测试确定性） */
  random: () => number = Math.random

  constructor(cdi3?: unknown, modelName = 'Mao') {
    this.profile = cdi3 ? discoverProfile(cdi3, modelName) : maoProfile()
    this.emo = moodToCore('平静 😐')
    this.mixer.setLayer('emotion', poseForEmotion(this.emo), { weight: 1, now: 0 })
  }

  loadCdi3(cdi3: unknown, name = 'Mao'): void { this.profile = discoverProfile(cdi3, name) }
  setBlinkEnabled(on: boolean): void { this.autoBlink = on }

  setMood(labelOrCore: MoodLabel | string | CoreEmotion, now = 0): void {
    if (typeof labelOrCore === 'object' && labelOrCore !== null) {
      this.emo = labelOrCore
    } else {
      this.emo = moodToCore(normalizeMood(labelOrCore) ?? '平静 😐')
    }
    this.mixer.setLayer('emotion', poseForEmotion(this.emo), { weight: 1, now })
  }

  /** 临时视线（DSL/表演用；持续跟随仍由渲染层 focusController 负责） */
  setGaze(x: number, y: number, now: number, ttlMs = 1200): void {
    this.mixer.setLayer('gaze', gazePose(x, y, 0.6), { weight: 0.6, ttlMs, now, fadeMs: 220 })
  }

  /** 文本驱动五元音口型（startNow 为该句音频起点 ms） */
  speak(text: string, startNow: number): void {
    this.segs = textToVisemeSegments(text)
    this.speakStart = startNow
    this.speaking = this.segs.length > 0
    this.levelMode = false
    this.speechLevel = 0
  }

  /**
   * 接入真实播放音频的实时电平（AnalyserNode RMS）：
   * 元音形状仍按文本，张度改由真实语音能量驱动、停顿自动闭合。
   */
  setSpeechLevel(level: number): void {
    if (!this.speaking) {return}
    this.levelMode = true
    this.speechLevel = clamp01(level)
  }

  isSpeaking(now: number): boolean {
    if (!this.speaking) {return false}
    const last = this.segs[this.segs.length - 1]
    return now - this.speakStart <= (last?.end ?? 0) + 200
  }

  stopSpeak(now: number): void {
    this.speaking = false
    this.segs = []
    this.levelMode = false
    this.speechLevel = 0
    this.mixer.clearLayer('speech')
    void now
  }

  /** 只有实时音频电平（无文本/音素）时，按能量张合嘴（默认 A 元音） */
  setAudioLevel(level: number, now: number): void {
    this.audioOpen = opennessFromRms(clamp01(level), this.audioOpen)
    if (this.speaking) {return}
    if (this.audioOpen > 0.05) {
      this.mixer.setLayer('speech', visemePose('A', this.audioOpen), { weight: 1, now })
    } else {
      this.mixer.clearLayer('speech')
    }
  }

  /** 执行一条高层表演指令；返回需要渲染层补做的事（内置动作/特效/motion） */
  perform(input: unknown, now: number): PerformHints {
    const cmd = safePerformance(input)
    if (!cmd) {return {}}
    const hints: PerformHints = {}

    if (cmd.expression) {
      const m = normalizeMood(cmd.expression)
      if (m) {this.setMood(m, now)}
    }

    if (cmd.gaze) {
      const tx = cmd.gaze.x ?? gazeTargetX(cmd.gaze.target)
      const ty = cmd.gaze.y ?? gazeTargetY(cmd.gaze.target)
      this.setGaze(tx, ty, now, cmd.durationMs)
    }

    // 头侧倾与参数化手势合并到同一个 action 层，避免互相覆盖
    const actionPose: StandardPose = {}
    if (cmd.headTilt !== undefined) {actionPose.headRoll = cmd.headTilt * 12}
    if (cmd.gesture && !cmd.gesture.builtin) {
      Object.assign(actionPose, parametricGesture(cmd.gesture.name, cmd.gesture.intensity))
    }
    if (Object.keys(actionPose).length) {
      this.mixer.setLayer('action', actionPose, { weight: 1, ttlMs: cmd.durationMs, now, fadeMs: 200 })
    }
    if (cmd.gesture) { hints.gesture = cmd.gesture.name; hints.builtin = cmd.gesture.builtin }
    if (cmd.effect) {hints.effect = cmd.effect}
    if (cmd.motion) {hints.motion = cmd.motion}
    return hints
  }

  /** 每帧推进，返回可直接 setParameterValueById 的参数补丁 */
  update(now: number): ParamPatch[] {
    // 呼吸（约 4 秒一个周期）
    this.mixer.setLayer('base', breathPose(now / 4000), { weight: 1, now })

    // 自动眨眼（约每 2~5 秒一次，持续约 220ms）
    if (this.autoBlink) {
      if (this.blinkStart < 0 && now >= this.nextBlinkAt) {
        this.blinkStart = now
        this.nextBlinkAt = now + 1800 + this.random() * 3200
      }
      if (this.blinkStart >= 0) {
        const t = now - this.blinkStart
        let amount = 0
        if (t < 70) {amount = t / 70}
        else if (t < 150) {amount = 1}
        else if (t < 220) {amount = 1 - (t - 150) / 70}
        else { this.blinkStart = -1; amount = 0 }
        this.mixer.setBlink(clamp01(amount))
      }
    }

    // 说话口型
    if (this.speaking) {
      const at = now - this.speakStart
      const lastEnd = this.segs[this.segs.length - 1]?.end ?? 0
      if (at > lastEnd + 200) {
        this.stopSpeak(now)
      } else {
        const s = sampleViseme(this.segs, at)
        const open = this.levelMode ? this.speechLevel : s.open
        this.mixer.setLayer('speech', visemePose(s.viseme as Viseme, open), { weight: 1, now })
      }
    }

    const pose = this.mixer.frame(now)
    return toParamPatches(this.profile, pose)
  }
}

function gazeTargetX(t?: string): number {
  if (t === 'left') {return -0.8}
  if (t === 'right') {return 0.8}
  if (t === 'user') {return 0}
  return 0
}
function gazeTargetY(t?: string): number {
  if (t === 'up') {return -0.6}
  if (t === 'down') {return 0.6}
  return 0
}

// alpha-trim 纯逻辑（随 pet-life.js 一起暴露到 window.LuminaLife，供渲染页贴身裁剪用）
export { scanAlphaBounds, backingPixelScale, type TrimRatios, type ScanAlphaOptions } from './alphaTrim'
