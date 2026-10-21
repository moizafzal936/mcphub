import { z } from 'zod'
import type { App, McpTool } from '../types/index.js'
import {
  MAX_PARAMS_PER_TOOL, MAX_RESPONSE_FIELDS, MAX_TOOLS_PER_APP, ToolInputError, isValidFieldPath, isValidParamName, isValidToolName, normalizeType,
  pathPlaceholders, sanitizeParameters, validateToolPath,
} from './toolSchema.js'

export const CONFIG_FORMAT = 'mcphub.app'
export const CONFIG_VERSION = 1

/**
 * A portable description of an app and its tools, for moving a setup between MCPHub servers.
 * It never contains the upstream credential, ids, owner, tokens or logs.
 */
export interface AppConfig {
  format: typeof CONFIG_FORMAT
  version: typeof CONFIG_VERSION
  exportedAt: string
  app: {
    name: string
    baseUrl: string
    specUrl?: string
    apiKeyHeader: string
    apiKeyIn: App['apiKeyIn']
    authType: App['authType']
    oauth?: App['oauth']
    fixedParams?: { in: 'header' | 'query'; name: string; secret: boolean; value?: string }[]
    rateLimitPerMin: number | null
    readOnly: boolean
  }
  tools: Omit<McpTool, 'id' | 'appId'>[]
}

export function exportAppConfig(app: App, tools: McpTool[]): AppConfig {
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: new Date().toISOString(),
    app: {
      name: app.name,
      baseUrl: app.baseUrl,
      ...(app.specUrl ? { specUrl: app.specUrl } : {}),
      apiKeyHeader: app.apiKeyHeader,
      apiKeyIn: app.apiKeyIn,
      authType: app.authType,
      ...(app.oauth ? { oauth: app.oauth } : {}),
      // Secret values never leave the server; the importer re-enters them.
      ...(app.fixedParams.length ? { fixedParams: app.fixedParams.map(f => (f.secret ? { in: f.in, name: f.name, secret: true } : { in: f.in, name: f.name, secret: false, value: f.value ?? '' })) } : {}),
      rateLimitPerMin: app.rateLimitPerMin,
      readOnly: app.readOnly,
    },
    tools: tools.map(({ id: _id, appId: _appId, ...tool }) => tool),
  }
}

const toolSchema = z.object({
  name: z.string(),
  description: z.string().max(2000).optional().default(''),
  method: z.string().transform(m => m.toUpperCase()).pipe(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])),
  path: z.string(),
  parameters: z.array(z.unknown()).max(MAX_PARAMS_PER_TOOL).optional().default([]),
  requestBodySchema: z.record(z.string(), z.unknown()).nullable().optional(),
  responseFields: z.array(z.string()).max(MAX_RESPONSE_FIELDS).optional(),
  enabled: z.boolean().optional().default(true),
})

export const appConfigSchema = z.object({
  format: z.literal(CONFIG_FORMAT, { errorMap: () => ({ message: 'Not an MCPHub app config (expected "format": "mcphub.app")' }) }),
  version: z.literal(CONFIG_VERSION, { errorMap: () => ({ message: `Unsupported config version (this server reads version ${CONFIG_VERSION})` }) }),
  app: z.object({
    name: z.string(),
    baseUrl: z.string(),
    specUrl: z.string().optional(),
    apiKeyHeader: z.string().trim().min(1).max(256).optional(),
    apiKeyIn: z.enum(['header', 'query']).optional(),
    authType: z.enum(['api_key', 'oauth2_client_credentials']).optional(),
    oauth: z.unknown().optional(),
    fixedParams: z.unknown().optional(),
    rateLimitPerMin: z.number().nullable().optional(),
    readOnly: z.boolean().optional(),
  }),
  tools: z.array(toolSchema).max(MAX_TOOLS_PER_APP, `Apps are limited to ${MAX_TOOLS_PER_APP} tools`),
})

export type ParsedAppConfig = z.infer<typeof appConfigSchema>

/** Keeps only the top-level body fields the executor and argument validator use. */
function normalizeBodySchema(raw: unknown): Record<string, unknown> | undefined {
  const props = (raw as any)?.properties
  if (!props || typeof props !== 'object' || Array.isArray(props)) return undefined
  const properties: Record<string, unknown> = {}
  for (const [key, val] of Object.entries<any>(props).slice(0, MAX_PARAMS_PER_TOOL)) {
    if (!isValidParamName(key)) continue
    const enumValues = Array.isArray(val?.enum)
      ? val.enum.filter((v: unknown) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 200)
      : undefined
    properties[key] = {
      type: normalizeType(val?.type),
      description: typeof val?.description === 'string' ? val.description.slice(0, 1000) : key,
      ...(enumValues?.length ? { enum: enumValues } : {}),
    }
  }
  if (!Object.keys(properties).length) return undefined
  const required = Array.isArray((raw as any).required)
    ? (raw as any).required.filter((r: unknown) => typeof r === 'string' && r in properties)
    : []
  return { type: 'object', properties, required }
}

/**
 * Rebuilds tools from an imported config with the same checks as every other import path:
 * valid unique names, contained paths, safe parameter names and no reserved headers.
 */
export function toolsFromConfig(config: ParsedAppConfig, appId: string, credentialHeader: string, newId: () => string): { tools: McpTool[]; skipped: string[] } {
  const tools: McpTool[] = []
  const skipped: string[] = []
  const names = new Set<string>()
  for (const raw of config.tools) {
    if (!isValidToolName(raw.name)) throw new ToolInputError(`Invalid tool name "${raw.name.slice(0, 80)}"`)
    if (names.has(raw.name)) throw new ToolInputError(`Duplicate tool name "${raw.name}"`)
    names.add(raw.name)
    const pathError = validateToolPath(raw.path)
    if (pathError) throw new ToolInputError(`Tool "${raw.name}": invalid path: ${pathError}`)

    const { params, dropped } = sanitizeParameters(raw.parameters, credentialHeader)
    for (const name of dropped) skipped.push(`${raw.name}: parameter "${name}"`)
    // Every {placeholder} needs a path parameter, or the tool could never be called.
    for (const name of pathPlaceholders(raw.path)) {
      if (!params.some(p => p.in === 'path' && p.name === name)) {
        params.push({ name, in: 'path', description: name, required: true, schema: { type: 'string' } })
      }
    }
    const requestBodySchema = raw.method === 'GET' ? undefined : normalizeBodySchema(raw.requestBodySchema)
    const responseFields = [...new Set(raw.responseFields ?? [])].filter(f => {
      if (isValidFieldPath(f)) return true
      skipped.push(`${raw.name}: response field "${f.slice(0, 80)}"`)
      return false
    })
    tools.push({
      id: newId(),
      appId,
      name: raw.name,
      description: raw.description,
      method: raw.method,
      path: raw.path,
      parameters: params,
      ...(requestBodySchema ? { requestBodySchema } : {}),
      ...(responseFields.length ? { responseFields } : {}),
      enabled: raw.enabled,
    })
  }
  return { tools, skipped }
}
