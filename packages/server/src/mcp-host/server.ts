import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Request, Response } from 'express'
import { getConfig } from '../config.js'
import { appRepo, toolRepo } from '../storage/db.js'
import { buildJsonSchema } from '../ingestion/toolSchema.js'
import { runTool } from '../ingestion/runTool.js'
import { HttpError } from '../http/errors.js'
import type { McpAuthExtra } from '../auth/auth.js'

interface McpSession {
  transport: SSEServerTransport
  server: Server
  appId: string
  userId: string
  tokenId: string
}

const sessions = new Map<string, McpSession>()

function authOf(req: Request): McpAuthExtra {
  const extra = req.auth?.extra as McpAuthExtra | undefined
  if (!extra) throw new HttpError(401, 'Authentication required')
  return extra
}

export async function handleSseConnection(req: Request, res: Response): Promise<void> {
  const auth = authOf(req)
  const app = await appRepo.findForOwner(auth.appId, auth.userId)
  if (!app) throw new HttpError(404, 'App not found')

  const { maxSsePerApp, maxSseTotal } = getConfig()
  const perApp = [...sessions.values()].filter(s => s.appId === app.id).length
  if (perApp >= maxSsePerApp || sessions.size >= maxSseTotal) {
    throw new HttpError(429, 'Too many concurrent MCP connections for this app')
  }

  const server = buildMcpServer(app.id, app.name, auth.userId)
  const transport = new SSEServerTransport(`/mcp/${app.id}/messages`, res)
  const session: McpSession = { transport, server, appId: app.id, userId: auth.userId, tokenId: auth.tokenId }
  sessions.set(transport.sessionId, session)
  transport.onclose = () => sessions.delete(transport.sessionId)
  res.on('close', () => sessions.delete(transport.sessionId))
  await server.connect(transport)
}

export async function handleSseMessage(req: Request, res: Response): Promise<void> {
  const auth = authOf(req)
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : ''
  const session = sessions.get(sessionId)
  // A session is only usable by the same token, on the same app, that opened it.
  if (!session || session.appId !== auth.appId || session.tokenId !== auth.tokenId) {
    throw new HttpError(404, 'Session not found')
  }
  await session.transport.handlePostMessage(req, res, req.body)
}

/**
 * Streamable HTTP transport (current MCP spec), stateless: every POST is authenticated, served by a
 * fresh server/transport pair and torn down, so no session state is held between requests.
 */
export async function handleStreamableHttp(req: Request, res: Response): Promise<void> {
  const auth = authOf(req)
  const app = await appRepo.findForOwner(auth.appId, auth.userId)
  if (!app) throw new HttpError(404, 'App not found')

  const server = buildMcpServer(app.id, app.name, auth.userId)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}

export async function closeSessions(predicate: (s: { appId: string; tokenId: string; userId: string }) => boolean): Promise<number> {
  const matching = [...sessions.entries()].filter(([, s]) => predicate(s))
  await Promise.allSettled(matching.map(async ([id, s]) => {
    sessions.delete(id)
    await s.server.close()
  }))
  return matching.length
}

export function activeSessionCount(): number {
  return sessions.size
}

function buildMcpServer(appId: string, appName: string, userId: string): Server {
  const server = new Server(
    { name: `mcphub-${appName}`.slice(0, 100), version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const app = await appRepo.findForOwner(appId, userId)
    if (!app) return { tools: [] }
    const tools = await toolRepo.findEnabledByAppId(appId)
    return {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: buildJsonSchema(tool),
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const auth = extra.authInfo?.extra as McpAuthExtra | undefined
    // Authorization is rechecked on every call: the token was verified for this POST, and the
    // app must still exist and belong to the same user.
    if (!auth || auth.appId !== appId || auth.userId !== userId) {
      return { content: [{ type: 'text' as const, text: 'Not authorized' }], isError: true }
    }
    const app = await appRepo.findForOwner(appId, userId)
    if (!app) return { content: [{ type: 'text' as const, text: 'App not found' }], isError: true }

    const tool = await toolRepo.findByNameInApp(appId, request.params.name)
    if (!tool || !tool.enabled) {
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }], isError: true }
    }

    const result = await runTool(app, tool, request.params.arguments ?? {}, `token:${auth.tokenId}`)
    const isError = result.statusCode === 0 || result.statusCode >= 400
    return {
      content: [{
        type: 'text' as const,
        text: isError && result.statusCode !== 0 ? `HTTP ${result.statusCode} Error:\n${result.text}` : result.text,
      }],
      isError,
    }
  })

  return server
}
