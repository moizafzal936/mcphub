import { mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { getConfig } from '../config.js'
import { closeDb, getDb } from '../storage/db.js'

// Consistent snapshot of the live database (safe while the server runs):
//   docker compose exec mcphub node packages/server/dist/cli/backup.js [keep=14]
// Secrets inside stay encrypted; the backup is useless without MCPHUB_ENCRYPTION_KEY, so store
// the key separately (password manager), never next to the backups.
const keep = Math.max(1, Number(process.argv[2]) || 14)
try {
  const dir = join(getConfig().dataDir, 'backups')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  const file = join(dir, `mcpify-${stamp}.db`)
  await getDb().execute({ sql: 'VACUUM INTO ?', args: [file] })
  const old = readdirSync(dir).filter(f => /^mcpify-\d{8}-\d{6}\.db$/.test(f)).sort().slice(0, -keep)
  for (const f of old) rmSync(join(dir, f))
  console.log(`Backup written: ${file}${old.length ? ` (removed ${old.length} older)` : ''}`)
} catch (err) {
  console.error('Backup failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  closeDb()
}
