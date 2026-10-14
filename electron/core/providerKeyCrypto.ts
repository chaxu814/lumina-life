import * as crypto from 'crypto'

// Shared with ProviderManager's existing on-disk v1 format. Keep format/key stable
// so both the global provider store and AgentConfig can exchange decrypted keys.
const CIPHER_KEY = crypto.scryptSync('lumina-provider-key-v1', 'provider-salt', 32)
const IV_LENGTH = 16

export function encryptProviderApiKey(text: string): string {
  if (!text) {return ''}
  try {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv('aes-256-cbc', CIPHER_KEY, iv)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return `v1:${iv.toString('hex')}:${encrypted}`
  } catch {
    return text
  }
}

/** Idempotent for plaintext and legacy non-v1 values. */
export function decryptProviderApiKey(value: string): string {
  if (!value) {return ''}
  try {
    const parts = value.split(':')
    if (parts[0] !== 'v1' || parts.length < 3) {return value}
    const iv = Buffer.from(parts[1], 'hex')
    const encrypted = parts.slice(2).join(':')
    const decipher = crypto.createDecipheriv('aes-256-cbc', CIPHER_KEY, iv)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch {
    return value
  }
}
