import { describe, it, expect } from 'vitest'
import {
  getRendererForKind, fallbackToBuiltin, resolveModelEntry,
  guessKindFromEntry, isModelValid, isRenderable, unsupportedReason, readyKinds,
  RENDERER_REGISTRY,
} from '../electron/pet/avatarRenderer'
import { BUILTIN_MODELS, parseModelManifest } from '../electron/pet/modelLibrary'

describe('avatarRenderer 渲染器选择', () => {
  it('所有 kind 都有渲染器注册', () => {
    for (const kind of ['live2d', 'vrm', 'pngtuber', 'mmd', 'cat'] as const) {
      const info = getRendererForKind(kind)
      expect(info.kind).toBe(kind)
      expect(info.htmlFile).toBeTruthy()
      expect(info.displayName).toBeTruthy()
    }
  })

  it('live2d 路由到 pet-live2d.html', () => {
    const info = getRendererForKind('live2d')
    expect(info.htmlFile).toBe('pet-live2d.html')
    expect(info.supported).toBe(true)
  })

  it('vrm 路由到 pet-vrm.html', () => {
    const info = getRendererForKind('vrm')
    expect(info.htmlFile).toBe('pet-vrm.html')
    expect(info.supported).toBe(true)
  })

  it('pngtuber 路由到 pet-pngtuber.html', () => {
    const info = getRendererForKind('pngtuber')
    expect(info.htmlFile).toBe('pet-pngtuber.html')
    expect(info.supported).toBe(true)
  })

  it('mmd 路由到 pet-mmd.html 且标注 beta', () => {
    const info = getRendererForKind('mmd')
    expect(info.htmlFile).toBe('pet-mmd.html')
    expect(info.supported).toBe(true)
    expect(info.beta).toBe(true)
  })

  it('cat 路由到 pet-cat.html', () => {
    const info = getRendererForKind('cat')
    expect(info.htmlFile).toBe('pet-cat.html')
    expect(info.supported).toBe(true)
  })

  it('未知 kind 兜底 live2d', () => {
    const info = getRendererForKind('nonexistent' as any)
    expect(info.kind).toBe('live2d')
  })
})

describe('fallbackToBuiltin 回退', () => {
  it('返回内置 Mao', () => {
    const fb = fallbackToBuiltin()
    expect(fb.modelId).toBe('Mao')
    expect(fb.kind).toBe('live2d')
    expect(fb.entryRel).toBe('Mao/mao_pro.model3.json')
  })
})

describe('resolveModelEntry 模型解析', () => {
  const libData = {
    currentId: 'TestModel',
    custom: [
      { id: 'TestModel', name: '测试模型', entryRel: 'Test/test.model3.json', kind: 'live2d', builtin: false, addedAt: 0 },
      { id: 'VRM1', name: 'VRM模型', entryRel: 'VRM1/char.vrm', kind: 'vrm', builtin: false, addedAt: 0 },
    ],
  }

  it('解析内置 Mao', () => {
    const r = resolveModelEntry(libData, 'Mao')
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('live2d')
    expect(r!.entryRel).toBe('Mao/mao_pro.model3.json')
  })

  it('解析内置 Cat', () => {
    const r = resolveModelEntry(libData, 'Cat')
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('cat')
    expect(r!.entryRel).toBe('__cat__')
  })

  it('解析自定义 live2d 模型', () => {
    const r = resolveModelEntry(libData, 'TestModel')
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('live2d')
    expect(r!.entryRel).toBe('Test/test.model3.json')
  })

  it('解析自定义 vrm 模型', () => {
    const r = resolveModelEntry(libData, 'VRM1')
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('vrm')
  })

  it('不存在的模型返回 null', () => {
    expect(resolveModelEntry(libData, 'Nope')).toBeNull()
  })

  it('空库数据返回 null', () => {
    expect(resolveModelEntry(null, 'Mao')).toBeNull()
  })
})

describe('guessKindFromEntry 入口推断', () => {
  it('.model3.json → live2d', () => {
    expect(guessKindFromEntry('Mao/mao.model3.json')).toBe('live2d')
  })
  it('.vrm → vrm', () => {
    expect(guessKindFromEntry('char/char.vrm')).toBe('vrm')
  })
  it('.pmx → mmd', () => {
    expect(guessKindFromEntry('mmd/model.pmx')).toBe('mmd')
  })
  it('.pmd → mmd', () => {
    expect(guessKindFromEntry('mmd/old.pmd')).toBe('mmd')
  })
  it('.png → pngtuber', () => {
    expect(guessKindFromEntry('pt/idle.png')).toBe('pngtuber')
  })
  it('__cat__ → cat', () => {
    expect(guessKindFromEntry('__cat__')).toBe('cat')
  })
  it('未知后缀 → live2d', () => {
    expect(guessKindFromEntry('foo/bar.txt')).toBe('live2d')
  })
})

describe('isModelValid 入口校验', () => {
  it('cat 特殊入口恒合法', () => {
    expect(isModelValid('__cat__', 'cat')).toBe(true)
    expect(isModelValid('anything', 'cat')).toBe(false)
  })
  it('live2d 要求 .model3.json', () => {
    expect(isModelValid('Mao/mao.model3.json', 'live2d')).toBe(true)
    expect(isModelValid('Mao/mao.moc3', 'live2d')).toBe(false)
  })
  it('vrm 要求 .vrm', () => {
    expect(isModelValid('char.vrm', 'vrm')).toBe(true)
    expect(isModelValid('char.pmx', 'vrm')).toBe(false)
  })
  it('mmd 接受 .pmx 和 .pmd', () => {
    expect(isModelValid('model.pmx', 'mmd')).toBe(true)
    expect(isModelValid('model.pmd', 'mmd')).toBe(true)
    expect(isModelValid('model.obj', 'mmd')).toBe(false)
  })
  it('pngtuber 要求 .png', () => {
    expect(isModelValid('idle.png', 'pngtuber')).toBe(true)
    expect(isModelValid('idle.jpg', 'pngtuber')).toBe(false)
  })
})

describe('isRenderable / readyKinds 能力声明', () => {
  it('所有五种形态都可渲染', () => {
    for (const kind of ['live2d', 'vrm', 'pngtuber', 'mmd', 'cat'] as const) {
      expect(isRenderable(kind)).toBe(true)
    }
  })
  it('undefined 向后兼容为 true', () => {
    expect(isRenderable(undefined)).toBe(true)
  })
  it('readyKinds 包含全部五种', () => {
    const kinds = readyKinds()
    expect(kinds).toContain('live2d')
    expect(kinds).toContain('vrm')
    expect(kinds).toContain('pngtuber')
    expect(kinds).toContain('mmd')
    expect(kinds).toContain('cat')
  })
})

describe('parseModelManifest manifest 解析', () => {
  it('合法 manifest 正确解析', () => {
    const json = JSON.stringify({
      name: '测试模型', kind: 'live2d', entry: 'Mao/mao_pro.model3.json',
      thumbnail: 'thumb.png', author: '作者', license: 'MIT', version: '1.0',
      motions: { idle: 'motions/idle.vmd' },
    })
    const m = parseModelManifest(json)
    expect(m).not.toBeNull()
    expect(m!.name).toBe('测试模型')
    expect(m!.kind).toBe('live2d')
    expect(m!.entry).toBe('Mao/mao_pro.model3.json')
    expect(m!.author).toBe('作者')
    expect(m!.motions!.idle).toBe('motions/idle.vmd')
  })

  it('非法 JSON 返回 null', () => {
    expect(parseModelManifest('not json')).toBeNull()
  })

  it('数组返回 null', () => {
    expect(parseModelManifest('[1,2,3]')).toBeNull()
  })

  it('未知 kind 被忽略', () => {
    const m = parseModelManifest(JSON.stringify({ kind: 'unknown', name: 'x' }))
    expect(m).not.toBeNull()
    expect(m!.kind).toBeUndefined()
  })

  it('空字符串 name 被忽略', () => {
    const m = parseModelManifest(JSON.stringify({ name: '   ' }))
    expect(m!.name).toBeUndefined()
  })
})
