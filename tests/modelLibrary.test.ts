import { describe, it, expect } from 'vitest'
import { ModelLibrary, BUILTIN_MODELS } from '../electron/pet/modelLibrary'

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
})
