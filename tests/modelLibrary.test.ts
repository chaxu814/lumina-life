import { describe, it, expect } from 'vitest'
import {
  ModelLibrary, BUILTIN_MODELS, FALLBACK_MODEL_ID, FALLBACK_ENTRY_REL, fallbackModel,
  isValidEntryForKind, isValidAvatarKind,
} from '../electron/pet/modelLibrary'

describe('modelLibrary 模型库', () => {
  // 【保底形象契约】
  // 仓库不携带任何 Live2D 模型资产（Mao 等受 Cubism SDK 再分发条款约束）。
  // 内置列表因此只剩一个**零外部素材**的程序化小猫，它是所有异常回退路径的终点。
  // 下列用例锁死这个契约：任何改回“内置一个需要资产文件的表情”的修改都会在这里失败。
  it('内置保底形象是程序化小猫，且零外部素材依赖', () => {
    const lib = new ModelLibrary()
    expect(BUILTIN_MODELS).toHaveLength(1)
    expect(FALLBACK_MODEL_ID).toBe('Cat')
    expect(FALLBACK_ENTRY_REL).toBe('__cat__')
    expect(fallbackModel()).toEqual({ id: 'Cat', name: '小猫', entryRel: '__cat__', kind: 'cat', builtin: true, addedAt: 0 })
    expect(lib.current().id).toBe('Cat')
    expect(lib.current().builtin).toBe(true)
  })

  it('保底形象不依赖任何文件后缀（cat 是程序化特殊入口）', () => {
    // 如果将来把保底形象换成 live2d/vrm，entryRel 就会带上 .model3.json / .vrm，
    // 也就意味着“任何情况下都能加载”的保证破灭。用这条用例把它钉死。
    expect(FALLBACK_ENTRY_REL).not.toMatch(/\.[a-z0-9]+$/i)
    expect(BUILTIN_MODELS[0].kind).toBe('cat')
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
    expect(lib.register({ name: 'x', entryRel: 'Cat/readme.txt' }).ok).toBe(false)
    expect(lib.register({ id: 'Cat', name: 'x', entryRel: 'M/x.model3.json' }).ok).toBe(false)
  })

  it('内置不可删；删除当前自定义回退保底形象', () => {
    const lib = new ModelLibrary()
    expect(lib.remove('Cat')).toBe(false)
    const r = lib.register({ name: '小白', entryRel: 'Shiro/shiro.model3.json' })
    lib.select(r.id!)
    expect(lib.remove(r.id!)).toBe(true)
    expect(lib.current().id).toBe('Cat')
    expect(lib.select('not-exist')).toBe(false)
  })

  it('已退役的内置模型（Mao / Hiyori）不再出现在库中', () => {
    // 这两个模型曾内置，现在都从仓库移除了。旧版库文件里可能还留着它们的 id，
    // 升级后必须查不到，否则会指向不存在的资产路径。
    const lib = new ModelLibrary({ currentId: 'Mao', custom: [] })
    expect(lib.get('Mao')).toBeUndefined()
    expect(lib.get('Hiyori')).toBeUndefined()
    expect(lib.current().id).toBe('Cat')  // 悬空 currentId 回退到保底形象
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
    expect(restored.get('Cat')?.builtin).toBe(true)
  })

  it('恶意模型名被消毒', () => {
    const lib = new ModelLibrary()
    const r = lib.register({ name: '../../etc', entryRel: 'A/a.model3.json' })
    expect(r.ok).toBe(true)
    expect(r.id).not.toContain('..')
    expect(r.id).not.toContain('/')
  })

  it('缺省 kind 向后兼容为 live2d（保底小猫显式声明为 cat）', () => {
    const lib = new ModelLibrary()
    expect(lib.current().kind).toBe('cat')
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
  it('所有五种形态均可渲染（mmd 为 beta）', () => {
    expect(readyKinds().sort()).toEqual(['cat', 'live2d', 'mmd', 'pngtuber', 'vrm'].sort())
    expect(isRenderable('live2d')).toBe(true)
    expect(isRenderable('vrm')).toBe(true)
    expect(isRenderable('pngtuber')).toBe(true)
    expect(isRenderable('mmd')).toBe(true)
    expect(isRenderable('cat')).toBe(true)
    expect(isRenderable(undefined)).toBe(true) // 向后兼容
    expect(unsupportedReason('live2d')).toBeNull()
    expect(unsupportedReason('vrm')).toBeNull()
  })
})

