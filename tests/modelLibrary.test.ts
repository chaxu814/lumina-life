import { describe, it, expect } from 'vitest'
import { ModelLibrary, BUILTIN_MODELS, isValidEntryForKind, isValidAvatarKind } from '../electron/pet/modelLibrary'

describe('modelLibrary 模型库', () => {
  it('默认内置 Mao 且为当前模型', () => {
    const lib = new ModelLibrary()
    expect(lib.list().some(m => m.id === 'Mao')).toBe(true)
    expect(lib.current().builtin).toBe(true)
    expect(BUILTIN_MODELS[0].id).toBe('Mao')
  })

  it('注册合法 UGC 模型并切换', () => {
    const lib = new ModelLibrary(undefined, 1000)
    const r = lib.register({ name: '小白', entryRel: 'Shiro/shiro.model3.json', hasFiveVowel: false }, 1000)
    expect(r.ok).toBe(true)
    expect(lib.select(r.id!)).toBe(true)
    expect(lib.current().name).toBe('小白')
    expect(lib.current().builtin).toBe(false)
  })

  it('拒绝路径穿越与非 model3 入口、内置 id 冲突', () => {
    const lib = new ModelLibrary()
    expect(lib.register({ name: 'x', entryRel: '../evil/x.model3.json' }).ok).toBe(false)
    expect(lib.register({ name: 'x', entryRel: 'Mao/readme.txt' }).ok).toBe(false)
    expect(lib.register({ id: 'Mao', name: 'x', entryRel: 'M/x.model3.json' }).ok).toBe(false)
  })

  it('内置不可删；删除当前自定义回退内置', () => {
    const lib = new ModelLibrary()
    expect(lib.remove('Mao')).toBe(false)
    const r = lib.register({ name: '小白', entryRel: 'Shiro/shiro.model3.json' })
    lib.select(r.id!)
    expect(lib.remove(r.id!)).toBe(true)
    expect(lib.current().id).toBe('Mao')
    expect(lib.select('not-exist')).toBe(false)
  })

  it('序列化/反序列化往返保留自定义与选择，内置恒定', () => {
    const lib = new ModelLibrary(undefined, 500)
    const r = lib.register({ name: '小白', entryRel: 'Shiro/shiro.model3.json', channels: 30 }, 500)
    lib.select(r.id!)
    const data = lib.serialize()
    expect(data.custom).toHaveLength(1)
    const restored = ModelLibrary.deserialize(data)
    expect(restored.get(r.id!)?.channels).toBe(30)
    expect(restored.current().id).toBe(r.id)
    expect(restored.get('Mao')?.builtin).toBe(true)
  })

  it('恶意模型名被消毒', () => {
    const lib = new ModelLibrary()
    const r = lib.register({ name: '../../etc', entryRel: 'A/a.model3.json' })
    expect(r.ok).toBe(true)
    expect(r.id).not.toContain('..')
    expect(r.id).not.toContain('/')
  })

  it('缺省 kind 向后兼容为 live2d（Mao 也是 live2d）', () => {
    const lib = new ModelLibrary()
    expect(lib.current().kind).toBe('live2d')
    const r = lib.register({ name: '老模型', entryRel: 'Old/old.model3.json' })
    expect(r.ok).toBe(true)
    expect(lib.get(r.id!)?.kind).toBe('live2d')
  })

  it('接受 VRM/MMD/PNGTuber 合法入口并记录 kind', () => {
    const lib = new ModelLibrary()
    const v = lib.register({ name: '3D娘', entryRel: 'Hikari/hikari.vrm', kind: 'vrm' })
    expect(v.ok).toBe(true)
    expect(lib.get(v.id!)?.kind).toBe('vrm')
    const m = lib.register({ name: 'MMD', entryRel: 'M/miku.pmx', kind: 'mmd' })
    expect(m.ok).toBe(true)
    const p = lib.register({ name: '立绘', entryRel: 'P/tuber.png', kind: 'pngtuber' })
    expect(p.ok).toBe(true)
  })

  it('入口后缀与形态不匹配时拒绝', () => {
    const lib = new ModelLibrary()
    expect(lib.register({ name: 'x', entryRel: 'M/miku.model3.json', kind: 'vrm' }).ok).toBe(false)
    expect(lib.register({ name: 'x', entryRel: 'H/h.vrm', kind: 'mmd' }).ok).toBe(false)
  })

  it('kind 工具函数：非法 kind 被识别；后缀校验正确', () => {
    expect(isValidAvatarKind('vrm')).toBe(true)
    expect(isValidAvatarKind('maya')).toBe(false)
    expect(isValidEntryForKind('vrm', 'A/a.VRM')).toBe(true)
    expect(isValidEntryForKind('mmd', 'A/a.pmd')).toBe(true)
    expect(isValidEntryForKind('live2d', 'A/a.vrm')).toBe(false)
  })
})

import { isRenderable, unsupportedReason, readyKinds } from '../electron/pet/avatarRenderer'
describe('avatarRenderer 能力声明', () => {
  it('只有 live2d 可渲染，其余为 roadmap', () => {
    expect(readyKinds()).toEqual(['live2d'])
    expect(isRenderable('live2d')).toBe(true)
    expect(isRenderable(undefined)).toBe(true) // 向后兼容
    for (const k of ['vrm', 'mmd', 'pngtuber'] as const) {
      expect(isRenderable(k)).toBe(false)
      expect(unsupportedReason(k)).toBeTruthy()
    }
    expect(unsupportedReason('live2d')).toBeNull()
  })
})

