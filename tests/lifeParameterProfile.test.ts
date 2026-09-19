import { describe, it, expect } from 'vitest'
import {
  discoverProfile, resolveParamId, toParamPatches, MAO_CHANNEL_MAP, STANDARD_CHANNELS,
} from '../electron/pet/live2d/parameterProfile'

const MINI_CDI3 = {
  Version: '3',
  Parameters: [
    { Id: 'ParamAngleX', GroupId: 'Head' }, { Id: 'ParamAngleY', GroupId: 'Head' }, { Id: 'ParamAngleZ', GroupId: 'Head' },
    { Id: 'ParamEyeLOpen', GroupId: 'Eye' }, { Id: 'ParamEyeROpen', GroupId: 'Eye' }, { Id: 'ParamEyeBallX', GroupId: 'Eye' },
    { Id: 'ParamA', GroupId: 'Mouth' }, { Id: 'ParamI', GroupId: 'Mouth' }, { Id: 'ParamU', GroupId: 'Mouth' },
    { Id: 'ParamE', GroupId: 'Mouth' }, { Id: 'ParamO', GroupId: 'Mouth' }, { Id: 'ParamMouthUp', GroupId: 'Mouth' },
    { Id: 'ParamBodyAngleZ', GroupId: 'Body' }, { Id: 'ParamBreath', GroupId: 'Body' }, { Id: 'ParamCheek', GroupId: 'Face' },
  ],
}

describe('parameterProfile 参数发现', () => {
  it('从 cdi3 自动发现并映射语义通道', () => {
    const p = discoverProfile(MINI_CDI3, 'Mini')
    expect(resolveParamId(p, 'headPitch')).toBe('ParamAngleX')
    expect(resolveParamId(p, 'visemeA')).toBe('ParamA')
    expect(p.supported.has('ParamCheek')).toBe(true)
    expect(p.groups).toContain('Mouth')
  })

  it('模型缺少的通道不映射（安全降级）', () => {
    const p = discoverProfile(MINI_CDI3, 'Mini')
    expect(resolveParamId(p, 'browLY')).toBeUndefined()
    expect(resolveParamId(p, 'mouthDown')).toBeUndefined()
  })

  it('toParamPatches 钳制越界并剔除不支持通道', () => {
    const p = discoverProfile(MINI_CDI3, 'Mini')
    const patches = toParamPatches(p, { visemeA: 5, browLY: 0.9, eyeBallX: 2 })
    const map = Object.fromEntries(patches.map(x => [x.id, x.value]))
    expect(map.ParamA).toBe(1)              // clamp 到上限
    expect(map.ParamEyeBallX).toBe(1)       // clamp 到 1
    expect(map.ParamBrowLY).toBeUndefined() // 不支持
  })

  it('Mao 完整映射覆盖全部标准通道', () => {
    for (const ch of STANDARD_CHANNELS) {expect(MAO_CHANNEL_MAP[ch]).toBeTruthy()}
  })

  it('非对象/空 cdi3 不崩溃', () => {
    const p = discoverProfile(null, 'X')
    expect(p.channelMap.headPitch).toBeUndefined()
    expect(toParamPatches(p, { visemeA: 1 })).toEqual([])
  })
})
