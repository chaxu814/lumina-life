import { describe, it, expect } from 'vitest'
import { moodToCore } from '../electron/pet/life/emotionCore'
import {
  poseForEmotion, visemePose, gazePose, blinkPose, breathPose, neutralPose,
} from '../electron/pet/life/faceRig'

describe('faceRig 面部/身体原语', () => {
  it('高愉悦：嘴角上扬、眼笑；低愉悦：嘴角下垂、低头', () => {
    const happy = poseForEmotion(moodToCore('幸福 💖'))
    expect(happy.mouthUp ?? 0).toBeGreaterThan(0.3)
    expect(happy.eyeLSmile ?? 0).toBeGreaterThan(0)
    const sad = poseForEmotion(moodToCore('难过 😢'))
    expect(sad.mouthDown ?? 0).toBeGreaterThan(0.2)
    expect(sad.headPitch ?? 0).toBeGreaterThan(0)
  })

  it('疲惫半闭眼，焦虑蹙眉耸肩', () => {
    const tired = poseForEmotion(moodToCore('疲惫 😩'))
    expect(tired.eyeLOpen ?? 1).toBeLessThan(0.55)
    const anxious = poseForEmotion({ valence: -0.6, arousal: 0.7, joy: 0.1, fatigue: 0.2, focus: 0.5, anxiety: 0.9, curiosity: 0.4, affinity: 0.3 })
    expect(anxious.browLAngle ?? 0).toBeGreaterThan(0.3)
    expect(anxious.shoulderL ?? 0).toBeGreaterThan(0)
  })

  it('五元音互斥，rest 归零，U 带噘嘴', () => {
    const a = visemePose('A', 1)
    expect(a.visemeA).toBe(1)
    expect(a.visemeI).toBe(0)
    const rest = visemePose('rest')
    expect(rest.visemeA).toBe(0)
    expect(rest.visemeO).toBe(0)
    const u = visemePose('U', 1)
    expect(u.visemeU).toBe(1)
    expect(u.mouthAngry ?? 0).toBeGreaterThan(0)
  })

  it('视线/眨眼/呼吸/中性姿态', () => {
    expect(gazePose(1, 0).eyeBallX).toBe(1)
    expect(gazePose(99, 0).eyeBallX).toBe(1) // clamp
    expect(blinkPose(1).eyeLOpen).toBe(0)
    const b = breathPose(0)
    expect(b.breath ?? -1).toBeGreaterThanOrEqual(0)
    expect(neutralPose().visemeA).toBe(0)
  })
})
