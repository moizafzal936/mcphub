import type { McpTool, ToolParameter } from '../types/index.js'
import { isReservedHeader, isValidHeaderName } from '../security/headers.js'
import { isSensitiveKey } from '../security/redact.js'
import { ToolInputError, sanitizeToolName, validateToolPath } from './toolSchema.js'

/** Splits a shell command into words: handles '…', "…", backslash escapes and line continuations. */
export function shellWords(input: string): string[] {
  const words: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  const src = input.replace(/\\\r?\n/g, ' ')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else cur += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) cur += src[++i]
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < src.length) {
      cur += src[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (has) words.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (quote) throw new ToolInputError('Unterminated quote in curl command')
  if (has) words.push(cur)
  return words
}

interface ParsedCurl {
  method: string
  url: URL
  headers: [string, string][]
  body?: string
  basicAuth: boolean
}

const VALUE_FLAGS = new Set(['-o', '--output', '-A', '--user-agent', '-e', '--referer', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '-w', '--write-out', '-b', '--cookie', '-c', '--cookie-jar', '--retry', '-K', '--config', '-T', '--upload-file', '-F', '--form'])

export function parseCurl(command: string): ParsedCurl {
  const words = shellWords(command.trim())
  if (words[0] !== 'curl') throw new ToolInputError('Paste a command that starts with "curl"')
  let method: string | undefined
  let rawUrl: string | undefined
  let body: string | undefined
  let forceGet = false
  let basicAuth = false
  const headers: [string, string][] = []

  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    const next = () => {
      if (i + 1 >= words.length) throw new ToolInputError(`Missing value for ${w}`)
      return words[++i]
    }
    if (w === '-X' || w === '--request') method = next().toUpperCase()
    else if (w.startsWith('-X') && w.length > 2) method = w.slice(2).toUpperCase()
    else if (w === '-H' || w === '--header') {
      const h = next()
      const idx = h.indexOf(':')
      if (idx > 0) headers.push([h.slice(0, idx).trim(), h.slice(idx + 1).trim()])
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii'].includes(w)) body = next()
    else if (w === '--json') {
      body = next()
      headers.push(['Content-Type', 'application/json'])
    } else if (w === '--data-urlencode') throw new ToolInputError('Form-encoded bodies are not supported; use a JSON body')
    else if (w === '-G' || w === '--get') forceGet = true
    else if (w === '-u' || w === '--user') {
      next()
      basicAuth = true
    } else if (w === '--url') rawUrl = next()
    else if (VALUE_FLAGS.has(w)) next()
    else if (w.startsWith('-')) continue
    else if (!rawUrl) rawUrl = w
  }
  if (!rawUrl) throw new ToolInputError('No URL found in the curl command')
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ToolInputError(`Invalid URL: ${rawUrl.slice(0, 200)}`)
  }
  if (forceGet && body) {
    for (const [k, v] of new URLSearchParams(body)) url.searchParams.append(k, v)
    body = undefined
  }
  return { method: method ?? (forceGet ? 'GET' : body !== undefined ? 'POST' : 'GET'), url, headers, body, basicAuth }
}

export function jsonType(value: unknown): string {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (Array.isArray(value)) return 'array'
  if (value && typeof value === 'object') return 'object'
  return 'string'
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]{2,6}_[A-Za-z0-9]{8,})$/i

function singular(word: string): string {
  return word.replace(/ies$/, 'y').replace(/s$/, '')
}

/** Builds a tool definition from a curl command whose URL must sit under the app's base URL. */
export function toolFromCurl(command: string, app: { id: string; baseUrl: string; apiKeyHeader: string; apiKeyIn?: 'header' | 'query' }, overrides: { name?: string; description?: string }) {
  const curl = parseCurl(command)
  const base = new URL(app.baseUrl)
  const basePath = base.pathname.replace(/\/+$/, '')
  if (curl.url.origin !== base.origin) {
    throw new ToolInputError(`This curl calls ${curl.url.origin}, but the app's base URL is ${base.origin}`)
  }
  if (basePath && curl.url.pathname !== basePath && !curl.url.pathname.startsWith(basePath + '/')) {
    throw new ToolInputError(`This curl's path is outside the app's base path ${basePath}`)
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(curl.method)) throw new ToolInputError(`Unsupported method ${curl.method}`)

  const params: ToolParameter[] = []
  const used = new Set<string>()
  const unique = (name: string) => {
    let n = name
    for (let i = 2; used.has(n); i++) n = `${name}${i}`
    used.add(n)
    return n
  }

  // Concrete IDs in the path become path parameters: /users/123/posts -> /users/{user_id}/posts
  const segments = curl.url.pathname.slice(basePath.length).split('/')
  const templated = segments.map((seg, i) => {
    if (!ID_SEGMENT.test(seg)) return seg
    const prev = segments[i - 1]
    const name = unique(prev && /^[A-Za-z][A-Za-z_-]*$/.test(prev) ? `${singular(prev).replace(/-/g, '_')}_id` : 'id')
    params.push({ name, in: 'path', description: `e.g. ${seg}`, required: true, schema: { type: 'string' } })
    return `{${name}}`
  })
  const path = templated.join('/') || '/'
  const pathError = validateToolPath(path)
  if (pathError) throw new ToolInputError(`Derived path rejected: ${pathError}`)

  const skippedQuery: string[] = []
  for (const [key, value] of curl.url.searchParams) {
    if (used.has(key)) continue
    // The app adds its own query credential, so the one pasted in the curl is dropped.
    if (app.apiKeyIn === 'query' && key.toLowerCase() === app.apiKeyHeader.toLowerCase()) {
      skippedQuery.push(key)
      continue
    }
    // Tool descriptions are shown to AI clients: never copy a key-like value into one.
    const example = isSensitiveKey(key) || /key|appid/i.test(key) ? key : `e.g. ${value}`.slice(0, 200)
    params.push({ name: unique(key), in: 'query', description: example, required: false, schema: { type: /^-?\d+$/.test(value) ? 'integer' : 'string' } })
  }

  const skippedHeaders = [...addHeaderParams(curl.headers, app.apiKeyHeader, params, used), ...skippedQuery.map(k => `?${k}`)]
  const requestBodySchema = curl.body !== undefined && curl.method !== 'GET' ? bodySchemaFromJson(curl.body, used) : undefined

  const name = overrides.name ?? sanitizeToolName(`${curl.method.toLowerCase()}_${segments.filter(s => s && !ID_SEGMENT.test(s)).join('_')}`).toLowerCase()
  const tool: Omit<McpTool, 'id'> = {
    appId: app.id,
    name,
    description: overrides.description || `${curl.method} ${path}`,
    method: curl.method as McpTool['method'],
    path,
    parameters: params,
    ...(requestBodySchema ? { requestBodySchema } : {}),
    enabled: true,
  }
  return { tool, skippedHeaders, usedBasicAuth: curl.basicAuth }
}

/** Adds non-credential headers as header params; returns the names that were skipped. */
export function addHeaderParams(headers: [string, string][], credentialHeader: string, params: ToolParameter[], used: Set<string>): string[] {
  const skipped: string[] = []
  for (const [name] of headers) {
    const lower = name.toLowerCase()
    if (lower === 'content-type' || lower === 'accept' || lower === 'user-agent') continue
    if (!isValidHeaderName(name) || isReservedHeader(name, credentialHeader) || /key|token|secret|auth/i.test(name)) {
      skipped.push(name)
      continue
    }
    if (!used.has(name)) {
      used.add(name)
      params.push({ name, in: 'header', description: `${name} header`, required: false, schema: { type: 'string' } })
    }
  }
  return skipped
}

/** Derives a typed body schema from an example JSON object body. */
export function bodySchemaFromJson(raw: string, used: Set<string>): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ToolInputError('Only JSON request bodies are supported')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const properties: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>).slice(0, 100)) {
    if (used.has(k)) continue
    properties[k] = { type: jsonType(v), description: `e.g. ${JSON.stringify(v)}`.slice(0, 200) }
  }
  return { type: 'object', properties, required: Object.keys(properties) }
}
