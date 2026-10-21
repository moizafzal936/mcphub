import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'crypto'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startFixtures, startServer, registerUser, createApp, addTool, Client, type Fixtures, type TestServer } from './helpers.js'

const SECRET = 'fixed-SECRET+value/9876='
let fx: Fixtures
let srv: TestServer
let alice: Client
let bob: Client

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx)
  alice = await registerUser(srv.base)
  bob = await registerUser(srv.base)
})
after(async () => {
  await srv.close()
  await fx.close()
})

const setFixed = (c: Client, appId: string, fixedParams: unknown, extra: Record<string, unknown> = {}) => c.patch(`/api/apps/${appId}`, { fixedParams, ...extra })
const exec = (appId: string, toolId: string, args: unknown = {}) => alice.post(`/api/apps/${appId}/tools/${toolId}/execute`, args)
const leaks = (v: unknown) => {
  const t = JSON.stringify(v)
  return t.includes(SECRET) || t.includes(encodeURIComponent(SECRET)) || t.includes(new URLSearchParams({ k: SECRET }).toString().slice(2))
}

async function appWithFixed() {
  const app = await createApp(alice, fx)
  const tool = await addTool(alice, app.id, {
    name: 'echo', path: '/echo',
    queryParams: [{ name: 'q', description: 'text' }, { name: 'api-version' }, { name: 'Notion-Version', in: 'header' }],
  })
  const res = await setFixed(alice, app.id, [
    { in: 'header', name: 'Notion-Version', value: '2022-06-28' },
    { in: 'query', name: 'api-version', value: '2024-01-01' },
    { in: 'header', name: 'X-App-Key', value: SECRET, secret: true },
    { in: 'query', name: 'tenant_key', value: SECRET, secret: true },
  ])
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return { app: res.body, tool }
}

test('fixed values go on every call, override the caller, and are hidden from AI clients', async () => {
  const { app, tool } = await appWithFixed()
  const res = await exec(app.id, tool.id, { q: 'hi' })
  assert.equal(res.body.statusCode, 200)
  const hit = fx.upstreamHits.at(-1)!
  const query = new URL(hit.url, 'http://x').searchParams
  assert.equal(hit.headers['notion-version'], '2022-06-28')
  assert.equal(hit.headers['x-app-key'], SECRET)
  assert.equal(query.get('api-version'), '2024-01-01')
  assert.equal(query.get('tenant_key'), SECRET)
  assert.equal(query.get('q'), 'hi')

  // The tool declared api-version and Notion-Version itself; they are no longer the caller's to set.
  const [listed] = (await alice.get(`/api/apps/${app.id}/tools`)).body
  assert.deepEqual(listed.parameters.map((p: any) => p.name), ['q'])
  const hits = fx.upstreamHits.length
  assert.equal((await exec(app.id, tool.id, { q: 'x', 'api-version': 'evil' })).body.statusCode, 0)
  assert.equal(fx.upstreamHits.length, hits)

  const { token } = (await alice.post(`/api/apps/${app.id}/tokens`, {})).body
  const mcp = new McpClient({ name: 'fixed-test', version: '1.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/${app.id}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  const { tools } = await mcp.listTools()
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties ?? {}), ['q'])
  const called = await mcp.callTool({ name: 'echo', arguments: { q: 'mcp' } })
  assert.ok(!leaks(called), 'secret returned to the MCP client')
  await mcp.close()
})

test('secret values are encrypted, never returned, and redacted from responses, logs and exports', async () => {
  const { app, tool } = await appWithFixed()
  const { getDb } = await import('../src/storage/db.js')
  const raw = await getDb().execute({ sql: 'SELECT fixed_params FROM apps WHERE id = ?', args: [app.id] })
  assert.ok(!String(raw.rows[0].fixed_params).includes(SECRET), 'secret stored in plaintext')

  const shown = (await alice.get(`/api/apps/${app.id}`)).body.fixedParams
  assert.deepEqual(shown.find((f: any) => f.name === 'X-App-Key'), { in: 'header', name: 'X-App-Key', secret: true, hasValue: true })
  assert.deepEqual(shown.find((f: any) => f.name === 'api-version'), { in: 'query', name: 'api-version', secret: false, value: '2024-01-01' })
  assert.ok(!leaks(shown))

  const res = await exec(app.id, tool.id, { q: 'x' })
  assert.equal(res.body.data.headers['x-app-key'], '[REDACTED]')
  assert.equal(res.body.data.query.tenant_key, '[REDACTED]')
  assert.match(res.body.request.url, /tenant_key=\[REDACTED\]/)
  assert.match(res.body.request.url, /api-version=2024-01-01/)
  assert.ok(!leaks(res.body), 'secret returned to the dashboard')
  assert.ok(!leaks((await alice.get(`/api/apps/${app.id}/logs`)).body), 'secret stored in logs')

  const config = (await alice.get(`/api/apps/${app.id}/export`)).body
  assert.ok(!leaks(config), 'secret exported')
  const imported = await alice.req('POST', '/api/apps/import-config', JSON.stringify(config), { 'content-type': 'text/plain' })
  assert.equal(imported.status, 201, JSON.stringify(imported.body))
  const copy = imported.body.fixedParams
  assert.equal(copy.find((f: any) => f.name === 'Notion-Version').value, '2022-06-28')
  assert.deepEqual(copy.find((f: any) => f.name === 'X-App-Key'), { in: 'header', name: 'X-App-Key', secret: true, hasValue: false })
})

test('editing keeps a stored secret unless a new value is given; the list can be cleared', async () => {
  const { app, tool } = await appWithFixed()
  const keep = await setFixed(alice, app.id, [{ in: 'header', name: 'X-App-Key', secret: true }])
  assert.equal(keep.status, 200)
  await exec(app.id, tool.id)
  assert.equal(fx.upstreamHits.at(-1)!.headers['x-app-key'], SECRET)
  assert.equal(new URL(fx.upstreamHits.at(-1)!.url, 'http://x').searchParams.get('api-version'), null, 'removed param still sent')

  await setFixed(alice, app.id, [{ in: 'header', name: 'X-App-Key', secret: true, value: 'rotated-value-12345' }])
  await exec(app.id, tool.id)
  assert.equal(fx.upstreamHits.at(-1)!.headers['x-app-key'], 'rotated-value-12345')

  assert.equal((await setFixed(alice, app.id, [])).body.fixedParams.length, 0)
  await exec(app.id, tool.id)
  assert.equal(fx.upstreamHits.at(-1)!.headers['x-app-key'], undefined)
  assert.equal((await setFixed(bob, app.id, [])).status, 404)
})

test('names and values are validated against transport headers and the app credential', async () => {
  const app = await createApp(alice, fx, { apiKeyHeader: 'X-Api-Key' })
  const bad: unknown[][] = [
    [{ in: 'header', name: 'Host', value: 'x' }],
    [{ in: 'header', name: 'Authorization', value: 'x' }],
    [{ in: 'header', name: 'x-api-key', value: 'x' }],
    [{ in: 'header', name: 'Bad Name', value: 'x' }],
    [{ in: 'header', name: 'X-Ok', value: 'a\r\nInjected: 1' }],
    [{ in: 'query', name: 'bad name', value: 'x' }],
    [{ in: 'header', name: 'X-Dup', value: 'a' }, { in: 'header', name: 'x-dup', value: 'b' }],
    [{ in: 'header', name: 'X-Empty', value: '' }],
    [{ in: 'header', name: 'X-New-Secret', secret: true }],
    Array.from({ length: 21 }, (_, i) => ({ in: 'query', name: `p${i}`, value: 'v' })),
  ]
  for (const params of bad) {
    const res = await setFixed(alice, app.id, params)
    assert.equal(res.status, 400, `accepted ${JSON.stringify(params).slice(0, 80)}`)
  }

  assert.equal((await setFixed(alice, app.id, [{ in: 'header', name: 'X-Tenant', value: 't1' }])).status, 200)
  // Moving the credential onto an existing fixed header must be refused.
  assert.equal((await alice.patch(`/api/apps/${app.id}`, { apiKeyHeader: 'X-Tenant' })).status, 400)
  assert.equal((await alice.patch(`/api/apps/${app.id}`, { apiKeyIn: 'query', apiKeyHeader: 'tenant' })).status, 200)
  assert.equal((await setFixed(alice, app.id, [{ in: 'query', name: 'tenant', value: 'x' }])).status, 400)
})

test('key rotation re-encrypts secret fixed values', async () => {
  const { app, tool } = await appWithFixed()
  const { rotateEncryptionKey } = await import('../src/security/rotateKey.js')
  const { initEncryptionKey } = await import('../src/security/secrets.js')
  const { getConfig } = await import('../src/config.js')
  const newKey = randomBytes(32).toString('base64')
  const result = await rotateEncryptionKey(getConfig().encryptionKey!, newKey)
  assert.ok(result.secrets >= 1)
  getConfig().encryptionKey = newKey
  initEncryptionKey()
  assert.equal((await exec(app.id, tool.id)).body.statusCode, 200)
  assert.equal(fx.upstreamHits.at(-1)!.headers['x-app-key'], SECRET)
})
