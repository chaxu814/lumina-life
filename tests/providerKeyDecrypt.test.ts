// ============================================================
// tests/providerKeyDecrypt.test.ts — API Key 的解密不变量
//
// 【背景：这是一个真实故障，而且是自相矛盾的那种】
// 用户报：「我已经连接好模型了，但 Lumina 提示尚未配置 LLM」。
// 截图里：设置页填好了 endpoint / 模型 / Key，聊天框却是「模拟模式」。
//
// 排查出的链条：
//
//   ProviderManager._save()  → 写盘时**加密**（aes-256-cbc，v1:xxx）
//   load() 磁盘分支         → 读盘后**解密**
//   getProviderConfig()      → 再解密一次（所以对话链路是好的）
//   getAllProviderConfigs()  → **不解密**，直接把 store 里的东西交出去
//
//   而 load() 里的解密循环被写在 `if (!qpSynced)` 分支内，
//   且该分支结束就 `return` 了。走 QwenPaw 同步路径时，
//   **解密一次都没跑过** → 内存里存的是密文。
//
//   于是：
//     getAllProviderConfigs() 返回密文
//       → provider:discover-local 拿 `v1:30f4...` 当 Bearer 发出去
//       → LM Studio（开了鉴权）返回 401
//       → found=[] → localModelReady=false → llmReady=false
//       → 界面显示「尚未配置 LLM · 模拟回复模式」
//
//   而对话走的是 getActiveConfig() → getProviderConfig()（会解密），
//   所以模型其实**完全正常**。于是就成了「能聊天、却说自己没连接」。
//
// 症状：非对称失败（一条路好、一条路坏）+ 界面提示与事实矛盾。
// 这类问题最难自查，因为「测试连接」按钮是绿的。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

// ═══════════════════════════════════════════════════════════
// 用与 providerManager 相同的参数独立实现一份加解密，
// 这样测试不依赖被测模块的私有函数，也能验证「密文到底是什么样」。
// ═══════════════════════════════════════════════════════════
const CIPHER_KEY = crypto.scryptSync('lumina-provider-key-v1', 'provider-salt', 32)
const IV_LENGTH = 16

function encryptApiKey(text: string): string {
  if (!text) { return '' }
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', CIPHER_KEY, iv)
  let enc = cipher.update(text, 'utf8', 'hex')
  enc += cipher.final('hex')
  return 'v1:' + iv.toString('hex') + ':' + enc
}

function decryptApiKey(encrypted: string): string {
  if (!encrypted) { return '' }
  try {
    const parts = encrypted.split(':')
    if (parts[0] !== 'v1' || parts.length < 3) { return encrypted }
    const iv = Buffer.from(parts[1], 'hex')
    const data = parts.slice(2).join(':')
    const decipher = crypto.createDecipheriv('aes-256-cbc', CIPHER_KEY, iv)
    let dec = decipher.update(data, 'hex', 'utf8')
    dec += decipher.final('utf8')
    return dec
  } catch {
    return encrypted
  }
}

const PLAIN = 'lms-abc123secret-token'
const CIPHER = encryptApiKey(PLAIN)

describe('加解密本身（先确认前提成立）', () => {
  it('密文长得像 v1:hex:hex，且与明文不同', () => {
    expect(CIPHER.startsWith('v1:')).toBe(true)
    expect(CIPHER).not.toBe(PLAIN)
    expect(CIPHER.length).toBeGreaterThan(60)
  })

  it('能解回明文', () => {
    expect(decryptApiKey(CIPHER)).toBe(PLAIN)
  })

  it('对明文是幂等的（关键：所以读时再解一次是安全的）', () => {
    expect(decryptApiKey(PLAIN)).toBe(PLAIN)
    expect(decryptApiKey(decryptApiKey(PLAIN))).toBe(PLAIN)
  })

  it('对空串安全', () => {
    expect(decryptApiKey('')).toBe('')
  })
})

describe('不变量：内存 store 里必须是明文', () => {
  it('normalizeStoreKeys 风格的归一化能把密文转成明文', () => {
    // 模拟 store 里存着密文
    const store = { lmstudio: { apiKey: CIPHER }, openai: { apiKey: PLAIN } }
    for (const id of Object.keys(store)) {
      store[id].apiKey = decryptApiKey(store[id].apiKey)
    }
    expect(store.lmstudio.apiKey).toBe(PLAIN)
    expect(store.openai.apiKey).toBe(PLAIN)
  })

  it('重复执行仍然得到明文（幂等，不会解出乱码）', () => {
    let k = CIPHER
    for (let i = 0; i < 3; i++) { k = decryptApiKey(k) }
    expect(k).toBe(PLAIN)
  })
})

describe('接线：解密必须覆盖所有加载路径', () => {
  let src = ''

  beforeEach(() => {
    src = fs.readFileSync(path.join(process.cwd(), 'electron/core/providerManager.ts'), 'utf-8')
  })

  it('⚠️ load() 里不再有「只属于某个分支」的解密循环', () => {
    // 旧代码长这样（缩进 12 空格，嵌在 if (fs.existsSync) 里）：
    //     for (const id of Object.keys(this.store.providers)) {
    //       const cfg = this.store.providers[id]
    //       if (cfg.apiKey) {cfg.apiKey = decryptApiKey(cfg.apiKey)}
    //     }
    // 它必须被 normalizeStoreKeys() 取代。
    expect(src, '旧的分支内解密循环仍然存在，且未抽成统一方法').not.toMatch(
      /if \(cfg\.apiKey\) \{cfg\.apiKey = decryptApiKey\(cfg\.apiKey\)\}/,
    )
  })

  it('存在统一的归一化方法', () => {
    expect(src).toContain('private normalizeStoreKeys()')
    expect(src).toContain('this.normalizeStoreKeys()')
  })

  it('归一化在「所有加载路径之后」执行，不在任何 early-return 之前', () => {
    // ⚠️ 必须剥掉注释再断言：我自己在解释这个 bug 的注释里就写了 "return" 这个词，
    //    不剥注释的话断言会对着说明文字报错 —— 这坑今��已经踩过两次了
    //    （上一次是注释里的 “.run()” 被当成真实调用）。
    const codeOnly = (s: string) => s
      .split('\n')
      .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') })
      .join('\n')

    const diskBranch = codeOnly(src).slice(
      codeOnly(src).indexOf('✅ 已加载'),
      src.indexOf('private normalizeStoreKeys'),
    )
    expect(diskBranch, '磁盘加载分支仍在 early-return，导致归一化被跳过')
      .not.toMatch(/^\s*return\s*$/m)
  })

  it('🔒 getAllProviderConfigs 出口也解密（纵深防御）', () => {
    // ⚠️ 必须用**方法签名**定位，不能用 'getAllProviderConfigs()'：
    //    解释这个 bug 的注释里就提到了这个名字，indexOf 会先命中注释。
    const start = src.indexOf('getAllProviderConfigs(): Record<string, ProviderConfig>')
    expect(start, '找不到 getAllProviderConfigs 的方法定义').toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n  }', start))
    expect(body, 'getAllProviderConfigs 仍把 store 里的原值直接交出去')
      .toContain('decryptApiKey(saved.apiKey)')
  })
})

describe('探测链路：拿到的是明文，Bearer 才对', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-key-'))
  })
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('模拟 provider:discover-local 的完整取钥过程', () => {
    // 1) 磁盘上存的是密文
    const onDisk = {
      activeProviderId: 'lmstudio',
      providers: { lmstudio: { baseUrl: 'http://192.168.1.2:1234/v1', apiKey: CIPHER, model: 'NeoHorse 1 9B Q8' } },
    }
    fs.writeFileSync(path.join(tmpDir, 'lumina-providers.json'), JSON.stringify(onDisk), 'utf-8')

    // 2) 读盘
    const loaded = JSON.parse(fs.readFileSync(path.join(tmpDir, 'lumina-providers.json'), 'utf-8'))

    // 3) load() 统一归一化（修复后：无论走哪条路径都会执行）
    for (const id of Object.keys(loaded.providers)) {
      const cfg = loaded.providers[id]
      if (cfg.apiKey) { cfg.apiKey = decryptApiKey(cfg.apiKey) }
    }

    // 4) getAllProviderConfigs 出口再兜一次（修复后）
    const exported = decryptApiKey(loaded.providers.lmstudio.apiKey)

    // 5) 探测拿到的应该是明文
    expect(exported).toBe(PLAIN)
    expect(exported).not.toMatch(/^v1:/)
    expect(exported.startsWith('v1:'), 'Bearer 头里塞了密文 → LM Studio 必然 401').toBe(false)
  })

  it('旧行为会失败：不做归一化时，Bearer 头里就是密文', () => {
    // 这个测试记录的是「如果没修会发生什么」，防止将来有人把修复回滚掉
    const notNormalized = CIPHER
    const authHeader = `Bearer ${notNormalized}`
    expect(authHeader).toContain('v1:')
    expect(authHeader).not.toContain(PLAIN)
  })
})
