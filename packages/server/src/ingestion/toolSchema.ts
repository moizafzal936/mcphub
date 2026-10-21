import AjvModule, { type ValidateFunction } from 'ajv'
import type { App, McpTool, ToolParameter } from '../types/index.js'
import { isReservedHeader, isValidCredentialHeader, isValidHeaderName, isValidHeaderValue, MAX_HEADER_VALUE_LENGTH } from '../security/headers.js'

const Ajv = (AjvModule as any).default ?? AjvModule

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}

export const MAX_TOOLS_PER_APP = 500
export const MAX_PARAMS_PER_TOOL = 100
export const MAX_ARGS_BYTES = 64 * 1024
export const MAX_PARAM_STRING = 8 * 1024

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const PARAM_NAME = /^[A-Za-z0-9_.\-[\]]{1,128}$/
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])

export function isValidToolName(name: string): boolean {
  return TOOL_NAME.test(name)
}

export function isValidParamName(name: string): boolean {
  return PARAM_NAME.test(name)
}

/** The credential travels in a header (header name) or a query parameter (parameter name). */
export function isValidCredentialName(where: App['apiKeyIn'], name: string): boolean {
  return where === 'query' ? PARAM_NAME.test(name) : isValidCredentialHeader(name)
}

/**
 * The tool as callers and AI clients see it. Parameters the app sets itself are hidden, so the
 * model can neither read nor override them: a query-parameter credential (specs often declare
 * one) and the app's fixed headers and query parameters.
 */
export function toolForApp(app: Pick<App, 'apiKeyHeader' | 'apiKeyIn'> & { fixedParams?: App['fixedParams'] }, tool: McpTool): McpTool {
  const hidden = new Set((app.fixedParams ?? []).map(f => `${f.in}:${f.name.toLowerCase()}`))
  if (app.apiKeyIn === 'query') hidden.add(`query:${app.apiKeyHeader.toLowerCase()}`)
  if (!hidden.size) return tool
  const parameters = tool.parameters.filter(p => !hidden.has(`${p.in}:${p.name.toLowerCase()}`))
  return parameters.length === tool.parameters.length ? tool : { ...tool, parameters }
}

/** Forms a secret can take in output: as sent in a header, and URL-encoded in a query string. */
export function secretForms(secret: string | undefined): string[] {
  if (!secret) return []
  const forms = new Set([secret, encodeURIComponent(secret), new URLSearchParams({ k: secret }).toString().slice(2)])
  return [...forms]
}

export function sanitizeToolName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return (cleaned || 'tool').slice(0, 64)
}

/**
 * A tool path is a template appended to the app's base path. It must be a plain absolute path:
 * no scheme/authority ("//host"), query, fragment, backslashes, dot segments (raw or %2e-encoded)
 * or control characters, so it can never leave the configured origin or base path.
 */
export function validateToolPath(path: string): string | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.length > 2048) return 'Path must be 1-2048 characters'
  if (!path.startsWith('/')) return 'Path must start with "/"'
  if (path.startsWith('//')) return 'Path must not start with "//"'
  if (/[\\?#\s\x00-\x1f\x7f]/.test(path)) return 'Path must not contain backslashes, "?", "#", whitespace or control characters'
  if (!/^[A-Za-z0-9\-._~!$&'()*+,;=:@%/{}]+$/.test(path)) return 'Path contains characters outside the RFC 3986 path set'
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) return 'Path contains an invalid percent-encoding'
  if (/%2e/i.test(path) || /%2f/i.test(path) || /%5c/i.test(path)) return 'Path must not contain encoded ".", "/" or "\\"'
  const segments = path.split('/')
  if (segments.some(s => s === '.' || s === '..')) return 'Path must not contain "." or ".." segments'
  const placeholders = path.match(/\{[^{}]*\}/g) ?? []
  for (const p of placeholders) {
    if (!PARAM_NAME.test(p.slice(1, -1))) return `Invalid path placeholder ${p}`
  }
  if (/[{}]/.test(path.replace(/\{[^{}]*\}/g, ''))) return 'Unbalanced braces in path'
  return undefined
}

export function pathPlaceholders(path: string): string[] {
  return (path.match(/\{([^{}]+)\}/g) ?? []).map(p => p.slice(1, -1))
}

export function normalizeType(type: unknown): string {
  if (Array.isArray(type)) {
    const first = type.find(t => typeof t === 'string' && JSON_TYPES.has(t) && t !== 'null')
    return first ?? 'string'
  }
  return typeof type === 'string' && JSON_TYPES.has(type) ? type : 'string'
}

/** Normalise and validate parameter definitions coming from a spec or the dashboard. */
export function sanitizeParameters(params: unknown[], credentialHeader: string): { params: ToolParameter[]; dropped: string[] } {
  const out: ToolParameter[] = []
  const dropped: string[] = []
  const seen = new Set<string>()
  for (const raw of params.slice(0, MAX_PARAMS_PER_TOOL)) {
    const p = raw as Partial<ToolParameter> & { schema?: any }
    const name = typeof p?.name === 'string' ? p.name : ''
    const where = p?.in ?? 'query'
    if (!PARAM_NAME.test(name) || !['query', 'path', 'header'].includes(where)) {
      dropped.push(name || '(unnamed)')
      continue
    }
    if (where === 'header' && (!isValidHeaderName(name) || isReservedHeader(name, credentialHeader))) {
      dropped.push(name)
      continue
    }
    const key = `${where}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    const enumValues = Array.isArray(p.schema?.enum)
      ? p.schema.enum.filter((v: unknown) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 200)
      : undefined
    out.push({
      name,
      in: where as ToolParameter['in'],
      description: typeof p.description === 'string' ? p.description.slice(0, 1000) : '',
      required: where === 'path' ? true : Boolean(p.required),
      schema: { type: normalizeType(p.schema?.type), ...(enumValues?.length ? { enum: enumValues } : {}) },
    })
  }
  return { params: out, dropped }
}

export function buildJsonSchema(tool: McpTool): { type: 'object'; properties: Record<string, any>; required: string[]; additionalProperties: boolean } {
  const properties: Record<string, any> = {}
  const required: string[] = []

  for (const param of tool.parameters) {
    const type = normalizeType(param.schema?.type)
    properties[param.name] = {
      type,
      description: `[${param.in ?? 'query'}] ${param.description || param.name}`,
      ...(param.schema?.enum ? { enum: param.schema.enum } : {}),
      ...(type === 'string' ? { maxLength: param.in === 'header' ? MAX_HEADER_VALUE_LENGTH : MAX_PARAM_STRING } : {}),
    }
    if (param.required) required.push(param.name)
  }

  const body = tool.requestBodySchema as any
  if (body && typeof body === 'object') {
    for (const [key, val] of Object.entries<any>(body.properties ?? {})) {
      if (properties[key]) continue
      properties[key] = {
        type: normalizeType(val?.type),
        description: `[body] ${typeof val?.description === 'string' ? val.description : key}`,
        ...(Array.isArray(val?.enum) ? { enum: val.enum } : {}),
      }
    }
    if (Array.isArray(body.required)) {
      for (const r of body.required) if (typeof r === 'string' && properties[r] && !required.includes(r)) required.push(r)
    }
  }

  return { type: 'object', properties, required, additionalProperties: false }
}

const ajv = new Ajv({ coerceTypes: true, allErrors: false, strict: false })
const validatorCache = new Map<string, ValidateFunction>()

/** Validates and type-coerces tool arguments against the tool's declared schema. */
export function validateToolArgs(tool: McpTool, rawArgs: unknown): Record<string, unknown> {
  if (rawArgs === undefined || rawArgs === null) rawArgs = {}
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) throw new ToolInputError('Arguments must be a JSON object')
  const size = Buffer.byteLength(JSON.stringify(rawArgs), 'utf8')
  if (size > MAX_ARGS_BYTES) throw new ToolInputError(`Arguments too large (${size} bytes, max ${MAX_ARGS_BYTES})`)

  const schema = buildJsonSchema(tool)
  const cacheKey = `${tool.id}:${JSON.stringify(schema)}`
  let validate = validatorCache.get(cacheKey)
  if (!validate) {
    validate = ajv.compile(schema) as ValidateFunction
    if (validatorCache.size > 2000) validatorCache.clear()
    validatorCache.set(cacheKey, validate)
  }
  const args = structuredClone(rawArgs) as Record<string, unknown>
  if (!validate(args)) {
    const e = validate.errors?.[0]
    const where = e?.instancePath ? e.instancePath.slice(1) : (e?.params as any)?.missingProperty ?? (e?.params as any)?.additionalProperty ?? 'arguments'
    throw new ToolInputError(`Invalid argument "${where}": ${e?.message ?? 'does not match schema'}`)
  }

  for (const param of tool.parameters) {
    const value = args[param.name]
    if (value === undefined) continue
    if (typeof value === 'object' && value !== null) throw new ToolInputError(`Argument "${param.name}" must be a scalar value`)
    const text = String(value)
    if (param.in === 'header' && !isValidHeaderValue(text)) {
      throw new ToolInputError(`Argument "${param.name}" contains characters not allowed in an HTTP header`)
    }
    if (param.in === 'path') {
      if (text === '' || text === '.' || text === '..') throw new ToolInputError(`Argument "${param.name}" is not a valid path segment`)
    }
    if (text.length > MAX_PARAM_STRING) throw new ToolInputError(`Argument "${param.name}" is too long`)
  }
  return args
}

/** Builds the upstream URL and proves it stays on the base origin and under the base path. */
export function buildUpstreamUrl(baseUrl: string, tool: McpTool, args: Record<string, unknown>): URL {
  const base = new URL(baseUrl)
  const basePath = base.pathname.replace(/\/+$/, '')
  let path = tool.path
  const pathError = validateToolPath(path)
  if (pathError) throw new ToolInputError(`Tool path rejected: ${pathError}`)

  for (const name of pathPlaceholders(path)) {
    const value = args[name]
    if (value === undefined || value === null || String(value) === '') {
      throw new ToolInputError(`Missing required path parameter "${name}"`)
    }
    const text = String(value)
    if (text === '.' || text === '..') throw new ToolInputError(`Argument "${name}" is not a valid path segment`)
    path = path.split(`{${name}}`).join(encodeURIComponent(text))
  }

  const url = new URL(`${base.origin}${basePath}${path}`)
  const expectedPath = `${basePath}${path}`
  if (url.origin !== base.origin || url.username || url.password) {
    throw new ToolInputError('Constructed URL leaves the configured base origin')
  }
  if (url.pathname !== expectedPath || (basePath && !url.pathname.startsWith(basePath + '/'))) {
    throw new ToolInputError('Constructed URL leaves the configured base path')
  }
  return url
}

// ── Response shaping ───────────────────────────────────────────────────────────

export const MAX_RESPONSE_FIELDS = 100
const FIELD_SEGMENT = /^[A-Za-z0-9_$@-]{1,64}$/
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** A response field path: up to 10 dot-separated JSON keys, e.g. "docs.title". */
export function isValidFieldPath(path: string): boolean {
  if (typeof path !== 'string' || path.length > 256) return false
  const parts = path.split('.')
  return parts.length <= 10 && parts.every(p => FIELD_SEGMENT.test(p) && !UNSAFE_KEYS.has(p))
}

interface FieldTrie { leaf: boolean; children: Map<string, FieldTrie> }

function pick(value: unknown, node: FieldTrie): unknown {
  if (node.leaf) return value
  if (Array.isArray(value)) return value.map(v => pick(v, node))
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const [key, child] of node.children) {
    if (!Object.hasOwn(value, key)) continue
    const picked = pick((value as Record<string, unknown>)[key], child)
    if (picked !== undefined) out[key] = picked
  }
  return out
}

function isEmptyShape(value: unknown): boolean {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.every(isEmptyShape)
  return !!value && typeof value === 'object' && Object.keys(value).length === 0
}

/**
 * Keeps only the listed fields. Arrays are traversed, so "docs.title" keeps the title of every
 * doc. If nothing matches (the API changed shape), the full response is returned rather than an
 * empty one, so the model is never left with nothing.
 */
export function projectResponse(data: unknown, paths: string[]): unknown {
  const root: FieldTrie = { leaf: false, children: new Map() }
  for (const path of paths) {
    if (!isValidFieldPath(path)) continue
    let node = root
    for (const seg of path.split('.')) {
      let next = node.children.get(seg)
      if (!next) node.children.set(seg, (next = { leaf: false, children: new Map() }))
      node = next
    }
    node.leaf = true
  }
  if (!root.children.size || !data || typeof data !== 'object') return data
  const shaped = pick(data, root)
  return isEmptyShape(shaped) ? data : shaped
}
