import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { getConfig } from '../config.js'

const PREFIX = 'enc:v1:'
let key: Buffer | undefined

function decodeKey(raw: string): Buffer {
  const buf = Buffer.from(raw.trim(), 'base64')
  if (buf.length !== 32) throw new Error('MCPHUB_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes')
  return buf
}

// Production requires MCPHUB_ENCRYPTION_KEY (enforced in loadConfig). Outside production a
// key is generated once into the data dir so local development works without setup.
export function initEncryptionKey(): { source: 'env' | 'dev-file' } {
  const config = getConfig()
  if (config.encryptionKey) {
    key = decodeKey(config.encryptionKey)
    return { source: 'env' }
  }
  if (config.isProduction) throw new Error('MCPHUB_ENCRYPTION_KEY is required in production')
  mkdirSync(config.dataDir, { recursive: true })
  const file = join(config.dataDir, '.encryption-key')
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
  }
  chmodSync(file, 0o600)
  key = decodeKey(readFileSync(file, 'utf8'))
  return { source: 'dev-file' }
}

function getKey(): Buffer {
  if (!key) throw new Error('Encryption key not initialised')
  return key
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX)
}

export function encryptSecret(plaintext: string, context: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`
}

export function decryptSecret(stored: string, context: string): string {
  if (!isEncrypted(stored)) throw new Error('Secret is not encrypted')
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split('.')
  if (!ivB64 || !tagB64 || ctB64 === undefined) throw new Error('Malformed encrypted secret')
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64url'))
  decipher.setAAD(Buffer.from(context, 'utf8'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8')
}

export function appSecretContext(appId: string): string {
  return `app-api-key:${appId}`
}
