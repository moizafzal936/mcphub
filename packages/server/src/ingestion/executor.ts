import type { App, McpTool } from '../types/index.js'
import { safeRequest, SsrfBlockedError } from '../security/ssrf.js'
import { isReservedHeader, isValidHeaderValue } from '../security/headers.js'
import { redactString } from '../security/redact.js'
import { ToolInputError, buildUpstreamUrl, validateToolArgs } from './toolSchema.js'

const MAX_RESPONSE_TEXT = 500_000
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
}

function truncate(text: string): string {
  return text.length > MAX_RESPONSE_TEXT ? text.slice(0, MAX_RESPONSE_TEXT) + '\n[truncated]' : text
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
  tool: McpTool,
  rawArgs: unknown
): Promise<ExecResult> {
  const start = Date.now()
  const secrets = apiKey ? [apiKey] : []

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

  if (apiKey) {
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

  try {
    const response = await safeRequest({
      method: tool.method,
      url: url.toString(),
      params: queryParams,
      headers,
      data: body,
      redirects: 'same-origin',
      timeout: UPSTREAM_TIMEOUT_MS,
      maxContentLength: MAX_UPSTREAM_RESPONSE_BYTES,
      maxBodyLength: MAX_UPSTREAM_REQUEST_BYTES,
    })
    const raw = typeof response.data === 'string' ? response.data : String(response.data ?? '')
    const scrubbed = redactString(raw, secrets)
    let parsed: unknown = scrubbed
    try {
      parsed = JSON.parse(scrubbed)
    } catch {}
    const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)
    return { data: parsed, statusCode: response.status, durationMs: Date.now() - start, text: truncate(text) }
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
