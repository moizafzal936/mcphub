import type { App, McpTool } from '../types/index.js'
import { safeRequest, SsrfBlockedError } from '../security/ssrf.js'
import { isReservedHeader, isValidHeaderValue } from '../security/headers.js'
import { redactString } from '../security/redact.js'
import { forgetAccessToken, getAccessToken, UpstreamAuthError } from './upstreamAuth.js'
import { ToolInputError, buildUpstreamUrl, projectResponse, secretForms, toolForApp, validateToolArgs } from './toolSchema.js'

// What AI clients receive. Big API responses would otherwise flood the model's context window.
const MAX_MODEL_CHARS = Number(process.env.MCPHUB_MAX_TOOL_RESPONSE_CHARS) || 40_000
const MAX_UPSTREAM_RESPONSE_BYTES = 5_000_000
const MAX_UPSTREAM_REQUEST_BYTES = 256 * 1024
const UPSTREAM_TIMEOUT_MS = 15_000

export interface ExecResult {
  data: unknown
  statusCode: number
  durationMs: number
  text: string
  /** Set when the call never reached the upstream API (bad input, blocked destination, network). */
  error?: string
  /** What was sent upstream (no headers, so never the credential). Shown to the owner only. */
  request?: { method: string; url: string }
  /** True when `text` (what AI clients get) was cut down to the tool's chosen response fields. */
  shaped?: boolean
}

function fitArray(items: unknown[], budget: number): { kept: unknown[]; omitted: number } {
  const kept: unknown[] = []
  let used = 2
  for (const item of items) {
    const size = JSON.stringify(item, null, 2).length + 4
    if (used + size > budget && kept.length > 0) break
    kept.push(item)
    used += size
  }
  return { kept, omitted: items.length - kept.length }
}

/**
 * Formats a response for an AI client within MAX_MODEL_CHARS. Long lists (top level, or the
 * largest list one level down, e.g. {"results": [...]}) keep whole items and say how many were
 * left out, so the model can narrow its request instead of reading a cut-off fragment.
 */
export function formatForModel(data: unknown, maxChars = MAX_MODEL_CHARS): string {
  const full = typeof data === 'string' ? data : JSON.stringify(data, null, 2) ?? ''
  if (full.length <= maxChars) return full
  const note = (shown: number, total: number) =>
    `\n[Showing ${shown} of ${total} items to keep the response small. Use filters, paging or limit parameters to get specific items.]`

  // Estimate with fitArray, then drop items until the exact rendering (with nesting indentation) fits.
  const shrink = (list: unknown[], render: (kept: unknown[]) => string): string | undefined => {
    let { kept } = fitArray(list, maxChars)
    let out = render(kept)
    while (out.length > maxChars && kept.length > 1) {
      kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.9)))
      out = render(kept)
    }
    return kept.length < list.length && out.length <= maxChars ? out : undefined
  }

  if (Array.isArray(data)) {
    const out = shrink(data, kept => JSON.stringify(kept, null, 2) + note(kept.length, data.length))
    if (out) return out
  } else if (data && typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>)
    const [key, list] = entries.filter(([, v]) => Array.isArray(v)).sort((a, b) => (b[1] as unknown[]).length - (a[1] as unknown[]).length)[0] ?? []
    if (key && Array.isArray(list)) {
      const out = shrink(list, kept => JSON.stringify({ ...(data as object), [key]: kept }, null, 2) + note(kept.length, list.length))
      if (out) return out
    }
  }
  return full.slice(0, maxChars) + `\n[Response cut at ${maxChars} of ${full.length} characters. Request less data to see the rest.]`
}

function failure(start: number, message: string): ExecResult {
  return { data: { error: message }, statusCode: 0, durationMs: Date.now() - start, text: `Error: ${message}`, error: message }
}

/**
 * Executes a tool against the app's upstream API. `apiKey` is the decrypted credential; it is
 * used only for the outbound header and scrubbed from everything returned.
 */
export async function executeTool(
  app: App,
  apiKey: string | undefined,
  appTool: McpTool,
  rawArgs: unknown,
  fixed: { in: 'header' | 'query'; name: string; secret: boolean; value: string }[] = []
): Promise<ExecResult> {
  const start = Date.now()
  const secrets = [...secretForms(apiKey), ...fixed.filter(f => f.secret).flatMap(f => secretForms(f.value))]
  const tool = toolForApp(app, appTool)

  let args: Record<string, unknown>
  let url: URL
  try {
    args = validateToolArgs(tool, rawArgs)
    url = buildUpstreamUrl(app.baseUrl, tool, args)
  } catch (err) {
    if (err instanceof ToolInputError) return failure(start, err.message)
    throw err
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  const queryParams: Record<string, string> = {}
  for (const param of tool.parameters) {
    const value = args[param.name]
    if (value === undefined || param.in === 'path') continue
    if (param.in === 'header') {
      const text = String(value)
      if (isReservedHeader(param.name, app.apiKeyHeader) || !isValidHeaderValue(text)) {
        return failure(start, `Header parameter "${param.name}" is not allowed`)
      }
      headers[param.name] = text
    } else {
      queryParams[param.name] = String(value)
    }
  }

  // Fixed params are set by the owner and win over anything the caller sent.
  for (const f of fixed) {
    if (f.in === 'header') {
      if (!isValidHeaderValue(f.value)) return failure(start, `Fixed header "${f.name}" has a value that cannot be sent`)
      headers[f.name] = f.value
    } else {
      queryParams[f.name] = f.value
    }
  }

  const oauth = app.authType === 'oauth2_client_credentials'
  let usedCachedToken = false
  const applyToken = async (fresh: boolean): Promise<string | undefined> => {
    try {
      const { token, cached } = await getAccessToken(app, apiKey!, { fresh })
      usedCachedToken = cached
      headers.Authorization = `Bearer ${token}`
      secrets.push(...secretForms(token))
      return undefined
    } catch (err) {
      if (err instanceof UpstreamAuthError) return err.message
      throw err
    }
  }
  if (oauth) {
    if (!apiKey) return failure(start, 'No OAuth client secret is stored for this app (add it in Settings)')
    const authError = await applyToken(false)
    if (authError) return failure(start, `Could not get an access token: ${authError}`)
  } else if (apiKey && app.apiKeyIn === 'query') {
    queryParams[app.apiKeyHeader] = apiKey
  } else if (apiKey) {
    const value = app.apiKeyHeader.toLowerCase() === 'authorization' && !/^\w+\s/.test(apiKey) ? `Bearer ${apiKey}` : apiKey
    if (!isValidHeaderValue(value)) return failure(start, 'Stored credential contains characters not allowed in an HTTP header')
    headers[app.apiKeyHeader] = value
  }

  let body: Record<string, unknown> | undefined
  const bodyProps = (tool.requestBodySchema as any)?.properties
  if (tool.method !== 'GET' && bodyProps && typeof bodyProps === 'object') {
    body = {}
    for (const key of Object.keys(bodyProps)) {
      if (args[key] !== undefined && !tool.parameters.some(p => p.name === key)) body[key] = args[key]
    }
    if (Object.keys(body).length === 0) body = undefined
  }

  const shown = new URL(url)
  const hiddenInPreview = new Set(fixed.filter(f => f.secret && f.in === 'query').map(f => f.name))
  if (apiKey && app.apiKeyIn === 'query' && !oauth) hiddenInPreview.add(app.apiKeyHeader)
  for (const [k, v] of Object.entries(queryParams)) {
    shown.searchParams.set(k, hiddenInPreview.has(k) ? '[REDACTED]' : v)
  }
  const request = { method: tool.method, url: shown.toString().replaceAll('%5BREDACTED%5D', '[REDACTED]') }

  const send = () => safeRequest({
    method: tool.method,
    url: url.toString(),
    params: queryParams,
    headers: { ...headers },
    data: body,
    redirects: 'same-origin',
    timeout: UPSTREAM_TIMEOUT_MS,
    maxContentLength: MAX_UPSTREAM_RESPONSE_BYTES,
    maxBodyLength: MAX_UPSTREAM_REQUEST_BYTES,
  })

  try {
    let response = await send()
    // A cached token may have been revoked early: fetch a fresh one and retry once.
    if (oauth && usedCachedToken && response.status === 401) {
      forgetAccessToken(app.id)
      const authError = await applyToken(true)
      if (authError) return failure(start, `Could not get an access token: ${authError}`)
      response = await send()
    }
    const raw = typeof response.data === 'string' ? response.data : String(response.data ?? '')
    const scrubbed = redactString(raw, secrets)
    let parsed: unknown = scrubbed
    try {
      parsed = JSON.parse(scrubbed)
    } catch {}
    // Shape only successful responses: error bodies must reach the model intact.
    const ok = response.status >= 200 && response.status < 300
    const forModel = ok && tool.responseFields?.length ? projectResponse(parsed, tool.responseFields) : parsed
    return {
      data: parsed, statusCode: response.status, durationMs: Date.now() - start, text: formatForModel(forModel), request,
      ...(forModel !== parsed ? { shaped: true } : {}),
    }
  } catch (err: any) {
    if (err instanceof SsrfBlockedError || err?.cause instanceof SsrfBlockedError || err?.code === 'SSRF_BLOCKED') {
      return failure(start, 'Request blocked: destination is not a public address')
    }
    if (err?.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED' || /maxContentLength/i.test(err?.message ?? '')) {
      return failure(start, 'Upstream response exceeded the 5 MB limit')
    }
    if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') return failure(start, 'Upstream request timed out')
    const msg = redactString(err instanceof Error ? err.message : String(err), secrets)
    return failure(start, `Upstream request failed: ${msg}`)
  }
}
