import { Router, type Request } from 'express'
import { z } from 'zod'
import { appRepo, logRepo, newId, tokenRepo, toolRepo, userRepo } from '../storage/db.js'
import { parseOpenApiSpec } from '../ingestion/openapi.js'
import { runTool } from '../ingestion/runTool.js'
import {
  MAX_TOOLS_PER_APP, isValidParamName, isValidToolName, pathPlaceholders, sanitizeParameters, validateToolPath,
} from '../ingestion/toolSchema.js'
import { assertResolvesPublic, parseOutboundUrl, SsrfBlockedError } from '../security/ssrf.js'
import { isValidCredentialHeader } from '../security/headers.js'
import { asyncHandler, HttpError } from '../http/errors.js'
import { issueMcpToken, requireUser } from '../auth/auth.js'
import { closeSessions } from '../mcp-host/server.js'
import { listGrants, revokeGrantInApp } from '../auth/oauth.js'
import { getConfig } from '../config.js'
import type { App, McpTool } from '../types/index.js'

const router = Router()
router.use(requireUser)

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

const baseUrlSchema = z.string().trim().max(2048).superRefine((value, ctx) => {
  try {
    const url = parseOutboundUrl(value)
    if (url.search || url.hash) ctx.addIssue({ code: 'custom', message: 'Base URL must not include a query string or fragment' })
  } catch (err: any) {
    ctx.addIssue({ code: 'custom', message: err.message })
  }
})

const credentialHeaderSchema = z.string().trim().max(256).refine(isValidCredentialHeader, 'Invalid or reserved header name')
const rateLimitSchema = z.number().int().min(1).max(100_000).nullable()

const createAppSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: baseUrlSchema,
  specUrl: z.string().trim().url().max(2048).optional().or(z.literal('').transform(() => undefined)),
  apiKey: z.string().max(4096).optional().or(z.literal('').transform(() => undefined)),
  apiKeyHeader: credentialHeaderSchema.optional().default('Authorization'),
  rateLimitPerMin: rateLimitSchema.optional().default(null),
})

const updateAppSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  apiKey: z.string().max(4096).nullable().optional(),
  apiKeyHeader: credentialHeaderSchema.optional(),
  rateLimitPerMin: rateLimitSchema.optional(),
}).strict()

const createToolSchema = z.object({
  name: z.string().trim().refine(isValidToolName, 'Tool name must be 1-64 characters: letters, digits, "_" or "-"'),
  description: z.string().max(2000).optional().default(''),
  method: z.string().transform(m => m.toUpperCase()).pipe(z.enum(METHODS)),
  path: z.string().trim().max(2048),
  queryParams: z.array(z.object({
    name: z.string().max(128),
    description: z.string().max(1000).optional().default(''),
    required: z.boolean().optional().default(false),
    in: z.enum(['query', 'header', 'body']).optional().default('query'),
    type: z.enum(['string', 'number', 'integer', 'boolean']).optional().default('string'),
  })).max(100).optional().default([]),
})

const updateToolSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().refine(isValidToolName, 'Invalid tool name').optional(),
  description: z.string().max(2000).optional(),
}).strict()

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100).optional().default('MCP client'),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})

function publicApp(app: App) {
  const { ownerId: _owner, ...rest } = app
  return rest
}

async function ownedApp(req: Request): Promise<App> {
  const app = await appRepo.findForOwner(req.params.id, req.user!.id)
  if (!app) throw new HttpError(404, 'App not found')
  return app
}

async function ensurePublicTarget(url: string, label: string): Promise<void> {
  try {
    await assertResolvesPublic(url)
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw new HttpError(400, `${label}: ${err.message}`)
    throw err
  }
}

async function importSpec(specUrl: string, app: App): Promise<McpTool[]> {
  try {
    return await parseOpenApiSpec(specUrl, app.id, app.apiKeyHeader)
  } catch (err: any) {
    const reason = err instanceof SsrfBlockedError || err?.cause instanceof SsrfBlockedError || err?.code === 'SSRF_BLOCKED'
      ? 'destination is not a public address'
      : err?.message ?? 'unknown error'
    throw new HttpError(422, `Spec import failed: ${reason}`)
  }
}

// ── Ownerless apps (created before accounts existed); only the operator may claim ──

router.get('/orphans', asyncHandler(async (req, res) => {
  const isOperator = (await userRepo.operatorId()) === req.user!.id
  res.json({ count: isOperator ? await appRepo.countOrphans() : 0, canClaim: isOperator })
}))

router.post('/orphans/claim', asyncHandler(async (req, res) => {
  if ((await userRepo.operatorId()) !== req.user!.id) throw new HttpError(403, 'Only the server operator can claim these apps')
  res.json({ claimed: await appRepo.assignOrphansTo(req.user!.id) })
}))

// ── Stats & apps ───────────────────────────────────────────────────────────────

router.get('/stats', asyncHandler(async (req, res) => {
  const apps = await appRepo.findAllForOwner(req.user!.id)
  const counts = await Promise.all(apps.map(a => toolRepo.countByAppId(a.id)))
  res.json({ apps: apps.length, tools: counts.reduce((s, n) => s + n, 0), mcpEndpoints: apps.length })
}))

router.get('/apps', asyncHandler(async (req, res) => {
  const apps = await appRepo.findAllForOwner(req.user!.id)
  res.json(await Promise.all(apps.map(async app => ({
    ...publicApp(app),
    toolCount: await toolRepo.countByAppId(app.id),
    lastUsed: await logRepo.lastCalledAt(app.id),
  }))))
}))

router.get('/apps/:id', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  res.json({ ...publicApp(app), toolCount: await toolRepo.countByAppId(app.id) })
}))

router.post('/apps', asyncHandler(async (req, res) => {
  const input = createAppSchema.parse(req.body)
  await ensurePublicTarget(input.baseUrl, 'Base URL')
  if (input.specUrl) parseOutboundUrl(input.specUrl)

  const now = Date.now()
  const app: App = {
    id: newId(),
    ownerId: req.user!.id,
    name: input.name,
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    specUrl: input.specUrl,
    apiKeyHeader: input.apiKeyHeader,
    hasApiKey: !!input.apiKey,
    rateLimitPerMin: input.rateLimitPerMin,
    createdAt: now,
    updatedAt: now,
  }
  await appRepo.insert(app, input.apiKey)

  let warning: string | undefined
  if (input.specUrl) {
    try {
      await toolRepo.insertMany(await importSpec(input.specUrl, app))
    } catch (err: any) {
      warning = `App created, but ${err.message}`
    }
  }
  res.status(201).json({ ...publicApp(app), toolCount: await toolRepo.countByAppId(app.id), ...(warning ? { warning } : {}) })
}))

router.patch('/apps/:id', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  const patch = updateAppSchema.parse(req.body)
  await appRepo.update(app.id, req.user!.id, patch)
  const updated = (await appRepo.findForOwner(app.id, req.user!.id))!
  res.json(publicApp(updated))
}))

router.delete('/apps/:id', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  await closeSessions(s => s.appId === app.id)
  await appRepo.deleteForOwner(app.id, req.user!.id)
  res.json({ ok: true })
}))

router.post('/apps/:id/import', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  const { specUrl } = z.object({ specUrl: z.string().trim().url().max(2048).optional() }).parse(req.body ?? {})
  const target = specUrl || app.specUrl
  if (!target) throw new HttpError(400, 'No spec URL provided')
  const tools = await importSpec(target, app)
  await toolRepo.replaceAllForApp(app.id, tools)
  res.json({ imported: tools.length, tools })
}))

// ── Tools ──────────────────────────────────────────────────────────────────────

router.get('/apps/:id/tools', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  res.json(await toolRepo.findAllByAppId(app.id))
}))

router.post('/apps/:id/tools', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  const input = createToolSchema.parse(req.body)

  const pathError = validateToolPath(input.path)
  if (pathError) throw new HttpError(400, `Invalid path: ${pathError}`)
  if ((await toolRepo.countByAppId(app.id)) >= MAX_TOOLS_PER_APP) throw new HttpError(400, `Apps are limited to ${MAX_TOOLS_PER_APP} tools`)
  if (await toolRepo.findByNameInApp(app.id, input.name)) throw new HttpError(409, `A tool named "${input.name}" already exists`)

  const bodyParams = input.queryParams.filter(p => p.in === 'body')
  if (bodyParams.length && input.method === 'GET') throw new HttpError(400, 'GET tools cannot have body parameters')
  const declared = [
    ...pathPlaceholders(input.path).map(name => ({ name, in: 'path', description: name, required: true, schema: { type: 'string' } })),
    ...input.queryParams.filter(p => p.in !== 'body').map(p => ({ name: p.name, in: p.in, description: p.description, required: p.required, schema: { type: p.type } })),
  ]
  const { params, dropped } = sanitizeParameters(declared, app.apiKeyHeader)
  const badBody = bodyParams.filter(p => !isValidParamName(p.name)).map(p => p.name || '(unnamed)')
  if (dropped.length || badBody.length) throw new HttpError(400, `Invalid or reserved parameter name(s): ${[...dropped, ...badBody].join(', ')}`)
  const names = [...params.map(p => p.name), ...bodyParams.map(p => p.name)]
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  if (dupes.length) throw new HttpError(400, `Duplicate parameter name(s): ${[...new Set(dupes)].join(', ')}`)
  const requestBodySchema = bodyParams.length
    ? {
        type: 'object',
        properties: Object.fromEntries(bodyParams.map(p => [p.name, { type: p.type, description: p.description || p.name }])),
        required: bodyParams.filter(p => p.required).map(p => p.name),
      }
    : undefined

  const tool: McpTool = {
    id: newId(),
    appId: app.id,
    name: input.name,
    description: input.description,
    method: input.method,
    path: input.path,
    parameters: params,
    ...(requestBodySchema ? { requestBodySchema } : {}),
    enabled: true,
  }
  await toolRepo.insertMany([tool])
  res.status(201).json(tool)
}))

router.patch('/apps/:id/tools/:toolId', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  const patch = updateToolSchema.parse(req.body)
  if (patch.name) {
    const clash = await toolRepo.findByNameInApp(app.id, patch.name)
    if (clash && clash.id !== req.params.toolId) throw new HttpError(409, `A tool named "${patch.name}" already exists`)
  }
  if (!(await toolRepo.updateInApp(app.id, req.params.toolId, patch))) throw new HttpError(404, 'Tool not found')
  res.json({ ok: true })
}))

router.delete('/apps/:id/tools/:toolId', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  if (!(await toolRepo.deleteInApp(app.id, req.params.toolId))) throw new HttpError(404, 'Tool not found')
  res.json({ ok: true })
}))

router.post('/apps/:id/tools/:toolId/execute', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  const tool = await toolRepo.findInApp(app.id, req.params.toolId)
  if (!tool) throw new HttpError(404, 'Tool not found')
  const result = await runTool(app, tool, req.body ?? {}, `user:${req.user!.id}`)
  res.json(result)
}))

// ── Logs ───────────────────────────────────────────────────────────────────────

router.get('/apps/:id/logs', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
  res.json(await logRepo.findByAppId(app.id, limit))
}))

// ── MCP access tokens ──────────────────────────────────────────────────────────

router.get('/apps/:id/tokens', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  res.json(await tokenRepo.listForApp(app.id))
}))

router.post('/apps/:id/tokens', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  const input = createTokenSchema.parse(req.body ?? {})
  const days = input.expiresInDays ?? getConfig().mcpTokenDefaultDays
  const { token, hash, prefix } = issueMcpToken()
  const now = Date.now()
  const record = {
    id: newId(), appId: app.id, userId: req.user!.id, name: input.name, prefix,
    createdAt: now, expiresAt: now + days * 86_400_000, lastUsedAt: null, revokedAt: null,
  }
  await tokenRepo.insert(record, hash)
  // The plaintext token is returned exactly once and never stored.
  res.status(201).json({ ...record, token })
}))

router.delete('/apps/:id/tokens/:tokenId', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  if (!(await tokenRepo.revokeInApp(app.id, req.params.tokenId))) throw new HttpError(404, 'Token not found')
  const closed = await closeSessions(s => s.tokenId === req.params.tokenId)
  res.json({ ok: true, closedSessions: closed })
}))

// ── OAuth grants (clients connected via the OAuth flow) ─────────────────────────

router.get('/apps/:id/grants', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  res.json(await listGrants(app.id))
}))

router.delete('/apps/:id/grants/:grantId', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  if (!(await revokeGrantInApp(app.id, req.params.grantId))) throw new HttpError(404, 'Connection not found')
  res.json({ ok: true })
}))

export default router
