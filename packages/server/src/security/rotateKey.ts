import { copyFileSync } from 'fs'
import type { InStatement } from '@libsql/client'
import { getConfig } from '../config.js'
import { getDb } from '../storage/db.js'
import { appSecretContext, decodeKey, decryptSecret, encryptSecret, fixedParamContext, isEncrypted } from './secrets.js'

/**
 * Re-encrypts every stored secret from `oldKeyB64` to `newKeyB64` in one transaction, after a
 * file backup. Everything is decrypted first, so nothing is written unless all secrets verify.
 */
export async function rotateEncryptionKey(oldKeyB64: string, newKeyB64: string): Promise<{ secrets: number; backup: string }> {
  const oldKey = decodeKey(oldKeyB64)
  const newKey = decodeKey(newKeyB64)
  if (oldKey.equals(newKey)) throw new Error('New key must differ from the current key')

  const db = getDb()
  const backup = `${getConfig().dbPath}.bak-${Date.now()}`
  await db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  copyFileSync(getConfig().dbPath, backup)

  const updates: InStatement[] = []
  const apps = await db.execute("SELECT id, api_key FROM apps WHERE api_key IS NOT NULL AND api_key != ''")
  for (const r of apps.rows) {
    const ctx = appSecretContext(String(r.id))
    const value = String(r.api_key)
    if (!isEncrypted(value)) throw new Error(`App ${r.id} has a plaintext credential; start the server once to migrate it`)
    const plain = decryptSecret(value, ctx, oldKey)
    updates.push({ sql: 'UPDATE apps SET api_key = ? WHERE id = ?', args: [encryptSecret(plain, ctx, newKey), String(r.id)] })
  }
  const fixed = await db.execute('SELECT id, fixed_params FROM apps WHERE fixed_params IS NOT NULL')
  for (const r of fixed.rows) {
    const params = JSON.parse(String(r.fixed_params)) as { in: string; name: string; secret: boolean; value?: string }[]
    if (!params.some(p => p.secret && p.value)) continue
    const rotated = params.map(p => {
      if (!p.secret || !p.value) return p
      const ctx = fixedParamContext(String(r.id), p.in, p.name)
      return { ...p, value: encryptSecret(decryptSecret(p.value, ctx, oldKey), ctx, newKey) }
    })
    updates.push({ sql: 'UPDATE apps SET fixed_params = ? WHERE id = ?', args: [JSON.stringify(rotated), String(r.id)] })
  }
  const clients = await db.execute('SELECT client_id, info FROM oauth_clients')
  for (const r of clients.rows) {
    const info = JSON.parse(String(r.info))
    if (!info.client_secret) continue
    const ctx = `oauth-client:${r.client_id}`
    info.client_secret = encryptSecret(decryptSecret(info.client_secret, ctx, oldKey), ctx, newKey)
    updates.push({ sql: 'UPDATE oauth_clients SET info = ? WHERE client_id = ?', args: [JSON.stringify(info), String(r.client_id)] })
  }
  const users = await db.execute('SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL')
  for (const r of users.rows) {
    const ctx = `totp:${r.id}`
    updates.push({
      sql: 'UPDATE users SET totp_secret = ? WHERE id = ?',
      args: [encryptSecret(decryptSecret(String(r.totp_secret), ctx, oldKey), ctx, newKey), String(r.id)],
    })
  }
  if (updates.length) await db.batch(updates, 'write')
  return { secrets: updates.length, backup }
}
