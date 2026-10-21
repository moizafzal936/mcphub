import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  startFixtures, startServer, registerUser, createApp, addTool, openSse, initializeMessage,
  type Fixtures, type TestServer, type Client,
} from './helpers.js'

const SECRET = 'sk-mcp-SECRET-abcdefghijklmnop'
let fx: Fixtures
let srv: TestServer
let alice: Client
let bob: Client

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx, { MCPHUB_MAX_SSE_PER_APP: '3' })
  alice = await registerUser(srv.base, 'alice@example.test')
  bob = await registerUser(srv.base, 'bob@example.test')
})
after(async () => {
  await srv.close()
  await fx.close()
})

async function mintToken(c: Client, appId: string, body: Record<string, unknown> = {}) {
  const res = await c.post(`/api/apps/${appId}/tokens`, body)
  assert.equal(res.status, 201)
  assert.match(res.body.token, /^mcph_/)
  return res.body as { id: string; token: string }
}

async function connect(appId: string, token?: string) {
  const transport = new SSEClientTransport(new URL(`${srv.base}/mcp/${appId}/sse`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  })
  const client = new McpClient({ name: 'mcphub-test', version: '1.0.0' })
  await client.connect(transport)
  return client
}

function postMessage(endpoint: string, token: string, body: unknown = initializeMessage) {
  return fetch(new URL(endpoint, srv.base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

test('real MCP client: list tools and call one end-to-end with the stored credential', async () => {
  const app = await createApp(alice, fx, { apiKey: SECRET })
  await addTool(alice, app.id, { name: 'get_item', path: '/items/{id}' })
  await addTool(alice, app.id, { name: 'echo', path: '/echo', queryParams: [{ name: 'q', description: 'query' }] })
  const { token } = await mintToken(alice, app.id)

  const client = await connect(app.id, token)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(t => t.name).sort(), ['echo', 'get_item'])
  assert.deepEqual(tools.find(t => t.name === 'get_item')!.inputSchema.required, ['id'])
  assert.equal(tools.find(t => t.name === 'get_item')!.annotations?.readOnlyHint, true)

  const result: any = await client.callTool({ name: 'get_item', arguments: { id: 'abc 123' } })
  assert.equal(result.isError, false)
  assert.deepEqual(JSON.parse(result.content[0].text), { id: 'abc 123' })
  const hit = fx.upstreamHits.at(-1)!
  assert.equal(hit.url, '/v1/items/abc%20123')
  assert.equal(hit.headers.authorization, `Bearer ${SECRET}`)

  const bad: any = await client.callTool({ name: 'echo', arguments: { q: { nested: true } } })
  assert.equal(bad.isError, true)
  await client.close()
})

test('MCP endpoints reject missing, malformed, foreign and query-string tokens', async () => {
  const app = await createApp(alice, fx)
  const other = await createApp(alice, fx, { name: 'other' })
  const { token: otherToken } = await mintToken(alice, other.id)
  const url = `${srv.base}/mcp/${app.id}/sse`

  assert.equal((await fetch(url)).status, 401)
  assert.match((await fetch(url)).headers.get('www-authenticate') ?? '', /Bearer/)
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer nope' } })).status, 401)
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${otherToken}` } })).status, 401)
  assert.equal((await fetch(`${url}?token=${otherToken}`)).status, 400)
  assert.equal((await fetch(`${srv.base}/mcp/${app.id}/messages?sessionId=x`, { method: 'POST' })).status, 401)
  await assert.rejects(connect(app.id))
})

test('session isolation: another token or another app cannot drive an existing session', async () => {
  const app = await createApp(alice, fx)
  const { token: t1 } = await mintToken(alice, app.id)
  const { token: t2 } = await mintToken(alice, app.id)
  const bobApp = await createApp(bob, fx)
  const { token: bobToken } = await mintToken(bob, bobApp.id)

  const sse = await openSse(srv.base, app.id, t1)
  assert.equal(sse.status, 200)
  assert.equal((await postMessage(sse.endpoint, t2)).status, 404, 'second token of same app hijacked the session')
  const crossApp = await postMessage(`/mcp/${bobApp.id}/messages?sessionId=${sse.sessionId}`, bobToken)
  assert.equal(crossApp.status, 404, "another user's app endpoint reached this session")
  assert.equal((await postMessage(sse.endpoint, t1)).status, 202)
  sse.close()
})

test('revoking a token rejects further requests and closes its live SSE stream', async () => {
  const app = await createApp(alice, fx)
  const { id, token } = await mintToken(alice, app.id)
  const sse = await openSse(srv.base, app.id, token)
  assert.equal((await postMessage(sse.endpoint, token)).status, 202)

  const revoke = await alice.del(`/api/apps/${app.id}/tokens/${id}`)
  assert.equal(revoke.body.closedSessions, 1)
  await sse.ended
  assert.equal((await postMessage(sse.endpoint, token)).status, 401)
  assert.equal((await openSse(srv.base, app.id, token)).status, 401)
})

test('expired tokens are rejected', async () => {
  const { getDb } = await import('../src/storage/db.js')
  const app = await createApp(alice, fx)
  const { id, token } = await mintToken(alice, app.id, { expiresInDays: 1 })
  await getDb().execute({ sql: 'UPDATE mcp_tokens SET expires_at = ? WHERE id = ?', args: [Date.now() - 1000, id] })
  assert.equal((await openSse(srv.base, app.id, token)).status, 401)
})

test('deleting an app closes its sessions and invalidates its tokens', async () => {
  const app = await createApp(alice, fx)
  const { token } = await mintToken(alice, app.id)
  const sse = await openSse(srv.base, app.id, token)
  assert.equal((await alice.del(`/api/apps/${app.id}`)).status, 200)
  await sse.ended
  assert.equal((await postMessage(sse.endpoint, token)).status, 401)
})

test('concurrent SSE connections per app are capped', async () => {
  const app = await createApp(alice, fx)
  const { token } = await mintToken(alice, app.id)
  const open = [await openSse(srv.base, app.id, token), await openSse(srv.base, app.id, token), await openSse(srv.base, app.id, token)]
  assert.ok(open.every(s => s.status === 200))
  assert.equal((await openSse(srv.base, app.id, token)).status, 429)
  open.forEach(s => s.close())
})

test('oversized MCP message bodies are rejected without crashing', async () => {
  const app = await createApp(alice, fx)
  const { token } = await mintToken(alice, app.id)
  const sse = await openSse(srv.base, app.id, token)
  const huge = { ...initializeMessage, params: { ...initializeMessage.params, pad: 'x'.repeat(400_000) } }
  assert.equal((await postMessage(sse.endpoint, token, huge)).status, 413)
  assert.equal((await fetch(`${srv.base}/health`)).status, 200)
  sse.close()
})

// ── Streamable HTTP transport ──────────────────────────────────────────────────

async function connectHttp(appId: string, token?: string) {
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/${appId}`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  })
  const client = new McpClient({ name: 'mcphub-http-test', version: '1.0.0' })
  await client.connect(transport)
  return client
}

test('streamable HTTP: real MCP client lists and calls tools with the stored credential', async () => {
  const app = await createApp(alice, fx, { apiKey: SECRET })
  await addTool(alice, app.id, { name: 'get_item', path: '/items/{id}' })
  const { token } = await mintToken(alice, app.id)

  const client = await connectHttp(app.id, token)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(t => t.name), ['get_item'])
  const result: any = await client.callTool({ name: 'get_item', arguments: { id: 'http-1' } })
  assert.equal(result.isError, false)
  assert.deepEqual(JSON.parse(result.content[0].text), { id: 'http-1' })
  assert.equal(fx.upstreamHits.at(-1)!.headers.authorization, `Bearer ${SECRET}`)
  await client.close()
})

test('streamable HTTP: auth, app binding, Origin and method checks', async () => {
  const app = await createApp(alice, fx)
  const other = await createApp(alice, fx, { name: 'other-http' })
  const { token } = await mintToken(alice, app.id)
  const { token: otherToken } = await mintToken(alice, other.id)
  const url = `${srv.base}/mcp/${app.id}`
  const post = (headers: Record<string, string>) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(initializeMessage),
  })

  assert.equal((await post({})).status, 401)
  assert.equal((await post({ authorization: `Bearer ${otherToken}` })).status, 401)
  assert.equal((await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status, 403)
  assert.equal((await post({ authorization: `Bearer ${token}` })).status, 200)
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 405)
  assert.equal((await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 405)
  await assert.rejects(connectHttp(app.id))
})

test('streamable HTTP: revoked tokens are rejected on the next request', async () => {
  const app = await createApp(alice, fx)
  await addTool(alice, app.id, { name: 'echo', path: '/echo' })
  const { id, token } = await mintToken(alice, app.id)
  const client = await connectHttp(app.id, token)
  assert.equal((await client.listTools()).tools.length, 1)
  await alice.del(`/api/apps/${app.id}/tokens/${id}`)
  await assert.rejects(client.listTools())
})

test('read-only mode hides and blocks write tools for AI clients', async () => {
  const app = await createApp(alice, fx)
  await addTool(alice, app.id, { name: 'read_item', path: '/items/{id}' })
  await addTool(alice, app.id, { name: 'create_item', method: 'POST', path: '/echo' })
  assert.equal((await alice.patch(`/api/apps/${app.id}`, { readOnly: true })).body.readOnly, true)
  const { token } = await mintToken(alice, app.id)

  const client = await connectHttp(app.id, token)
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['read_item'])
  const hits = fx.upstreamHits.length
  const blocked: any = await client.callTool({ name: 'create_item', arguments: {} })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content[0].text, /read-only/)
  assert.equal(fx.upstreamHits.length, hits, 'write reached upstream in read-only mode')

  await alice.patch(`/api/apps/${app.id}`, { readOnly: false })
  const allowed: any = await client.callTool({ name: 'create_item', arguments: {} })
  assert.equal(allowed.isError, false)
  await client.close()
})
