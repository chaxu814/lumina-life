// ============================================================
// emotionBridge.ts — 情绪 ↔ 游戏化桥接 (v1.0 Phase 2)
//
// 让 XP 系统可以在不直接依赖 agentRunner 的情况下获取当前情绪。
// agentRunner.setEmotion() 会同步更新这里的共享状态。
// ============================================================

// 静态导入（打包后动态 require 路径解析不到）
import { setCurrentMood } from '../luckyModeIntegration'
import { globalEventBus } from '../eventBus'

/** 当前情绪状态（默认中性） */
let _currentEmotion: { mood: number; energy: number; affinity: number } = {
  mood: 0,
  energy: 0.5,
  affinity: 0.5,
}

/** 情绪乘数表 */
export const EMOTION_XP_MULTIPLIERS: Record<string, number> = {
  // mood 区间 → XP 倍率
  // -1.0 ~ -0.6: 难过/低落 → 0.5x
  // -0.6 ~ -0.2: 一般 → 0.8x
  // -0.2 ~  0.2: 平静 → 1.0x
  //  0.2 ~  0.6: 开心 → 1.5x
  //  0.6 ~  1.0: 超开心 → 2.0x
}

export function getEmotionXpMultiplier(): number {
  const m = _currentEmotion.mood
  if (m <= -0.6) return 0.5
  if (m <= -0.2) return 0.8
  if (m <= 0.2) return 1.0
  if (m <= 0.6) return 1.5
  return 2.0
}

export function getEmotionLabel(): string {
  const m = _currentEmotion.mood
  const e = _currentEmotion.energy
  if (m <= -0.6 && e < 0.3) return '低落 😔'
  if (m <= -0.6) return '难过 😢'
  if (m <= -0.2 && e < 0.3) return '疲惫 😩'
  if (m <= -0.2) return '闷闷不乐 😕'
  if (m <= 0.2) return '平静 😐'
  if (m <= 0.6 && e > 0.7) return '兴奋 🤩'
  if (m <= 0.6) return '开心 😊'
  if (e > 0.7) return '超开心 🎉'
  return '幸福 💖'
}

/** 更新情绪（由 agentRunner.setEmotion 调用） */
export function updateEmotion(emotion: { mood: number; energy: number; affinity: number; label?: string }): void {
  _currentEmotion = { mood: emotion.mood, energy: emotion.energy, affinity: emotion.affinity }
  // 🆕 Lucky: 根据 mood 数值映射到情绪标签
  try {
    const label = emotion.label || getEmotionLabel()
    const moodMap: Record<string, string> = {
      '低落 😔': 'tired',
      '难过 😢': 'stressed',
      '疲惫 😩': 'tired',
      '闷闷不乐 😕': 'stressed',
      '平静 😐': 'neutral',
      '兴奋 🤩': 'playful',
      '开心 😊': 'happy',
      '超开心 🎉': 'happy',
      '幸福 💖': 'happy',
    }
    const mappedMood = moodMap[label] || 'neutral'
    setCurrentMood(mappedMood)

    globalEventBus.emit('agent:mood_changed', { mood: mappedMood, intensity: Math.abs(emotion.mood) })
  } catch {}
}

/** 读取当前情绪（给 XP 系统用） */
export function getCurrentEmotion(): { mood: number; energy: number; affinity: number } {
  return { ..._currentEmotion }
}
