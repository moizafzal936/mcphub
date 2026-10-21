import http from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'

export interface RecordedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

export interface Fixtures {
  upstreamPort: number
  internalPort: number
  upstreamHits: RecordedRequest[]
  internalHits: RecordedRequest[]
  /** Requests to the fixture OAuth token endpoint (/oauth/token). */
  tokenHits: RecordedRequest[]
  /** Invalidates every access token issued so far, as a server-side revocation would. */
  revokeTokens(): void
  close(): Promise<void>
}

export const OAUTH_CLIENT_ID = 'fixture-client'
export const OAUTH_CLIENT_SECRET = 'fixture-secret-Zq81+/='

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let data = ''
    req.on('data', c => (data += c))
    req.on('end', () => resolve(data))
  })
}

/** A controlled upstream API (allowlisted) plus an "internal" service that must never be reached. */
export async function startFixtures(): Promise<Fixtures> {
  const upstreamHits: RecordedRequest[] = []
  const internalHits: RecordedRequest[] = []
  const tokenHits: RecordedRequest[] = []
  const validTokens = new Set<string>()
  let tokenCounter = 0
  let upstreamPort = 0
  let internalPort = 0

  const internal = http.createServer(async (req, res) => {
    internalHits.push({ method: req.method!, url: req.url!, headers: req.headers, body: await readBody(req) })
    res.end('INTERNAL-SECRET')
  })

  const upstream = http.createServer(async (req, res) => {
    const body = await readBody(req)
    const url = new URL(req.url!, 'http://x')
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (url.pathname.startsWith('/oauth/')) {
      tokenHits.push({ method: req.method!, url: req.url!, headers: req.headers, body })
      const form = new URLSearchParams(body)
      let id = form.get('client_id')
      let secret = form.get('client_secret')
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')
      if (basic) {
        const [u, p] = Buffer.from(basic[1], 'base64').toString().split(':')
        id = decodeURIComponent(u)
        secret = decodeURIComponent(p ?? '')
      }
      if (form.get('grant_type') !== 'client_credentials') return json(400, { error: 'unsupported_grant_type' })
      if (id !== OAUTH_CLIENT_ID || secret !== OAUTH_CLIENT_SECRET) return json(401, { error: 'invalid_client', error_description: 'Client authentication failed' })
      const token = `fixture-access-token-${++tokenCounter}`
      validTokens.add(token)
      if (url.pathname === '/oauth/token-mac') return json(200, { access_token: token, token_type: 'mac', expires_in: 3600 })
      // Tokens shorter-lived than the refresh margin are fetched again on every call.
      const expires = url.pathname === '/oauth/token-short' ? 30 : 3600
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: expires, ...(form.get('scope') ? { scope: form.get('scope') } : {}) })
    }
    upstreamHits.push({ method: req.method!, url: req.url!, headers: req.headers, body })
    if (url.pathname === '/v1/protected') {
      const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      if (!presented || !validTokens.has(presented)) return json(401, { error: 'invalid_token' })
      return json(200, { ok: true, token: presented })
    }
    const redirect = (to: string) => {
      res.writeHead(302, { location: to })
      res.end()
    }
    switch (true) {
      case url.pathname === '/v1/echo':
        return json(200, { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body })
      case url.pathname.startsWith('/v1/items/'):
        return json(200, { id: decodeURIComponent(url.pathname.slice('/v1/items/'.length)) })
      case url.pathname === '/v1/leak':
        return json(200, { youSent: req.headers.authorization, other: req.headers['x-api-key'] })
      case url.pathname === '/v1/redirect-same':
        return redirect('/v1/echo?redirected=1')
      case url.pathname === '/v1/redirect-internal':
        return redirect(`http://127.0.0.1:${internalPort}/secret`)
      case url.pathname === '/v1/redirect-cross':
        return redirect(`http://localhost:${upstreamPort}/v1/echo`)
      case url.pathname === '/v1/unauthorized':
        return json(401, { error: 'invalid api key' })
      case url.pathname === '/v1/many':
        return json(200, Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item-${i}`, note: 'x'.repeat(60) })))
      case url.pathname === '/v1/wrapped':
        return json(200, { total: 2000, results: Array.from({ length: 2000 }, (_, i) => ({ id: i, note: 'y'.repeat(60) })) })
      case url.pathname === '/v1/big':
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ blob: 'x'.repeat(6_000_000) }))
      case url.pathname === '/openapi.json':
        return json(200, {
          openapi: '3.0.0',
          paths: {
            '/echo': { get: { operationId: 'echoGet', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }] } },
            '/items/{id}': { get: { operationId: 'getItem', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
            '/bad': { get: { operationId: 'badHeaders', parameters: [
              { name: 'Host', in: 'header', schema: { type: 'string' } },
              { name: 'Authorization', in: 'header', schema: { type: 'string' } },
              { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
            ] } },
            '//evil.example/x': { get: { operationId: 'escape' } },
          },
        })
      case url.pathname === '/spec-cyclic.json':
        return json(200, {
          openapi: '3.0.0',
          components: { schemas: { Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } } } },
          paths: { '/echo': { post: { operationId: 'cyclic', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } },
        })
      case url.pathname === '/spec-redirect-internal':
        return redirect(`http://127.0.0.1:${internalPort}/openapi.json`)
      default:
        return json(404, { error: 'not found' })
    }
  })

  upstreamPort = await listen(upstream)
  internalPort = await listen(internal)
  return {
    upstreamPort,
    internalPort,
    upstreamHits,
    internalHits,
    tokenHits,
    revokeTokens: () => validTokens.clear(),
    close: async () => {
      upstream.closeAllConnections()
      internal.closeAllConnections()
      await Promise.all([new Promise(r => upstream.close(r)), new Promise(r => internal.close(r))])
    },
  }
}

export interface TestServer {
  base: string
  dataDir: string
  close(): Promise<void>
}

/** Boots the real app in-process. Must be called before any other import of src modules. */
export async function startServer(fixtures: Fixtures, env: Record<string, string> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcphub-test-'))
  // The OAuth issuer must be known before boot, so reserve a port first.
  const probe = http.createServer()
  const port = await listen(probe)
  await new Promise(r => probe.close(r))
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: String(port),
    MCPHUB_PUBLIC_URL: `http://127.0.0.1:${port}`,
    MCPHUB_DASHBOARD_URL: `http://127.0.0.1:${port}`,
    MCPHUB_DATA_DIR: dataDir,
    MCPHUB_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    MCPHUB_SSRF_ALLOW: `127.0.0.1:${fixtures.upstreamPort}`,
    MCPHUB_ALLOW_SIGNUP: 'true',
    MCPHUB_RATE_API_PER_MIN: '100000',
    MCPHUB_RATE_AUTH_PER_15MIN: '1000',
    MCPHUB_RATE_APP_PER_MIN: '100000',
    MCPHUB_RATE_CLIENT_PER_MIN: '100000',
    MCPHUB_RATE_SSE_CONNECT_PER_MIN: '1000',
    ...env,
  })
  const { createApp, initialize } = await import('../src/app.js')
  const { closeDb } = await import('../src/storage/db.js')
  const { closeSessions } = await import('../src/mcp-host/server.js')
  await initialize()
  const server = createApp().listen(port, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    close: async () => {
      await closeSessions(() => true)
      server.closeAllConnections()
      await new Promise(r => server.close(r))
      closeDb()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

export interface ApiResponse<T = any> {
  status: number
  body: T
  headers: Headers
}

/** Minimal browser-like client: keeps the session cookie, sends same-origin fetch metadata. */
export class Client {
  cookie = ''
  constructor(public base: string) {}

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) this.cookie = setCookie.split(';')[0]
    const text = await res.text()
    let parsed: any = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    return { status: res.status, body: parsed, headers: res.headers }
  }

  get<T = any>(path: string) { return this.req<T>('GET', path) }
  post<T = any>(path: string, body: unknown = {}) { return this.req<T>('POST', path, body) }
  patch<T = any>(path: string, body: unknown) { return this.req<T>('PATCH', path, body) }
  del<T = any>(path: string) { return this.req<T>('DELETE', path) }
}

let userCounter = 0
export async function registerUser(base: string, email = `user${++userCounter}-${Date.now()}@example.test`): Promise<Client> {
  const c = new Client(base)
  const res = await c.post('/api/auth/register', { email, password: 'correct horse battery staple' })
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`)
  return c
}

export async function createApp(c: Client, fixtures: Fixtures, extra: Record<string, unknown> = {}) {
  const res = await c.post('/api/apps', { name: 'Fixture API', baseUrl: `http://127.0.0.1:${fixtures.upstreamPort}/v1`, ...extra })
  if (res.status !== 201) throw new Error(`create app failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body as { id: string; [k: string]: any }
}

export async function addTool(c: Client, appId: string, tool: Record<string, unknown>) {
  const res = await c.post(`/api/apps/${appId}/tools`, { method: 'GET', ...tool })
  if (res.status !== 201) throw new Error(`add tool failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body as { id: string; name: string }
}

/** Opens a raw SSE stream and returns the session endpoint plus a way to observe/close the stream. */
export async function openSse(base: string, appId: string, token: string) {
  const controller = new AbortController()
  const res = await fetch(`${base}/mcp/${appId}/sse`, {
    headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
    signal: controller.signal,
  })
  if (res.status !== 200) {
    controller.abort()
    return { status: res.status, endpoint: '', sessionId: '', ended: Promise.resolve(), close: () => {} }
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (!buf.includes('event: endpoint')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
  }
  const endpoint = buf.match(/data: (\S+)/)![1]
  const ended = (async () => {
    try {
      while (!(await reader.read()).done) {}
    } catch {}
  })()
  return {
    status: 200,
    endpoint,
    sessionId: new URL(endpoint, base).searchParams.get('sessionId')!,
    ended,
    close: () => controller.abort(),
  }
}

export const initializeMessage = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
}
