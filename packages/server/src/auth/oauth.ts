import { Router, type Response } from 'express'
import { z } from 'zod'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { InvalidGrantError, InvalidTargetError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js'
import { dashboardUrl, issuerUrl } from '../config.js'
import { appRepo, getDb, newId, tokenRepo } from '../storage/db.js'
import { encryptSecret, decryptSecret } from '../security/secrets.js'
import { randomToken, sha256 } from '../security/passwords.js'
import { asyncHandler, HttpError } from '../http/errors.js'
import { closeSessions } from '../mcp-host/server.js'
import { MCP_TOKEN_PREFIX, requireUser, verifyMcpAccessToken } from './auth.js'

const ACCESS_TTL_MS = 60 * 60 * 1000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const CODE_TTL_MS = 5 * 60 * 1000
const REQUEST_TTL_MS = 10 * 60 * 1000
export const MCP_SCOPE = 'mcp:tools'

/** Maps an MCP resource URL (RFC 8707) on this server to the app it serves. */
export function appIdFromResource(resource: URL | string | undefined): string | undefined {
  if (!resource) return undefined
  let url: URL
  try {
    url = new URL(String(resource))
  } catch {
    return undefined
  }
  if (url.origin !== new URL(issuerUrl()).origin || url.search || url.hash) return undefined
  return url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{1,64})(?:\/sse)?\/?$/)?.[1]
}

function canonicalResource(appId: string): string {
  return `${issuerUrl()}/mcp/${appId}`
}

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const res = await getDb().execute({ sql: 'SELECT info FROM oauth_clients WHERE client_id = ?', args: [clientId] })
    if (!res.rows[0]) return undefined
    const info = JSON.parse(String(res.rows[0].info)) as OAuthClientInformationFull
    if (info.client_secret) info.client_secret = decryptSecret(info.client_secret, `oauth-client:${clientId}`)
    return info
  },
  async registerClient(client) {
    const full = { ...client, client_id: newId(), client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull
    const stored = { ...full, ...(full.client_secret ? { client_secret: encryptSecret(full.client_secret, `oauth-client:${full.client_id}`) } : {}) }
    await getDb().execute({
      sql: 'INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)',
      args: [full.client_id, JSON.stringify(stored), Date.now()],
    })
    return full
  },
}

async function issueTokens(grant: { id: string; clientId: string; userId: string; appId: string }, refreshToken: string): Promise<OAuthTokens> {
  const access = `${MCP_TOKEN_PREFIX}${randomToken(32)}`
  const now = Date.now()
  await tokenRepo.insert({
    id: newId(), appId: grant.appId, userId: grant.userId, name: 'OAuth access token',
    prefix: access.slice(0, MCP_TOKEN_PREFIX.length + 6), createdAt: now, expiresAt: now + ACCESS_TTL_MS,
    lastUsedAt: null, revokedAt: null,
  }, sha256(access), { grantId: grant.id })
  return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refreshToken, scope: MCP_SCOPE }
}

async function revokeGrant(grantId: string): Promise<void> {
  const now = Date.now()
  await getDb().batch([
    { sql: 'UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', args: [now, grantId] },
    { sql: 'UPDATE mcp_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', args: [now, grantId] },
  ], 'write')
}

export const oauthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore
  },

  // Park the request and send the browser to the dashboard consent page (which requires sign-in).
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const appId = appIdFromResource(params.resource)
    if (!appId) throw new InvalidTargetError('resource must be an MCP server URL on this host, e.g. ' + canonicalResource('<appId>'))
    if (params.scopes?.some(s => s !== MCP_SCOPE)) throw new InvalidRequestError(`Only the "${MCP_SCOPE}" scope is supported`)
    const id = randomToken(24)
    await getDb().execute({
      sql: `INSERT INTO oauth_requests (id, client_id, app_id, redirect_uri, code_challenge, state, resource, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, client.client_id, appId, params.redirectUri, params.codeChallenge, params.state ?? null, canonicalResource(appId), Date.now() + REQUEST_TTL_MS],
    })
    res.redirect(302, `${dashboardUrl()}/oauth/consent?request=${encodeURIComponent(id)}`)
  },

  async challengeForAuthorizationCode(client, code) {
    const res = await getDb().execute({
      sql: 'SELECT code_challenge FROM oauth_codes WHERE code_hash = ? AND client_id = ? AND used_at IS NULL AND expires_at > ?',
      args: [sha256(code), client.client_id, Date.now()],
    })
    if (!res.rows[0]) throw new InvalidGrantError('Invalid or expired authorization code')
    return String(res.rows[0].code_challenge)
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const db = getDb()
    const hash = sha256(code)
    const found = await db.execute({ sql: 'SELECT * FROM oauth_codes WHERE code_hash = ? AND client_id = ?', args: [hash, client.client_id] })
    const row = found.rows[0]
    if (!row) throw new InvalidGrantError('Invalid authorization code')
    // Single use: only one concurrent exchange can flip used_at.
    const claimed = await db.execute({
      sql: 'UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
      args: [Date.now(), hash, Date.now()],
    })
    if (claimed.rowsAffected !== 1) throw new InvalidGrantError('Authorization code expired or already used')
    if (redirectUri !== undefined && redirectUri !== String(row.redirect_uri)) throw new InvalidGrantError('redirect_uri does not match the authorization request')
    if (resource !== undefined && appIdFromResource(resource) !== String(row.app_id)) throw new InvalidTargetError('resource does not match the authorization request')

    const userId = String(row.user_id)
    const appId = String(row.app_id)
    if (!(await appRepo.findForOwner(appId, userId))) throw new InvalidGrantError('The MCP server is no longer available')

    const refresh = randomToken(32)
    const grant = { id: newId(), clientId: client.client_id, userId, appId }
    await db.execute({
      sql: `INSERT INTO oauth_grants (id, client_id, client_name, user_id, app_id, resource, refresh_hash, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [grant.id, client.client_id, (client.client_name ?? 'MCP client').slice(0, 100), userId, appId, String(row.resource), sha256(refresh), Date.now(), Date.now() + REFRESH_TTL_MS],
    })
    return issueTokens(grant, refresh)
  },

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    if (scopes?.some(s => s !== MCP_SCOPE)) throw new InvalidRequestError(`Only the "${MCP_SCOPE}" scope is supported`)
    const db = getDb()
    const hash = sha256(refreshToken)
    const res = await db.execute({
      sql: 'SELECT * FROM oauth_grants WHERE refresh_hash = ? AND client_id = ? AND revoked_at IS NULL AND expires_at > ?',
      args: [hash, client.client_id, Date.now()],
    })
    const row = res.rows[0]
    if (!row) {
      // A rotated-out refresh token being replayed means it leaked: kill the whole grant.
      const reused = await db.execute({ sql: 'SELECT id FROM oauth_grants WHERE prev_refresh_hash = ? AND client_id = ?', args: [hash, client.client_id] })
      if (reused.rows[0]) await revokeGrant(String(reused.rows[0].id))
      throw new InvalidGrantError('Invalid refresh token')
    }
    if (resource !== undefined && appIdFromResource(resource) !== String(row.app_id)) throw new InvalidTargetError('resource does not match the grant')
    const userId = String(row.user_id)
    const appId = String(row.app_id)
    if (!(await appRepo.findForOwner(appId, userId))) throw new InvalidGrantError('The MCP server is no longer available')

    const next = randomToken(32)
    const rotated = await db.execute({
      sql: 'UPDATE oauth_grants SET refresh_hash = ?, prev_refresh_hash = ?, last_used_at = ? WHERE id = ? AND refresh_hash = ?',
      args: [sha256(next), hash, Date.now(), String(row.id), hash],
    })
    if (rotated.rowsAffected !== 1) throw new InvalidGrantError('Invalid refresh token')
    return issueTokens({ id: String(row.id), clientId: client.client_id, userId, appId }, next)
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return verifyMcpAccessToken(token)
  },

  async revokeToken(client, request: OAuthTokenRevocationRequest) {
    const hash = sha256(request.token)
    const db = getDb()
    const grant = await db.execute({ sql: 'SELECT id FROM oauth_grants WHERE refresh_hash = ? AND client_id = ?', args: [hash, client.client_id] })
    if (grant.rows[0]) {
      await revokeGrant(String(grant.rows[0].id))
      return
    }
    await db.execute({
      sql: `UPDATE mcp_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL
              AND grant_id IN (SELECT id FROM oauth_grants WHERE client_id = ?)`,
      args: [Date.now(), hash, client.client_id],
    })
  },
}

/** Authorization-server endpoints (SDK) plus per-app protected-resource metadata (RFC 9728). */
export function oauthRouter(): Router {
  const router = Router()
  const issuer = new URL(issuerUrl())

  router.get('/.well-known/oauth-protected-resource/mcp/:appId', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*').json({
      resource: canonicalResource(req.params.appId),
      authorization_servers: [issuer.href],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'MCPHub',
    })
  })
  router.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl: issuer, scopesSupported: [MCP_SCOPE], resourceName: 'MCPHub' }))
  return router
}

export function protectedResourceMetadataUrl(appId: string): string {
  return `${issuerUrl()}/.well-known/oauth-protected-resource/mcp/${appId}`
}

// ── Consent API used by the dashboard (cookie session + CSRF guard) ─────────────

async function loadRequest(id: string) {
  const res = await getDb().execute({ sql: 'SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?', args: [id, Date.now()] })
  return res.rows[0]
}

export function consentRouter(): Router {
  const router = Router()
  router.use(requireUser)

  router.get('/requests/:id', asyncHandler(async (req, res) => {
    const row = await loadRequest(req.params.id)
    if (!row) throw new HttpError(404, 'This authorization request has expired. Start again from your MCP client.')
    const app = await appRepo.findForOwner(String(row.app_id), req.user!.id)
    if (!app) throw new HttpError(404, 'This MCP server is not in your account')
    const client = await clientsStore.getClient(String(row.client_id))
    res.json({
      clientName: client?.client_name ?? 'An MCP client',
      redirectHost: new URL(String(row.redirect_uri)).host || String(row.redirect_uri).split(':')[0],
      app: { id: app.id, name: app.name, baseUrl: app.baseUrl },
      scopes: [MCP_SCOPE],
    })
  }))

  router.post('/requests/:id/decision', asyncHandler(async (req, res) => {
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body)
    const db = getDb()
    const row = await loadRequest(req.params.id)
    if (!row) throw new HttpError(404, 'This authorization request has expired. Start again from your MCP client.')
    const app = await appRepo.findForOwner(String(row.app_id), req.user!.id)
    if (!app) throw new HttpError(404, 'This MCP server is not in your account')
    // Consume the request so it can only be decided once.
    const consumed = await db.execute({ sql: 'DELETE FROM oauth_requests WHERE id = ?', args: [req.params.id] })
    if (consumed.rowsAffected !== 1) throw new HttpError(409, 'This request was already handled')

    const redirect = new URL(String(row.redirect_uri))
    if (row.state != null) redirect.searchParams.set('state', String(row.state))
    redirect.searchParams.set('iss', issuerUrl())
    if (!approve) {
      redirect.searchParams.set('error', 'access_denied')
      res.json({ redirectUrl: redirect.href })
      return
    }
    const code = randomToken(32)
    await db.execute({
      sql: `INSERT INTO oauth_codes (code_hash, client_id, user_id, app_id, redirect_uri, code_challenge, resource, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [sha256(code), String(row.client_id), req.user!.id, app.id, String(row.redirect_uri), String(row.code_challenge), String(row.resource), Date.now() + CODE_TTL_MS],
    })
    redirect.searchParams.set('code', code)
    res.json({ redirectUrl: redirect.href })
  }))

  return router
}

// ── Grants listing / revocation for the app owner ──────────────────────────────

export async function listGrants(appId: string) {
  const res = await getDb().execute({
    sql: 'SELECT id, client_name, created_at, last_used_at, expires_at, revoked_at FROM oauth_grants WHERE app_id = ? ORDER BY created_at DESC',
    args: [appId],
  })
  return res.rows.map(r => ({
    id: String(r.id),
    clientName: String(r.client_name),
    createdAt: Number(r.created_at),
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    expiresAt: Number(r.expires_at),
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
  }))
}

export async function revokeGrantInApp(appId: string, grantId: string): Promise<boolean> {
  const res = await getDb().execute({ sql: 'SELECT id FROM oauth_grants WHERE id = ? AND app_id = ?', args: [grantId, appId] })
  if (!res.rows[0]) return false
  const tokens = await getDb().execute({ sql: 'SELECT id FROM mcp_tokens WHERE grant_id = ?', args: [grantId] })
  await revokeGrant(grantId)
  const ids = new Set(tokens.rows.map(r => String(r.id)))
  await closeSessions(s => ids.has(s.tokenId))
  return true
}
