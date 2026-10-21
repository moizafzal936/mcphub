import type { App, McpTool } from '../types/index.js'
import { appRepo, logRepo, newId } from '../storage/db.js'
import { consumeToolCall, RateLimitedError } from '../security/rateLimit.js'
import { redactForLog } from '../security/redact.js'
import { executeTool, type ExecResult } from './executor.js'

/** Single entry point for tool execution (dashboard and MCP): rate limit, execute, log redacted. */
export async function runTool(app: App, tool: McpTool, args: unknown, clientKey: string): Promise<ExecResult> {
  const start = Date.now()
  try {
    await consumeToolCall(app.id, app.rateLimitPerMin, clientKey)
  } catch (err) {
    if (err instanceof RateLimitedError) {
      const message = `Rate limit exceeded; retry in ${err.retryAfterSec}s`
      return { data: { error: message }, statusCode: 429, durationMs: Date.now() - start, text: message, error: message }
    }
    throw err
  }

  let apiKey: string | undefined
  try {
    apiKey = await appRepo.getApiKey(app.id)
  } catch {
    const message = 'Stored credential could not be decrypted (check MCPHUB_ENCRYPTION_KEY)'
    return { data: { error: message }, statusCode: 0, durationMs: Date.now() - start, text: `Error: ${message}`, error: message }
  }

  const result = await executeTool(app, apiKey, tool, args)
  const secrets = apiKey ? [apiKey] : []
  await logRepo.insert({
    id: newId(),
    appId: app.id,
    toolName: tool.name,
    input: redactForLog(args, secrets, 4 * 1024),
    output: redactForLog(result.data, secrets),
    statusCode: result.statusCode,
    durationMs: result.durationMs,
    calledAt: Date.now(),
  })
  return result
}
