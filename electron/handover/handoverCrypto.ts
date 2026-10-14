// ============================================================
// handover/handoverCrypto.ts — 交班卡片本地加密导出
//
// 【算法来源】复用 electron/core/providerKeyCrypto.ts 的底层原语：
//   · scrypt 派生（与 providerKeyCrypto 同一 scryptSync 调用族，仅 salt 改为每次随机）
//   · crypto.createCipheriv AES 对称加密
//   不另造算法；仅把 CBC 换成 GCM（AEAD），因为交班容器需要
//   「篡改检测」能力（tag 校验），CBC 没有认证标签。
//
// 【两种口令来源】
//   1. 用户口令：scrypt（文件导出，Node 往返）或 pbkdf2-sha256（局域网 H5，
//      可被手机浏览器 WebCrypto 同参数解密，口令不出电脑）。
//   2. 本机密钥：复用项目已有的 safeStorage 封装模式（见 sync/syncConfig.ts），
//      Windows 上即 DPAPI，仅本机可解，无需记口令；非 Electron 单测环境退化为
//      base64 占位（与 syncConfig 同一降级策略，仅测试用）。
//
// 【容器格式】.lumina-handover = JSON：
//   { v, kdf, salt, iv, tag, ct }（hex / base64 字段）
// ============================================================

import * as crypto from 'crypto'
import type { HandoverCard } from './handoverTypes'

export type HandoverKdf = 'scrypt' | 'pbkdf2-sha256' | 'machine'

export interface HandoverContainer {
  v: 1
  kdf: HandoverKdf
  salt: string
  iv: string
  tag: string
  ct: string
}

const IV_LENGTH = 12        // GCM 推荐 96-bit nonce
const TAG_LENGTH = 16
const KEY_LENGTH = 32        // AES-256
const PBKDF2_ITERATIONS = 150000

// ── 密钥派生（复用 providerKeyCrypto 的 scrypt 原语）────────────

function deriveKey(password: string, salt: Buffer, kdf: HandoverKdf): Buffer {
  if (kdf === 'scrypt') {
    // 与 providerKeyCrypto 相同：crypto.scryptSync(pass, salt, 32)（默认 N=16384,r=8,p=1）
    return crypto.scryptSync(password, salt, KEY_LENGTH)
  }
  if (kdf === 'pbkdf2-sha256') {
    // 与手机端 WebCrypto PBKDF2-SHA256 完全同参数：iter=150000, len=32, sha-256
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
  }
  throw new Error(`deriveKey: kdf=${kdf} 不是口令派生`)
}

// ── 本机密钥（safeStorage 封装，降级策略对齐 sync/syncConfig.ts）──

function safeStorageLike(): {
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
  isAvailable(): boolean
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron')
    const ss = electron?.safeStorage
    if (ss && typeof ss.encryptString === 'function') {return ss}
  } catch { /* 非 Electron 环境 */ }
  return null
}

// ── 加密 ────────────────────────────────────────────────────

export function encryptCardWithPassword(
  card: HandoverCard,
  password: string,
  kdf: 'scrypt' | 'pbkdf2-sha256' = 'scrypt',
): HandoverContainer {
  if (!password) {throw new Error('口令不能为空')}
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(IV_LENGTH)
  const key = deriveKey(password, salt, kdf)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(card), 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: 1,
    kdf,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ct: ct.toString('base64'),
  }
}

export function encryptCardWithMachineKey(card: HandoverCard): HandoverContainer {
  const payload = JSON.stringify(card)
  const ss = safeStorageLike()
  if (ss && ss.isAvailable()) {
    return {
      v: 1,
      kdf: 'machine',
      salt: '',
      iv: '',
      tag: '',
      ct: ss.encryptString(payload).toString('base64'),
    }
  }
  // 非 Electron 环境（单测）：与 syncConfig 同一 base64 占位降级（ct 存字面量文本）
  return {
    v: 1,
    kdf: 'machine',
    salt: '',
    iv: '',
    tag: '',
    ct: 'base64:' + Buffer.from(payload, 'utf-8').toString('base64'),
    // 注：ct 字段直接保存 "base64:xxxx" 文本（非二次编码），解密侧按 startsWith 识别
  }
}

// ── 解密 ────────────────────────────────────────────────────

export function decryptContainer(container: HandoverContainer, password?: string): HandoverCard {
  if (container.v !== 1) {throw new Error('不支持的容器版本')}

  if (container.kdf === 'machine') {
    // ct 为占位文本 "base64:xxxx"（单测降级）或 safeStorage 密文的 base64
    if (container.ct.startsWith('base64:')) {
      return JSON.parse(Buffer.from(container.ct.slice(7), 'base64').toString('utf-8')) as HandoverCard
    }
    const ss = safeStorageLike()
    if (ss && ss.isAvailable()) {
      return JSON.parse(ss.decryptString(Buffer.from(container.ct, 'base64'))) as HandoverCard
    }
    throw new Error('safeStorage 不可用，无法解密本机密钥容器')
  }

  if (!password) {throw new Error('口令容器需要 password')}
  const salt = Buffer.from(container.salt, 'hex')
  const iv = Buffer.from(container.iv, 'hex')
  const tag = Buffer.from(container.tag, 'hex')
  const key = deriveKey(password, salt, container.kdf)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  // 口令错误或密文被篡改：final() 抛 AEAD 校验失败
  const plain = Buffer.concat([
    decipher.update(Buffer.from(container.ct, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plain.toString('utf-8')) as HandoverCard
}

/** 容器 <-> 文件字符串往返（.lumina-handover 就是 JSON 文件本体） */
export function containerToString(c: HandoverContainer): string {
  return JSON.stringify(c, null, 2)
}

export function parseContainer(s: string): HandoverContainer {
  const obj = JSON.parse(s) as HandoverContainer
  if (obj.v !== 1 || !obj.kdf || typeof obj.ct !== 'string') {
    throw new Error('不是合法的交班容器')
  }
  return obj
}
