import express from 'express'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { getConfig } from './config.js'
import { getDb, migrate } from './storage/db.js'
import { initEncryptionKey } from './security/secrets.js'
import { rateLimit, clientIp } from './security/rateLimit.js'
import { asyncHandler, errorHandler } from './http/errors.js'
import { authRouter, mcpClientKey, requireMcpOrigin, requireMcpToken, requireSameOrigin } from './auth/auth.js'
import { handleSseConnection, handleSseMessage, handleStreamableHttp } from './mcp-host/server.js'
import routes from './api/routes.js'
import { consentRouter, oauthRouter } from './auth/oauth.js'

export async function initialize(): Promise<{ keySource: string; encryptedLegacySecrets: number; orphanApps: number }> {
  const { source } = initEncryptionKey()
  const migration = await migrate()
  return { keySource: source, ...migration }
}

function trustProxySetting(value: string): boolean | number | string {
  if (value === 'true') return true
  if (/^\d+$/.test(value)) return Number(value)
  return value
}

export function createApp(): express.Express {
  const config = getConfig()
  const app = express()
  app.disable('x-powered-by')
  if (config.trustProxy) app.set('trust proxy', trustProxySetting(config.trustProxy))
  app.use(helmet())

  if (config.allowedOrigins.length) {
    app.use('/api', cors({ origin: config.allowedOrigins, credentials: true }))
  }

  // Readiness: fails (503) when the database is unusable, so Docker/PM2 health checks can act.
  app.get('/health', async (_req, res) => {
    try {
      await getDb().execute('SELECT 1')
      res.json({ status: 'ok' })
    } catch {
      res.status(503).json({ status: 'unavailable' })
    }
  })

  // ── OAuth 2.1 authorization server (discovery, DCR, authorize, token, revoke) ──
  app.use(oauthRouter())

  // ── MCP: Streamable HTTP at /mcp/:appId (current spec), legacy SSE at /mcp/:appId/sse ──
  // Bearer token on every request; SSE messages are bound to the session's app + token.
  app.post(
    '/mcp/:appId',
    requireMcpOrigin,
    requireMcpToken,
    rateLimit('api', mcpClientKey),
    express.json({ limit: '256kb' }),
    asyncHandler(handleStreamableHttp)
  )
  app.all('/mcp/:appId', requireMcpOrigin, requireMcpToken, (_req, res) => {
    // Stateless server: no standalone GET stream and no sessions to DELETE.
    res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
  })
  app.get('/mcp/:appId/sse', requireMcpOrigin, rateLimit('sse'), requireMcpToken, asyncHandler(handleSseConnection))
  app.post(
    '/mcp/:appId/messages',
    requireMcpOrigin,
    requireMcpToken,
    rateLimit('api', mcpClientKey),
    express.json({ limit: '256kb' }),
    asyncHandler(handleSseMessage)
  )

  // ── Dashboard API (session cookie) ──
  app.use(
    '/api',
    rateLimit('api', req => `ip:${clientIp(req)}`),
    requireSameOrigin,
    express.json({ limit: '1mb' }),
    cookieParser()
  )
  app.use('/api/auth', authRouter())
  app.use('/api/oauth', consentRouter())
  app.use('/api', routes)

  // Serve the built dashboard from the same origin, so session cookies and the Origin check work
  // without extra proxy configuration.
  const dashboardDir = process.env.MCPHUB_DASHBOARD_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/dist')
  if (config.isProduction && existsSync(join(dashboardDir, 'index.html'))) {
    app.use(express.static(dashboardDir, { index: false, maxAge: '1h' }))
    app.get(/^\/(?!api\/|mcp\/|assets\/|\.well-known\/|authorize|token|register|revoke|health$).*/, (_req, res) => res.sendFile(join(dashboardDir, 'index.html')))
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })
  app.use(errorHandler)
  return app
}
