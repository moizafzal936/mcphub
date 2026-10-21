import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { getConfig, issuerUrl } from '../config.js'
import { sessionRepo, tokenRepo, userRepo, newId } from '../storage/db.js'
import { burnPasswordCheck, hashPassword, randomToken, sha256, verifyPassword } from '../security/passwords.js'
import { rateLimit, clientIp } from '../security/rateLimit.js'
import { newTotpSecret, otpauthUrl, verifyTotp } from '../security/totp.js'
import { asyncHandler, HttpError } from '../http/errors.js'
import type { User } from '../types/index.js'

declare module 'express-serve-static-core' {
  interface Request {
    user?: User
    auth?: AuthInfo
  }
}

export interface McpAuthExtra {
  tokenId: string
  userId: string
  appId: string
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MCP_TOKEN_PREFIX = 'mcph_'

function cookieName(): string {
  return getConfig().cookieSecure ? '__Host-mcphub_session' : 'mcphub_session'
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(cookieName(), token, {
    httpOnly: true,
    secure: getConfig().cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  })
}

async function startSession(res: Response, userId: string): Promise<void> {
  const token = randomToken(32)
  await sessionRepo.insert(sha256(token), userId, SESSION_TTL_MS)
  setSessionCookie(res, token)
}

/**
 * CSRF defence for cookie-authenticated routes (OWASP: Fetch Metadata + Origin verification).
 * Browsers always send these headers on cross-site requests; non-browser clients carry no ambient cookie.
 */
function isAllowedOrigin(req: Request, origin: string): boolean {
  const config = getConfig()
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  const forwardedHost = config.trustProxy ? req.get('x-forwarded-host')?.split(',')[0].trim() : undefined
  return (
    originHost === req.get('host') ||
    (forwardedHost !== undefined && originHost === forwardedHost) ||
    config.allowedOrigins.includes(origin) ||
    (config.publicUrl !== undefined && new URL(config.publicUrl).origin === origin)
  )
}

export function requireSameOrigin(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  const site = req.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return next(new HttpError(403, 'Cross-site request blocked'))
  const origin = req.get('origin')
  if (origin && !isAllowedOrigin(req, origin)) return next(new HttpError(403, 'Cross-site request blocked'))
  next()
}

/** MCP spec: servers must validate Origin to prevent DNS rebinding. Non-browser clients send none. */
export function requireMcpOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin')
  if (origin && !isAllowedOrigin(req, origin)) return next(new HttpError(403, 'Origin not allowed'))
  next()
}

export const requireUser = asyncHandler(async (req, _res, next) => {
  const token = req.cookies?.[cookieName()]
  if (typeof token === 'string' && token.length > 0 && token.length < 200) {
    const session = await sessionRepo.findValid(sha256(token))
    if (session) {
      const user = await userRepo.findById(session.userId)
      if (user) {
        req.user = user
        return next()
      }
    }
  }
  throw new HttpError(401, 'Authentication required')
})

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
})

export function authRouter(): Router {
  const router = Router()

  router.get('/status', asyncHandler(async (_req, res) => {
    const users = await userRepo.count()
    res.json({ signupOpen: users === 0 || getConfig().allowSignup, bootstrap: users === 0 })
  }))

  router.post('/register', rateLimit('auth'), asyncHandler(async (req, res) => {
    const { email, password } = credentialsSchema.parse(req.body)
    const allowSignup = getConfig().allowSignup
    if (!allowSignup && (await userRepo.count()) > 0) throw new HttpError(403, 'Sign-up is disabled on this server')
    if (await userRepo.findByEmail(email)) throw new HttpError(409, 'An account with this email already exists')
    const user = { id: newId(), email, createdAt: Date.now(), passwordHash: await hashPassword(password) }
    let inserted = false
    try {
      inserted = await userRepo.insertIf(user, !allowSignup)
    } catch (err: any) {
      if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(409, 'An account with this email already exists')
      throw err
    }
    if (!inserted) throw new HttpError(403, 'Sign-up is disabled on this server')
    await startSession(res, user.id)
    res.status(201).json({ user: { id: user.id, email: user.email } })
  }))

  router.post(
    '/login',
    rateLimit('auth'),
    rateLimit('auth', req => `email:${String(req.body?.email ?? '').toLowerCase()}`),
    asyncHandler(async (req, res) => {
      const parsed = credentialsSchema.safeParse(req.body)
      if (!parsed.success) throw new HttpError(401, 'Invalid email or password')
      const { email, password } = parsed.data
      const user = await userRepo.findByEmail(email)
      if (!user) {
        await burnPasswordCheck(password)
        throw new HttpError(401, 'Invalid email or password')
      }
      if (!(await verifyPassword(password, user.passwordHash))) throw new HttpError(401, 'Invalid email or password')
      const totp = await userRepo.getTotp(user.id)
      if (totp.enabled && totp.secret) {
        const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : ''
        if (!code) {
          res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app', twoFactorRequired: true })
          return
        }
        const step = verifyTotp(totp.secret, code)
        if (step === undefined || !(await userRepo.consumeTotpStep(user.id, step))) {
          res.status(401).json({ error: 'Invalid or already-used two-factor code', twoFactorRequired: true })
          return
        }
      }
      await startSession(res, user.id)
      res.json({ user: { id: user.id, email: user.email } })
    })
  )

  router.post('/logout', asyncHandler(async (req, res) => {
    const token = req.cookies?.[cookieName()]
    if (typeof token === 'string') await sessionRepo.delete(sha256(token))
    res.clearCookie(cookieName(), { path: '/', httpOnly: true, secure: getConfig().cookieSecure, sameSite: 'lax' })
    res.json({ ok: true })
  }))

  router.get('/me', requireUser, asyncHandler(async (req, res) => {
    const totp = await userRepo.getTotp(req.user!.id)
    res.json({ user: { id: req.user!.id, email: req.user!.email, twoFactorEnabled: totp.enabled } })
  }))

  // ── Two-factor (TOTP) ──
  router.post('/2fa/setup', requireUser, asyncHandler(async (req, res) => {
    if ((await userRepo.getTotp(req.user!.id)).enabled) throw new HttpError(409, 'Two-factor authentication is already enabled')
    const secret = newTotpSecret()
    await userRepo.setTotpPending(req.user!.id, secret)
    res.json({ secret, otpauthUrl: otpauthUrl(secret, req.user!.email) })
  }))

  router.post('/2fa/enable', requireUser, rateLimit('auth'), asyncHandler(async (req, res) => {
    const { code } = z.object({ code: z.string().trim() }).parse(req.body)
    const totp = await userRepo.getTotp(req.user!.id)
    if (totp.enabled) throw new HttpError(409, 'Two-factor authentication is already enabled')
    if (!totp.secret) throw new HttpError(400, 'Start setup first')
    const step = verifyTotp(totp.secret, code)
    if (step === undefined || !(await userRepo.consumeTotpStep(req.user!.id, step, true))) throw new HttpError(400, 'That code is not valid; check your device clock and try again')
    res.json({ ok: true })
  }))

  router.post('/2fa/disable', requireUser, rateLimit('auth'), asyncHandler(async (req, res) => {
    const { password, code } = z.object({ password: z.string().max(200), code: z.string().trim() }).parse(req.body)
    const user = await userRepo.findByEmail(req.user!.email)
    const totp = await userRepo.getTotp(req.user!.id)
    if (!user || !totp.enabled || !totp.secret) throw new HttpError(400, 'Two-factor authentication is not enabled')
    if (!(await verifyPassword(password, user.passwordHash))) throw new HttpError(401, 'Incorrect password')
    const step = verifyTotp(totp.secret, code)
    if (step === undefined || !(await userRepo.consumeTotpStep(req.user!.id, step))) throw new HttpError(401, 'Invalid or already-used two-factor code')
    await userRepo.disableTotp(req.user!.id)
    res.json({ ok: true })
  }))

  return router
}

// ── MCP bearer tokens ──────────────────────────────────────────────────────────

export function issueMcpToken(): { token: string; hash: string; prefix: string } {
  const token = `${MCP_TOKEN_PREFIX}${randomToken(32)}`
  return { token, hash: sha256(token), prefix: token.slice(0, MCP_TOKEN_PREFIX.length + 6) }
}

/** Verifies dashboard-issued API tokens and OAuth access tokens (same table, same checks). */
export async function verifyMcpAccessToken(token: string): Promise<AuthInfo> {
  if (!token.startsWith(MCP_TOKEN_PREFIX) || token.length > 200) throw new InvalidTokenError('Invalid access token')
  const record = await tokenRepo.findActiveByHash(sha256(token))
  if (!record) throw new InvalidTokenError('Invalid, expired or revoked access token')
  void tokenRepo.touch(record.id).catch(() => {})
  const extra: McpAuthExtra = { tokenId: record.id, userId: record.userId, appId: record.appId }
  return { token, clientId: record.id, scopes: ['mcp:tools'], expiresAt: Math.floor(record.expiresAt / 1000), extra: extra as any }
}

/**
 * Authenticates every MCP request and binds the token to the app in the URL. 401s carry the
 * app's protected-resource metadata URL so OAuth clients can discover how to sign in.
 * Tokens in query strings are rejected, per the MCP authorization spec.
 */
export function requireMcpToken(req: Request, res: Response, next: NextFunction): void {
  if (typeof req.query.token === 'string' || typeof req.query.access_token === 'string') {
    res.status(400).json({ error: 'invalid_request', error_description: 'Access tokens must be sent in the Authorization header' })
    return
  }
  const resourceMetadataUrl = `${issuerUrl()}/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(req.params.appId)}`
  const bearer = requireBearerAuth({ verifier: { verifyAccessToken: verifyMcpAccessToken }, resourceMetadataUrl })
  bearer(req, res, err => {
    if (err) return next(err)
    const extra = req.auth?.extra as McpAuthExtra | undefined
    if (!extra || extra.appId !== req.params.appId) {
      res.set('WWW-Authenticate', `Bearer error="invalid_token", error_description="Token is not valid for this app", resource_metadata="${resourceMetadataUrl}"`)
      res.status(401).json({ error: 'invalid_token', error_description: 'Token is not valid for this app' })
      return
    }
    next()
  })
}

export function mcpClientKey(req: Request): string {
  const extra = req.auth?.extra as McpAuthExtra | undefined
  return extra ? `token:${extra.tokenId}` : `ip:${clientIp(req)}`
}
