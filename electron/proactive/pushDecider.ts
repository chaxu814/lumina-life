// ============================================================
// pushDecider.ts — 主动推送决策引擎
// 输入三维状态+时间+活跃状态，输出是否推送/强度/文案/原因
// ============================================================

import type { PushState, PushSettings } from './pushState'
import { tickState } from './pushState'

export type PushIntensity = 'low' | 'medium' | 'high'
export type PushType = 'greeting' | 'care' | 'share' | 'reminder' | 'chat'

export interface PushDecision {
  should_speak: boolean
  intensity: PushIntensity
  speech: string
  type: PushType
  reason: string
}

/** 推送文案模板（按类型分组，后续可接入 LLM 生成个性化文案） */
const SPEECH_TEMPLATES: Record<PushType, string[]> = {
  greeting: [
    '在忙吗？记得喝口水～',
    '嘿，我在这儿呢，有什么想聊的吗？',
    '今天过得怎么样呀？',
  ],
  care: [
    '你已经坐了挺久了，起来活动一下吧？',
    '眼睛累不累？看看远处休息一下。',
    '别忘了吃饭哦，工作再忙也要照顾自己。',
  ],
  share: [
    '我刚想到一件有趣的事，要听听吗？',
    '今天发现了一个好玩的东西，想分享给你～',
    '你知道吗？我一直在学习新东西呢。',
  ],
  reminder: [
    '提醒一下，你之前说要做的事别忘了哦。',
    '时间不早了，要不要休息一下？',
    '今天的目标完成了吗？需要我帮忙吗？',
  ],
  chat: [
    '陪我说说话嘛～',
    '你最近在忙什么呀？',
    '有点无聊，你呢？',
  ],
}

function parseTime(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

function isInQuietHours(settings: PushSettings, now = new Date()): boolean {
  const cur = now.getHours() * 60 + now.getMinutes()
  const start = parseTime(settings.quietHoursStart)
  const end = parseTime(settings.quietHoursEnd)
  if (start === end) return false
  if (start < end) return cur >= start && cur < end
  return cur >= start || cur < end // 跨午夜
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * 核心决策函数
 * 欲望值 = intimacy * 0.35 + luminaEnergy * 0.25 + (1-fatigue) * 0.25 + 时段权重 * 0.15
 * 超过阈值（默认0.6）才推送，未响应降频提高阈值
 */
export function decidePush(
  state: PushState,
  settings: PushSettings,
  now = Date.now(),
): PushDecision {
  const s = tickState(state, now)
  const nowDate = new Date(now)

  // 1. 总开关
  if (!settings.enabled) {
    return { should_speak: false, intensity: 'low', speech: '', type: 'chat', reason: '推送总开关关闭' }
  }

  // 2. 静默时段
  if (isInQuietHours(settings, nowDate)) {
    return { should_speak: false, intensity: 'low', speech: '', type: 'chat', reason: '静默时段' }
  }

  // 3. 每日上限
  if (s.todayPushCount >= settings.maxPerDay) {
    return { should_speak: false, intensity: 'low', speech: '', type: 'chat', reason: `今日已达上限${settings.maxPerDay}次` }
  }

  // 4. 冷却
  const sinceLastPushMin = (now - s.lastPushAt) / (1000 * 60)
  if (s.lastPushAt > 0 && sinceLastPushMin >= 0 && sinceLastPushMin < settings.cooldownMinutes) {
    return { should_speak: false, intensity: 'low', speech: '', type: 'chat', reason: `冷却中（还需${Math.ceil(settings.cooldownMinutes - sinceLastPushMin)}分钟）` }
  }

  // 5. 用户刚活跃（5分钟内），不打扰
  const sinceActiveMin = (now - s.lastActiveAt) / (1000 * 60)
  if (sinceActiveMin >= 0 && sinceActiveMin < 5) {
    return { should_speak: false, intensity: 'low', speech: '', type: 'chat', reason: '用户刚活跃，不打扰' }
  }

  // 6. 计算欲望值
  const hour = nowDate.getHours()
  let timeWeight = 0.5
  if (hour >= 9 && hour <= 11) timeWeight = 0.8 // 上午
  else if (hour >= 14 && hour <= 17) timeWeight = 0.7 // 下午
  else if (hour >= 19 && hour <= 22) timeWeight = 0.9 // 晚上黄金时段
  else if (hour >= 0 && hour < 6) timeWeight = 0.2 // 深夜

  const desire =
    s.intimacy * 0.35 +
    s.luminaEnergy * 0.25 +
    (1 - s.fatigue) * 0.25 +
    timeWeight * 0.15

  // 7. 未响应降频：连续2次未响应，阈值提高50%
  let threshold = 0.6
  if (s.consecutiveIgnored >= 2) {
    threshold *= 1.5
  }

  if (desire < threshold) {
    return {
      should_speak: false,
      intensity: 'low',
      speech: '',
      type: 'chat',
      reason: `欲望值${desire.toFixed(2)}低于阈值${threshold.toFixed(2)}（亲密度${s.intimacy.toFixed(2)}/精力${s.luminaEnergy.toFixed(2)}/疲劳${s.fatigue.toFixed(2)}）`,
    }
  }

  // 8. 选择推送类型
  const availableTypes = settings.allowedTypes
  let type: PushType = 'chat'
  if (s.fatigue > 0.6 && availableTypes.includes('care')) type = 'care'
  else if (hour >= 11 && hour <= 13 && availableTypes.includes('reminder')) type = 'reminder'
  else if (s.intimacy > 0.7 && availableTypes.includes('share')) type = 'share'
  else if (availableTypes.includes('greeting')) type = 'greeting'
  else type = pickRandom(availableTypes.length > 0 ? availableTypes : ['chat'])

  // 9. 强度
  const intensity: PushIntensity = desire > 0.8 ? 'high' : desire > 0.65 ? 'medium' : 'low'

  // 10. 文案
  const templates = SPEECH_TEMPLATES[type]
  const speech = pickRandom(templates)

  return {
    should_speak: true,
    intensity,
    speech,
    type,
    reason: `欲望值${desire.toFixed(2)}≥阈值${threshold.toFixed(2)}，类型=${type}，强度=${intensity}`,
  }
}
