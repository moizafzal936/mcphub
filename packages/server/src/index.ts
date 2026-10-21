import type { Server } from 'http'
import { getConfig } from './config.js'
import { createApp, initialize } from './app.js'
import { closeDb, purgeExpired } from './storage/db.js'
import { closeSessions } from './mcp-host/server.js'

let server: Server | undefined
let purgeTimer: NodeJS.Timeout | undefined
let shuttingDown = false

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] ${reason}; closing connections`)
  setTimeout(() => {
    console.error('[shutdown] timed out, forcing exit')
    process.exit(exitCode || 1)
  }, 10_000).unref()

  if (purgeTimer) clearInterval(purgeTimer)
  const closed = new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
  // Open SSE streams would otherwise keep the server alive until the forced exit.
  await closeSessions(() => true)
  server?.closeIdleConnections()
  await closed
  closeDb()
  process.exit(exitCode)
}

// Request-level failures are handled by asyncHandler/errorHandler. Anything reaching here is a
// bug: log it and exit so the process manager restarts from a clean state.
process.on('uncaughtException', err => {
  console.error('[fatal] uncaught exception:', err)
  process.exit(1)
})
process.on('unhandledRejection', reason => {
  console.error('[fatal] unhandled rejection:', reason)
  process.exit(1)
})
process.on('SIGTERM', () => void shutdown('SIGTERM', 0))
process.on('SIGINT', () => void shutdown('SIGINT', 0))

async function main() {
  const config = getConfig()
  const init = await initialize()
  if (init.keySource === 'dev-file') {
    console.warn(`[security] Using a generated development encryption key in ${config.dataDir}/.encryption-key. Set MCPHUB_ENCRYPTION_KEY for any real deployment.`)
  }
  if (init.encryptedLegacySecrets) console.log(`[security] Encrypted ${init.encryptedLegacySecrets} legacy plaintext credential(s)`)
  if (init.orphanApps) {
    console.warn(`[security] ${init.orphanApps} app(s) have no owner and are inaccessible. Assign them with: npm run assign-orphans -w packages/server -- <email>`)
  }
  if (config.ssrfAllow.length) console.warn(`[security] SSRF allowlist active for: ${config.ssrfAllow.join(', ')}`)

  const runPurge = () => purgeExpired(config.logRetentionDays, config.logMaxPerApp).catch(err => console.error('[purge] failed:', err))
  await runPurge()
  purgeTimer = setInterval(runPurge, 60 * 60 * 1000)
  purgeTimer.unref()

  server = createApp().listen(config.port, () => {
    console.log(`MCPHub server listening on http://localhost:${config.port} (${config.env})`)
  })
  server.on('error', err => {
    console.error('[fatal] server error:', err)
    process.exit(1)
  })
}

main().catch(err => {
  console.error('[fatal] failed to start:', err instanceof Error ? err.message : err)
  process.exit(1)
})
