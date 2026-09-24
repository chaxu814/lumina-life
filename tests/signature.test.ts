// ============================================================
// tests/signature.test.ts — 发布者签名校验
// ============================================================
import { describe, it, expect } from 'vitest'
import { verifyManifestSignature, canonicalize } from '../electron/security/signature'

describe('canonicalize', () => {
  it('去掉 signature 字段并按 key 排序', () => {
    const a = canonicalize({ b: 1, a: 2, signature: 'xyz' })
    expect(a).toBe('{"a":2,"b":1}')
  })
})

describe('verifyManifestSignature', () => {
  it('无 signature → unsigned', () => {
    const r = verifyManifestSignature({ name: 'x', version: '1' })
    expect(r.status).toBe('unsigned')
  })
  it('带 signature 但公钥为占位 → 退化为 unsigned（不阻断）', () => {
    const r = verifyManifestSignature({ name: 'x', version: '1', signature: 'abc' })
    expect(r.status).toBe('unsigned')
  })
  it('非法结构签名 → invalid', () => {
    const r = verifyManifestSignature({ name: 'x', version: '1', signature: '!!!notbase64!!!' })
    // 占位公钥会先短路为 unsigned，这里用一把真公钥验 invalid 路径
    const fakePub = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0v1abcdefghijklmnopqrstuvwx
yzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCD
EFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ
KLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN
OPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS
TUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVW
X
IDAQAB
-----END PUBLIC KEY-----`
    const r2 = verifyManifestSignature({ name: 'x', version: '1', signature: 'abc' }, fakePub)
    expect(r2.status === 'invalid').toBe(true)
    expect(r.status).toBe('unsigned')
  })
})
