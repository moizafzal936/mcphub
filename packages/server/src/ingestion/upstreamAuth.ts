import { createHash } from 'crypto'
import type { App, OAuthClientConfig } from '../types/index.js'
import { safeRequest, SsrfBlockedError } from '../security/ssrf.js'
import { isValidHeaderValue } from '../security/headers.js'
import { redactString } from '../security/redact.js'
import { secretForms } from './toolSchema.js'

/**
 * OAuth 2.0 client credentials (RFC 6749 §4.4) for upstream APIs: MCPHub exchanges the app's
 * client id and secret for a short-lived access token and sends it as a Bearer token. Tokens are
 * cached in memory per app and refreshed shortly before they expire.
 */

const REFRESH_EARLY_MS = 60_000
const DEFAULT_TTL_S = 300
const MAX_TTL_S = 24 * 3600
const TOKEN_TIMEOUT_MS = 10_000
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
const MAX_TOKEN_LENGTH = 8192

export class UpstreamAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamAuthError'
  }
}

interface CachedToken { token: string; expiresAt: number; fingerprint: string }
const cache = new Map<string, CachedToken>()
const inflight = new Map<string, Promise<CachedToken>>()

// Any change to the config or secret makes a different fingerprint, so a stale token is never reused.
function fingerprint(config: OAuthClientConfig, secret: string): string {
  return createHash('sha256').update(JSON.stringify([config.tokenUrl, config.clientId, config.scope, config.audience, config.clientAuth, secret])).digest('hex')
}

export interface TokenInfo { token: string; tokenType: string; expiresIn: number; scope?: string }

export async function requestToken(config: OAuthClientConfig, secret: string): Promise<TokenInfo> {
  const form = new URLSearchParams({ grant_type: 'client_credentials' })
  if (config.scope) form.set('scope', config.scope)
  if (config.audience) form.set('audience', config.audience)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (config.clientAuth === 'post') {
    form.set('client_id', config.clientId)
    form.set('client_secret', secret)
  } else {
    // RFC 6749 §2.3.1: form-encode the id and secret before Basic encoding.
    const pair = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(secret)}`
    headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`
  }
  const secrets = secretForms(secret)

  let res
  try {
    res = await safeRequest({
      method: 'POST', url: config.tokenUrl, headers, data: form.toString(), redirects: 'none',
      timeout: TOKEN_TIMEOUT_MS, maxContentLength: MAX_TOKEN_RESPONSE_BYTES, maxBodyLength: 16 * 1024,
    })
  } catch (err: any) {
    if (err instanceof SsrfBlockedError || err?.cause instanceof SsrfBlockedError || err?.code === 'SSRF_BLOCKED') {
      throw new UpstreamAuthError('Token URL blocked: destination is not a public address')
    }
    if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') throw new UpstreamAuthError('Token request timed out')
    throw new UpstreamAuthError(`Token request failed: ${redactString(err?.message ?? String(err), secrets)}`)
  }

  let body: any
  try {
    body = JSON.parse(res.data)
  } catch {}
  if (res.status < 200 || res.status >= 300 || typeof body?.access_token !== 'string') {
    const reason = typeof body?.error === 'string'
      ? `${body.error.slice(0, 100)}${typeof body.error_description === 'string' ? `: ${body.error_description.slice(0, 200)}` : ''}`
      : 'no access_token in the response'
    throw new UpstreamAuthError(`Token endpoint returned HTTP ${res.status} (${redactString(reason, secrets)})`)
  }
  const tokenType = typeof body.token_type === 'string' ? body.token_type : 'Bearer'
  if (tokenType.toLowerCase() !== 'bearer') throw new UpstreamAuthError(`Unsupported token type "${tokenType.slice(0, 40)}" (only Bearer tokens are supported)`)
  const token: string = body.access_token
  if (!token || token.length > MAX_TOKEN_LENGTH || !isValidHeaderValue(`Bearer ${token}`)) {
    throw new UpstreamAuthError('Token endpoint returned an access token that cannot be sent in a header')
  }
  const ttl = Number(body.expires_in)
  return {
    token,
    tokenType: 'Bearer',
    expiresIn: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, MAX_TTL_S) : DEFAULT_TTL_S,
    ...(typeof body.scope === 'string' ? { scope: body.scope.slice(0, 1024) } : {}),
  }
}

/** A valid access token for the app, from cache when possible. Concurrent callers share one request. */
export async function getAccessToken(app: App, secret: string, opts: { fresh?: boolean } = {}): Promise<{ token: string; cached: boolean }> {
  if (!app.oauth) throw new UpstreamAuthError('OAuth is not configured for this app')
  const fp = fingerprint(app.oauth, secret)
  const hit = cache.get(app.id)
  if (!opts.fresh && hit && hit.fingerprint === fp && hit.expiresAt - REFRESH_EARLY_MS > Date.now()) {
    return { token: hit.token, cached: true }
  }
  const key = `${app.id}:${fp}`
  let pending = inflight.get(key)
  if (!pending) {
    pending = requestToken(app.oauth, secret)
      .then(info => {
        const entry = { token: info.token, expiresAt: Date.now() + info.expiresIn * 1000, fingerprint: fp }
        cache.set(app.id, entry)
        return entry
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return { token: (await pending).token, cached: false }
}

export function forgetAccessToken(appId: string): void {
  cache.delete(appId)
}
