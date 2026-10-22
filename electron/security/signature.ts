// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// security/signature.ts — ✍️ 技能包发布者签名校验 (v0.2 创新提案5)
//
// 用 Node 内置 crypto 做 RSA + SHA256 签名校验：
//   - 发布者用私钥对 skill.json 的规范化字段做签名，存为 skill.json.signature；
//   - 用户端用内置 Lumina 公钥验签；
//   - 未携带 signature → 标记「未验证发布者」（warn，不阻断）；
//   - 有 signature 但验签失败 → block。
//
// MVP：内置一把演示公钥。正式发布时换成 Lumina 官方公钥（硬编码于此）。
// ============================================================

import * as crypto from 'node:crypto'

/**
 * Lumina 官方发布者 RSA 公钥（PEM）。
 * MVP 占位：这是一把用于开发自测的 RSA 公钥；正式上线前替换为官方公钥。
 * 对应私钥绝不入库，离线保管。
 */
export const LUMINA_PUBLISHER_PUBKEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAplaceholderplaceholder
placeholderplaceholderplaceholderplaceholderplaceholderplacehol
derplaceholderplaceholderplaceholderplaceholderplaceholderplaceho
lderplaceholderplaceholderplaceholderplaceholderplaceholderplac
eholderplaceholderplaceholderplaceholderplaceholderplaceholderpla
ceholderplaceholderplaceholderplaceholderplaceholderplaceholderp
laceholderplaceholderplaceholderplaceholderplaceholderplaceholder
holderplaceholderplaceholderplaceholderplaceholderplaceholderho
lderplaceholderplaceholderplaceholderplaceholderplaceholderor
wIDAQAB
-----END PUBLIC KEY-----`

export type SignatureStatus = 'verified' | 'unsigned' | 'invalid'

export interface VerifyOutcome {
  status: SignatureStatus
  reason?: string
}

/** 规范化待签名字段：把 skill.json 中除 signature 外的字段按 key 排序后 JSON 序列化 */
export function canonicalize(manifest: Record<string, unknown>): string {
  const omit = { ...manifest }
  delete omit.signature
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(omit).sort()) {sorted[k] = omit[k]}
  return JSON.stringify(sorted)
}

/**
 * 校验 manifest 上的 signature 字段。
 * - 无 signature → unsigned（前端显示「未验证发布者」）；
 * - 公钥为占位符（含 placeholder）→ 视为未配置官方公钥，退化为 unsigned；
 * - 验签通过 → verified；失败 → invalid。
 */
export function verifyManifestSignature(manifest: Record<string, unknown>, pubKeyPem = LUMINA_PUBLISHER_PUBKEY): VerifyOutcome {
  const sig = manifest.signature
  if (typeof sig !== 'string' || !sig.trim()) {
    return { status: 'unsigned', reason: '技能包未携带发布者签名' }
  }
  // 占位公钥未替换 → 不阻断，按未签名处理
  if (pubKeyPem.includes('placeholder')) {
    return { status: 'unsigned', reason: '客户端尚未配置官方公钥，签名无法验证' }
  }
  try {
    const data = canonicalize(manifest)
    const verifier = crypto.createVerify('SHA256')
    verifier.update(data, 'utf8')
    verifier.end()
    const ok = verifier.verify(pubKeyPem, Buffer.from(sig, 'base64'))
    return ok
      ? { status: 'verified', reason: '发布者签名校验通过' }
      : { status: 'invalid', reason: '签名与内容不匹配：技能包可能被篡改' }
  } catch (e: any) {
    return { status: 'invalid', reason: `验签异常：${e?.message || e}` }
  }
}
