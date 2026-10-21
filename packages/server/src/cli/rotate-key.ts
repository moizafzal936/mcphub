import { initialize } from '../app.js'
import { closeDb } from '../storage/db.js'
import { rotateEncryptionKey } from '../security/rotateKey.js'

// Usage: stop the server, then
//   MCPHUB_ENCRYPTION_KEY=<current> MCPHUB_NEW_ENCRYPTION_KEY=<new> npm run rotate-key -w packages/server
const current = process.env.MCPHUB_ENCRYPTION_KEY
const next = process.env.MCPHUB_NEW_ENCRYPTION_KEY
if (!current || !next) {
  console.error('Set MCPHUB_ENCRYPTION_KEY (current) and MCPHUB_NEW_ENCRYPTION_KEY (new, e.g. `openssl rand -base64 32`).')
  process.exit(1)
}
try {
  await initialize()
  const { secrets, backup } = await rotateEncryptionKey(current, next)
  console.log(`Re-encrypted ${secrets} secret(s). Backup: ${backup}`)
  console.log('Now set MCPHUB_ENCRYPTION_KEY to the new key and start the server.')
} catch (err) {
  console.error('Rotation aborted, nothing was changed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  closeDb()
}
