import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFixtures, startServer, registerUser, createApp, addTool, Client, type Fixtures, type TestServer } from './helpers.js'

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

const importConfig = (c: Client, config: unknown) =>
  c.req('POST', '/api/apps/import-config', typeof config === 'string' ? config : JSON.stringify(config), { 'content-type': 'text/plain' })

function minimalConfig(extra: Record<string, unknown> = {}, tools: unknown[] = []) {
  return {
    format: 'mcphub.app', version: 1,
    app: { name: 'Imported', baseUrl: `http://127.0.0.1:${fx.upstreamPort}/v1`, apiKeyHeader: 'Authorization', ...extra },
    tools,
  }
}

test('export carries the app and tools but never the key, ids or owner', async () => {
  const app = await createApp(alice, fx, { apiKey: 'sk-export-secret-987654', rateLimitPerMin: 30 })
  await addTool(alice, app.id, { name: 'echo', path: '/echo', queryParams: [{ name: 'q', description: 'query', required: true }] })
  await addTool(alice, app.id, { name: 'make_item', method: 'POST', path: '/items/{id}', queryParams: [{ name: 'title', in: 'body', required: true }] })
  await alice.patch(`/api/apps/${app.id}`, { readOnly: true })

  const res = await alice.get(`/api/apps/${app.id}/export`)
  assert.equal(res.status, 200)
  const text = JSON.stringify(res.body)
  assert.ok(!text.includes('sk-export-secret-987654'), 'credential exported')
  assert.ok(!text.includes(app.id), 'app id exported')
  assert.ok(!/"(id|appId|ownerId|hasApiKey)":/.test(text), 'internal fields exported')
  assert.equal(res.body.format, 'mcphub.app')
  assert.deepEqual(res.body.app, { name: 'Fixture API', baseUrl: `http://127.0.0.1:${fx.upstreamPort}/v1`, apiKeyHeader: 'Authorization', rateLimitPerMin: 30, readOnly: true })
  assert.deepEqual(res.body.tools.map((t: any) => t.name).sort(), ['echo', 'make_item'])

  assert.equal((await bob.get(`/api/apps/${app.id}/export`)).status, 404)
})

test('an exported config imports as a new working app owned by the importer', async () => {
  const source = await createApp(alice, fx, { apiKey: 'sk-source-key-123456' })
  await addTool(alice, source.id, { name: 'echo', path: '/echo', queryParams: [{ name: 'q', required: true }] })
  const item = await addTool(alice, source.id, { name: 'get_item', path: '/items/{id}' })
  await alice.patch(`/api/apps/${source.id}/tools/${item.id}`, { enabled: false })
  const exported = (await alice.get(`/api/apps/${source.id}/export`)).body

  const res = await importConfig(bob, exported)
  assert.equal(res.status, 201, JSON.stringify(res.body))
  assert.notEqual(res.body.id, source.id)
  assert.equal(res.body.hasApiKey, false)
  assert.equal(res.body.toolCount, 2)
  assert.deepEqual(res.body.skipped, [])
  assert.equal((await alice.get(`/api/apps/${res.body.id}`)).status, 404)

  const tools = (await bob.get(`/api/apps/${res.body.id}/tools`)).body
  const echo = tools.find((t: any) => t.name === 'echo')
  assert.equal(tools.find((t: any) => t.name === 'get_item').enabled, false)
  const run = await bob.post(`/api/apps/${res.body.id}/tools/${echo.id}/execute`, { q: 'hi' })
  assert.equal(run.body.statusCode, 200)
  assert.equal(run.body.data.query.q, 'hi')
  assert.equal(fx.upstreamHits.at(-1)!.headers.authorization, undefined, 'imported app sent a credential')
})

test('imports apply the same destination checks as creating an app', async () => {
  const internal = await importConfig(alice, minimalConfig({ baseUrl: `http://127.0.0.1:${fx.internalPort}/` }))
  assert.equal(internal.status, 422)
  const spec = await importConfig(alice, minimalConfig({ specUrl: 'file:///etc/passwd' }))
  assert.equal(spec.status, 422)
  const scheme = await importConfig(alice, minimalConfig({ baseUrl: 'ftp://example.com' }))
  assert.equal(scheme.status, 422)
  assert.equal(fx.internalHits.length, 0)
})

test('imported tools are re-validated: bad paths and names are refused, reserved headers dropped', async () => {
  const before = (await alice.get('/api/apps')).body.length
  const escape = await importConfig(alice, minimalConfig({}, [{ name: 'x', method: 'GET', path: '//evil.example/x' }]))
  assert.equal(escape.status, 422)
  const dupes = await importConfig(alice, minimalConfig({}, [{ name: 'a', method: 'GET', path: '/echo' }, { name: 'a', method: 'GET', path: '/echo' }]))
  assert.equal(dupes.status, 422)
  const badName = await importConfig(alice, minimalConfig({}, [{ name: 'bad name!', method: 'GET', path: '/echo' }]))
  assert.equal(badName.status, 422)
  const badHeader = await importConfig(alice, minimalConfig({ apiKeyHeader: 'Host' }))
  assert.equal(badHeader.status, 422)
  assert.equal((await alice.get('/api/apps')).body.length, before, 'a refused import created an app')

  const res = await importConfig(alice, minimalConfig({}, [{
    name: 'echo', method: 'GET', path: '/items/{id}',
    parameters: [
      { name: 'Authorization', in: 'header', schema: { type: 'string' } },
      { name: 'Host', in: 'header', schema: { type: 'string' } },
      { name: 'q', in: 'query', schema: { type: 'string' } },
    ],
  }]))
  assert.equal(res.status, 201)
  assert.deepEqual(res.body.skipped, ['echo: parameter "Authorization"', 'echo: parameter "Host"'])
  const [tool] = (await alice.get(`/api/apps/${res.body.id}/tools`)).body
  assert.deepEqual(tool.parameters.map((p: any) => `${p.in}:${p.name}`).sort(), ['path:id', 'query:q'])
})

test('malformed or foreign files are rejected with a readable reason', async () => {
  const notJson = await importConfig(alice, '{not json')
  assert.equal(notJson.status, 422)
  assert.match(notJson.body.error, /not valid JSON/)
  const openapi = await importConfig(alice, { openapi: '3.0.0', paths: {} })
  assert.equal(openapi.status, 422)
  assert.match(openapi.body.error, /Not an MCPHub app config/)
  const future = await importConfig(alice, { ...minimalConfig(), version: 2 })
  assert.equal(future.status, 422)
  assert.match(future.body.error, /version/)
})
