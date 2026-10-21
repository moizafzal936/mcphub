import express, { Router, type Request } from 'express'
import { z } from 'zod'
import { appRepo, logRepo, newId, tokenRepo, toolRepo, userRepo } from '../storage/db.js'
import { parseOpenApiSpec, parseSpecDocument, parseSpecText } from '../ingestion/openapi.js'
import { runTool } from '../ingestion/runTool.js'
import { toolFromCurl } from '../ingestion/curl.js'
import { isPostmanCollection, toolsFromPostman } from '../ingestion/postman.js'
import { appConfigSchema, exportAppConfig, toolsFromConfig } from '../ingestion/appConfig.js'
import { assessReadiness } from '../ingestion/readiness.js'
import { forgetAccessToken, requestToken, UpstreamAuthError } from '../ingestion/upstreamAuth.js'
import {
  MAX_RESPONSE_FIELDS, MAX_TOOLS_PER_APP, ToolInputError, isValidCredentialName, isValidFieldPath, isValidParamName, isValidToolName, pathPlaceholders, sanitizeParameters,
  toolForApp, validateToolPath,
} from '../ingestion/toolSchema.js'
import { assertResolvesPublic, parseOutboundUrl, SsrfBlockedError } from '../security/ssrf.js'
import { asyncHandler, HttpError } from '../http/errors.js'
import { isReservedHeader, isValidHeaderName, isValidHeaderValue } from '../security/headers.js'
import { issueMcpToken, requireUser } from '../auth/auth.js'
import { closeSessions } from '../mcp-host/server.js'
import { listGrants, revokeGrantInApp } from '../auth/oauth.js'
import { playgroundEnabled, runPlayground } from '../playground.js'
import { getConfig } from '../config.js'
import type { App, FixedParam, McpTool } from '../types/index.js'

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

const credentialNameSchema = z.string().trim().min(1).max(256)
const credentialInSchema = z.enum(['header', 'query'])

/** Resolves and checks where the upstream key goes: a header (default Authorization) or a query parameter. */
function credentialSetting(where: App['apiKeyIn'] | undefined, name: string | undefined): { apiKeyIn: App['apiKeyIn']; apiKeyHeader: string } {
  const apiKeyIn = where ?? 'header'
  const apiKeyHeader = name ?? (apiKeyIn === 'query' ? 'api_key' : 'Authorization')
  if (!isValidCredentialName(apiKeyIn, apiKeyHeader)) {
    throw new HttpError(400, apiKeyIn === 'query'
      ? 'Query parameter name must be 1-128 letters, digits, "_", "-", ".", "[" or "]"'
      : 'Invalid or reserved header name')
  }
  return { apiKeyIn, apiKeyHeader }
}
const rateLimitSchema = z.number().int().min(1).max(100_000).nullable()

const optionalText = (max: number) => z.string().trim().max(max).optional().transform(v => v || undefined)
const oauthConfigSchema = z.object({
  tokenUrl: z.string().trim().max(2048).superRefine((value, ctx) => {
    try {
      if (parseOutboundUrl(value).hash) ctx.addIssue({ code: 'custom', message: 'Token URL must not include a fragment' })
    } catch (err: any) {
      ctx.addIssue({ code: 'custom', message: err.message })
    }
  }),
  clientId: z.string().trim().min(1).max(512),
  scope: optionalText(1024),
  audience: optionalText(1024),
  clientAuth: z.enum(['basic', 'post']).optional().default('basic'),
}).strict()
const authTypeSchema = z.enum(['api_key', 'oauth2_client_credentials'])

const MAX_FIXED_PARAMS = 20
const fixedParamsSchema = z.array(z.object({
  in: z.enum(['header', 'query']),
  name: z.string().trim().min(1).max(128),
  // Omitted or null for a secret keeps the stored value.
  value: z.string().max(4096).nullable().optional(),
  secret: z.boolean().optional().default(false),
}).strict()).max(MAX_FIXED_PARAMS, `Up to ${MAX_FIXED_PARAMS} fixed parameters`)
type FixedParamInput = z.infer<typeof fixedParamsSchema>[number]

/**
 * Fixed params must be valid, unique and must not collide with transport headers or with the
 * app's own credential. `existing` is the current public view, to know which secrets are stored.
 */
function checkFixedParams(
  params: Pick<FixedParamInput, 'in' | 'name' | 'secret' | 'value'>[],
  auth: Pick<App, 'apiKeyIn' | 'apiKeyHeader'>,
  existing: FixedParam[] = [],
  opts: { allowMissingSecrets?: boolean } = {}
): void {
  const seen = new Set<string>()
  for (const p of params) {
    const key = `${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`
    if (seen.has(key)) throw new HttpError(400, `"${p.name}" is listed twice`)
    seen.add(key)
    const credential = auth.apiKeyIn === p.in && auth.apiKeyHeader.toLowerCase() === p.name.toLowerCase()
    if (p.in === 'header') {
      if (!isValidHeaderName(p.name) || isReservedHeader(p.name, auth.apiKeyIn === 'header' ? auth.apiKeyHeader : undefined) || credential) {
        throw new HttpError(400, `"${p.name}" can't be a fixed header (invalid, reserved, or used for the app's credential)`)
      }
      if (p.value && !isValidHeaderValue(p.value)) throw new HttpError(400, `The value of "${p.name}" contains characters not allowed in a header`)
    } else if (!isValidParamName(p.name) || credential) {
      throw new HttpError(400, `"${p.name}" can't be a fixed query parameter (invalid, or used for the app's credential)`)
    }
    const stored = existing.some(e => e.secret && e.hasValue && e.in === p.in && e.name === p.name)
    if (!p.value && !(p.secret && (stored || opts.allowMissingSecrets))) throw new HttpError(400, `Enter a value for "${p.name}"`)
  }
}

/**
 * Resolves how the app authenticates upstream. With OAuth client credentials the stored secret is
 * the client secret and tokens always go in "Authorization: Bearer"; the token URL must be public.
 */
async function authSetting(
  authType: App['authType'],
  oauth: App['oauth'] | undefined,
  apiKeyIn?: App['apiKeyIn'],
  apiKeyHeader?: string
): Promise<{ authType: App['authType']; oauth: App['oauth'] | null; apiKeyIn: App['apiKeyIn']; apiKeyHeader: string }> {
  if (authType === 'oauth2_client_credentials') {
    if (!oauth) throw new HttpError(400, 'OAuth client credentials need a token URL and a client ID')
    await ensurePublicTarget(oauth.tokenUrl, 'Token URL')
    return { authType, oauth, apiKeyIn: 'header', apiKeyHeader: 'Authorization' }
  }
  return { authType: 'api_key', oauth: null, ...credentialSetting(apiKeyIn, apiKeyHeader) }
}

const createAppSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: baseUrlSchema,
  specUrl: z.string().trim().url().max(2048).optional().or(z.literal('').transform(() => undefined)),
  apiKey: z.string().max(4096).optional().or(z.literal('').transform(() => undefined)),
  apiKeyHeader: credentialNameSchema.optional(),
  apiKeyIn: credentialInSchema.optional(),
  authType: authTypeSchema.optional(),
  oauth: oauthConfigSchema.optional(),
  rateLimitPerMin: rateLimitSchema.optional().default(null),
})

const updateAppSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  apiKey: z.string().max(4096).nullable().optional(),
  apiKeyHeader: credentialNameSchema.optional(),
  apiKeyIn: credentialInSchema.optional(),
  authType: authTypeSchema.optional(),
  oauth: oauthConfigSchema.optional(),
  fixedParams: fixedParamsSchema.optional(),
  rateLimitPerMin: rateLimitSchema.optional(),
  readOnly: z.boolean().optional(),
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
  // Argument name -> description, for path/query/header parameters and top-level body fields.
  parameterDescriptions: z.record(z.string(), z.string().max(1000))
    .refine(d => Object.keys(d).length <= 200, 'Too many parameters').optional(),
  // Fields kept in successful responses sent to AI clients; null or [] sends the full response.
  responseFields: z.array(z.string().refine(isValidFieldPath, 'Field paths are dot-separated JSON keys, e.g. "items.title"'))
    .max(MAX_RESPONSE_FIELDS).nullable().optional(),
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
  const { oauth, ...credential } = await authSetting(input.authType ?? 'api_key', input.oauth, input.apiKeyIn, input.apiKeyHeader)
  await ensurePublicTarget(input.baseUrl, 'Base URL')
  if (input.specUrl) parseOutboundUrl(input.specUrl)

  const now = Date.now()
  const app: App = {
    id: newId(),
    ownerId: req.user!.id,
    name: input.name,
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    specUrl: input.specUrl,
    ...credential,
    ...(oauth ? { oauth } : {}),
    fixedParams: [],
    hasApiKey: !!input.apiKey,
    rateLimitPerMin: input.rateLimitPerMin,
    readOnly: false,
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
  const { oauth: oauthPatch, fixedParams, ...patch } = updateAppSchema.parse(req.body)
  let auth: Awaited<ReturnType<typeof authSetting>> | undefined
  if (patch.authType !== undefined || oauthPatch !== undefined || patch.apiKeyIn !== undefined || patch.apiKeyHeader !== undefined) {
    const authType = patch.authType ?? app.authType
    // Switching method resets the credential location to that method's default unless one is given.
    const keepLocation = authType === app.authType
    const apiKeyIn = patch.apiKeyIn ?? (keepLocation ? app.apiKeyIn : undefined)
    const apiKeyHeader = patch.apiKeyHeader ?? (keepLocation && (!patch.apiKeyIn || patch.apiKeyIn === app.apiKeyIn) ? app.apiKeyHeader : undefined)
    auth = await authSetting(authType, oauthPatch ?? app.oauth, apiKeyIn, apiKeyHeader)
  }
  // Fixed params are checked against the credential setup the app will have after this change.
  const finalAuth = { apiKeyIn: auth?.apiKeyIn ?? app.apiKeyIn, apiKeyHeader: auth?.apiKeyHeader ?? app.apiKeyHeader }
  if (fixedParams) checkFixedParams(fixedParams, finalAuth, app.fixedParams)
  else if (auth) checkFixedParams(app.fixedParams.map(f => ({ ...f, value: f.value ?? null })), finalAuth, app.fixedParams)
  await appRepo.update(app.id, req.user!.id, { ...patch, ...auth })
  if (fixedParams) await appRepo.setFixedParams(app.id, req.user!.id, fixedParams)
  forgetAccessToken(app.id)
  const updated = (await appRepo.findForOwner(app.id, req.user!.id))!
  res.json(publicApp(updated))
}))

router.delete('/apps/:id', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  await closeSessions(s => s.appId === app.id)
  await appRepo.deleteForOwner(app.id, req.user!.id)
  forgetAccessToken(app.id)
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

// Spec pasted or uploaded as text (for specs on private hosts, which URL import must refuse).
router.post('/apps/:id/import-spec', express.text({ type: () => true, limit: '10mb' }), asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  if (typeof req.body !== 'string' || !req.body.trim()) throw new HttpError(400, 'Send the spec as the request body (JSON or YAML)')
  let tools: McpTool[]
  let skipped: string[] = []
  let format = 'openapi'
  try {
    const doc = parseSpecText(req.body)
    if (isPostmanCollection(doc)) {
      format = 'postman'
      ;({ tools, skipped } = toolsFromPostman(doc, app))
    } else {
      tools = parseSpecDocument(doc, app.id, app.apiKeyHeader)
    }
  } catch (err: any) {
    throw new HttpError(422, `Import failed: ${err?.message ?? 'unknown error'}`)
  }
  if (!tools.length) throw new HttpError(422, 'No usable requests found in this file')
  await toolRepo.replaceAllForApp(app.id, tools)
  res.json({ imported: tools.length, tools, format, skipped })
}))

// ── Config export / import (moves an app between MCPHub servers, never its key) ──

router.get('/apps/:id/export', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  res.json(exportAppConfig(app, await toolRepo.findAllByAppId(app.id)))
}))

router.post('/apps/import-config', express.text({ type: () => true, limit: '5mb' }), asyncHandler(async (req, res) => {
  if (typeof req.body !== 'string' || !req.body.trim()) throw new HttpError(400, 'Send the exported config as the request body')
  let doc: unknown
  try {
    doc = JSON.parse(req.body)
  } catch {
    throw new HttpError(422, 'Import failed: the file is not valid JSON')
  }
  let config, settings, specUrl: string | undefined
  let oauthConfig: App['oauth'] | undefined
  let importedFixed: FixedParamInput[] = []
  try {
    config = appConfigSchema.parse(doc)
    settings = createAppSchema.pick({ name: true, baseUrl: true, rateLimitPerMin: true }).parse({
      name: config.app.name,
      baseUrl: config.app.baseUrl,
      rateLimitPerMin: config.app.rateLimitPerMin ?? null,
    })
    if (config.app.oauth !== undefined) oauthConfig = oauthConfigSchema.parse(config.app.oauth)
    if (config.app.fixedParams !== undefined) importedFixed = fixedParamsSchema.parse(config.app.fixedParams)
    specUrl = config.app.specUrl ? z.string().trim().url().max(2048).parse(config.app.specUrl) : undefined
    if (specUrl) parseOutboundUrl(specUrl)
  } catch (err: any) {
    if (err?.code === 'SSRF_BLOCKED') throw new HttpError(422, `Import failed: spec URL: ${err.message}`)
    if (!(err instanceof z.ZodError)) throw err
    const issue = err.issues[0]
    throw new HttpError(422, `Import failed: ${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
  }
  let credential
  try {
    credential = await authSetting(config.app.authType ?? 'api_key', oauthConfig, config.app.apiKeyIn, config.app.apiKeyHeader)
    // Exports never contain secret values, so imported secrets arrive empty and are filled in Settings.
    checkFixedParams(importedFixed.map(f => (f.secret ? { ...f, value: null } : f)), credential, [], { allowMissingSecrets: true })
  } catch (err) {
    if (err instanceof HttpError) throw new HttpError(422, `Import failed: ${err.message}`)
    throw err
  }
  await ensurePublicTarget(settings.baseUrl, 'Base URL')

  const { oauth, ...location } = credential
  const now = Date.now()
  const app: App = {
    id: newId(),
    ownerId: req.user!.id,
    name: settings.name,
    baseUrl: settings.baseUrl.replace(/\/+$/, ''),
    specUrl,
    ...location,
    ...(oauth ? { oauth } : {}),
    fixedParams: [],
    hasApiKey: false,
    rateLimitPerMin: settings.rateLimitPerMin,
    readOnly: config.app.readOnly ?? false,
    createdAt: now,
    updatedAt: now,
  }
  let built
  try {
    built = toolsFromConfig(config, app.id, app.apiKeyHeader, newId)
  } catch (err) {
    if (err instanceof ToolInputError) throw new HttpError(422, `Import failed: ${err.message}`)
    throw err
  }
  await appRepo.insert(app, undefined)
  if (importedFixed.length) await appRepo.setFixedParams(app.id, app.ownerId, importedFixed.map(f => (f.secret ? { ...f, value: null } : f)))
  await toolRepo.insertMany(built.tools)
  const created = (await appRepo.findForOwner(app.id, req.user!.id))!
  res.status(201).json({ ...publicApp(created), toolCount: built.tools.length, skipped: built.skipped })
}))

// Fetches a token with the stored client credentials, to check the OAuth setup. Never returns the token.
router.post('/apps/:id/auth/test', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  if (app.authType !== 'oauth2_client_credentials' || !app.oauth) throw new HttpError(400, 'This app does not use OAuth client credentials')
  const secret = await appRepo.getApiKey(app.id)
  if (!secret) throw new HttpError(400, 'Add the client secret first')
  try {
    const info = await requestToken(app.oauth, secret)
    res.json({ ok: true, tokenType: info.tokenType, expiresIn: info.expiresIn, ...(info.scope ? { scope: info.scope } : {}) })
  } catch (err) {
    if (err instanceof UpstreamAuthError) return void res.json({ ok: false, error: err.message })
    throw err
  }
}))

// ── Tools ──────────────────────────────────────────────────────────────────────

router.get('/apps/:id/tools', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  res.json((await toolRepo.findAllByAppId(app.id)).map(t => toolForApp(app, t)))
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

router.post('/apps/:id/tools/from-curl', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  const input = z.object({
    curl: z.string().min(4).max(20_000),
    name: z.string().trim().refine(isValidToolName, 'Tool name must be 1-64 characters: letters, digits, "_" or "-"').optional(),
    description: z.string().max(2000).optional(),
  }).parse(req.body)
  if ((await toolRepo.countByAppId(app.id)) >= MAX_TOOLS_PER_APP) throw new HttpError(400, `Apps are limited to ${MAX_TOOLS_PER_APP} tools`)
  let built
  try {
    built = toolFromCurl(input.curl, app, { name: input.name, description: input.description })
  } catch (err) {
    if (err instanceof ToolInputError) throw new HttpError(400, err.message)
    throw err
  }
  if (await toolRepo.findByNameInApp(app.id, built.tool.name)) throw new HttpError(409, `A tool named "${built.tool.name}" already exists`)
  const tool: McpTool = { id: newId(), ...built.tool }
  await toolRepo.insertMany([tool])
  res.status(201).json({ tool, skippedHeaders: built.skippedHeaders, usedBasicAuth: built.usedBasicAuth })
}))

router.patch('/apps/:id/tools/:toolId', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  const { parameterDescriptions, ...patch } = updateToolSchema.parse(req.body)
  if (patch.name) {
    const clash = await toolRepo.findByNameInApp(app.id, patch.name)
    if (clash && clash.id !== req.params.toolId) throw new HttpError(409, `A tool named "${patch.name}" already exists`)
  }
  const fields: { parameters?: McpTool['parameters']; requestBodySchema?: Record<string, unknown> } = {}
  if (parameterDescriptions) {
    const tool = await toolRepo.findInApp(app.id, req.params.toolId)
    if (!tool) throw new HttpError(404, 'Tool not found')
    const bodyProps = (tool.requestBodySchema as any)?.properties ?? {}
    const unknown = Object.keys(parameterDescriptions).filter(n => !tool.parameters.some(p => p.name === n) && !Object.hasOwn(bodyProps, n))
    if (unknown.length) throw new HttpError(400, `Unknown parameter(s): ${unknown.join(', ')}`)
    fields.parameters = tool.parameters.map(p => (Object.hasOwn(parameterDescriptions, p.name) ? { ...p, description: parameterDescriptions[p.name].trim() } : p))
    if (tool.requestBodySchema) {
      const properties = Object.fromEntries(Object.entries<any>(bodyProps).map(([n, s]) =>
        [n, Object.hasOwn(parameterDescriptions, n) && !tool.parameters.some(p => p.name === n) ? { ...s, description: parameterDescriptions[n].trim() } : s]))
      fields.requestBodySchema = { ...tool.requestBodySchema, properties }
    }
  }
  if (patch.responseFields) patch.responseFields = [...new Set(patch.responseFields)]
  if (!(await toolRepo.updateInApp(app.id, req.params.toolId, { ...patch, ...fields }))) throw new HttpError(404, 'Tool not found')
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

router.get('/apps/:id/readiness', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  res.json(assessReadiness(app, await toolRepo.findAllByAppId(app.id)))
}))

router.get('/apps/:id/tool-stats', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  res.json(await logRepo.statsByTool(app.id, Date.now() - 86_400_000))
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

// ── Playground (Claude tool-use loop over this app's tools) ─────────────────────

router.get('/playground/status', (_req, res) => {
  res.json({ enabled: playgroundEnabled() })
})

router.post('/apps/:id/playground', asyncHandler(async (req, res) => {
  const app = await ownedApp(req)
  const { messages } = z.object({
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) })).min(1).max(20),
  }).parse(req.body)
  if (messages[messages.length - 1].role !== 'user') throw new HttpError(400, 'The last message must be from the user')
  try {
    res.json(await runPlayground(app, req.user!.id, messages))
  } catch (err: any) {
    if (err instanceof HttpError) throw err
    // Upstream model errors (bad key, overloaded) are reported without leaking request details.
    throw new HttpError(502, `Claude API error: ${err?.status ?? ''} ${err?.error?.error?.type ?? err?.name ?? 'request failed'}`.trim())
  }
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
