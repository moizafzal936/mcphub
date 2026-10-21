import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startFixtures, startServer, registerUser, createApp, addTool, Client, type Fixtures, type TestServer } from './helpers.js'

// Contains characters that are percent-encoded in a query string, to cover both forms in redaction.
const KEY = 'qk-SECRET+value/with=chars'
let fx: Fixtures
let srv: TestServer
let alice: Client

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx)
  alice = await registerUser(srv.base)
})
after(async () => {
  await srv.close()
  await fx.close()
})

const exec = (appId: string, toolId: string, args: unknown) => alice.post(`/api/apps/${appId}/tools/${toolId}/execute`, args)
const leaks = (value: unknown) => {
  const text = JSON.stringify(value)
  return text.includes(KEY) || text.includes(encodeURIComponent(KEY)) || text.includes(new URLSearchParams({ k: KEY }).toString().slice(2))
}

test('a query-parameter key is sent upstream but never shown to the model, the dashboard or the logs', async () => {
  const app = await createApp(alice, fx, { apiKey: KEY, apiKeyIn: 'query', apiKeyHeader: 'api_key' })
  assert.equal(app.apiKeyIn, 'query')
  assert.equal(app.apiKeyHeader, 'api_key')
  // Specs often declare the key as an ordinary query parameter; it must stay hidden.
  const tool = await addTool(alice, app.id, { name: 'echo', path: '/echo', queryParams: [{ name: 'q' }, { name: 'api_key' }] })

  const listed = (await alice.get(`/api/apps/${app.id}/tools`)).body
  assert.deepEqual(listed[0].parameters.map((p: any) => p.name), ['q'])

  const res = await exec(app.id, tool.id, { q: 'hi' })
  assert.equal(res.body.statusCode, 200)
  const hit = fx.upstreamHits.at(-1)!
  assert.equal(new URL(hit.url, 'http://x').searchParams.get('api_key'), KEY)
  assert.equal(new URL(hit.url, 'http://x').searchParams.get('q'), 'hi')
  assert.equal(hit.headers.authorization, undefined)
  assert.equal(res.body.data.query.api_key, '[REDACTED]')
  assert.match(res.body.request.url, /api_key=\[REDACTED\]/)
  assert.ok(!leaks(res.body), 'key returned to the dashboard')

  const hits = fx.upstreamHits.length
  const override = await exec(app.id, tool.id, { q: 'x', api_key: 'attacker-chosen' })
  assert.equal(override.body.statusCode, 0, 'caller could set the credential parameter')
  assert.equal(fx.upstreamHits.length, hits)

  assert.ok(!leaks((await alice.get(`/api/apps/${app.id}/logs`)).body), 'key stored in logs')

  const { token } = (await alice.post(`/api/apps/${app.id}/tokens`, {})).body
  const mcp = new McpClient({ name: 'querykey-test', version: '1.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/${app.id}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  const { tools } = await mcp.listTools()
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties ?? {}), ['q'])
  const called = await mcp.callTool({ name: 'echo', arguments: { q: 'from-mcp' } })
  assert.ok(!leaks(called), 'key returned to the MCP client')
  assert.equal(new URL(fx.upstreamHits.at(-1)!.url, 'http://x').searchParams.get('api_key'), KEY)
  await mcp.close()
})

test('the credential name is validated for where it is sent', async () => {
  assert.equal((await alice.post('/api/apps', { name: 'x', baseUrl: `http://127.0.0.1:${fx.upstreamPort}/v1`, apiKeyIn: 'query', apiKeyHeader: 'api key' })).status, 400)
  assert.equal((await alice.post('/api/apps', { name: 'x', baseUrl: `http://127.0.0.1:${fx.upstreamPort}/v1`, apiKeyHeader: 'Host' })).status, 400)

  const app = await createApp(alice, fx)
  assert.equal(app.apiKeyIn, 'header')
  assert.equal(app.apiKeyHeader, 'Authorization')
  const toQuery = await alice.patch(`/api/apps/${app.id}`, { apiKeyIn: 'query' })
  assert.equal(toQuery.status, 200)
  assert.equal(toQuery.body.apiKeyHeader, 'api_key')
  assert.equal((await alice.patch(`/api/apps/${app.id}`, { apiKeyHeader: 'bad name' })).status, 400)
  const renamed = await alice.patch(`/api/apps/${app.id}`, { apiKeyHeader: 'appid' })
  assert.equal(renamed.body.apiKeyHeader, 'appid')
  const back = await alice.patch(`/api/apps/${app.id}`, { apiKeyIn: 'header' })
  assert.deepEqual([back.body.apiKeyIn, back.body.apiKeyHeader], ['header', 'Authorization'])
})

test('curl and Postman imports never copy a key from the URL into a tool description', async () => {
  const headerApp = await createApp(alice, fx)
  const curl = `curl 'http://127.0.0.1:${fx.upstreamPort}/v1/echo?api_key=sk-curl-leak-123456&q=hello'`
  const fromCurl = await alice.post(`/api/apps/${headerApp.id}/tools/from-curl`, { curl })
  assert.equal(fromCurl.status, 201)
  assert.ok(!JSON.stringify(fromCurl.body).includes('sk-curl-leak-123456'))
  const byName = Object.fromEntries(fromCurl.body.tool.parameters.map((p: any) => [p.name, p.description]))
  assert.equal(byName.q, 'e.g. hello')
  assert.equal(byName.api_key, 'api_key')

  const queryApp = await createApp(alice, fx, { apiKeyIn: 'query', apiKeyHeader: 'api_key' })
  const dropped = await alice.post(`/api/apps/${queryApp.id}/tools/from-curl`, { curl })
  assert.deepEqual(dropped.body.tool.parameters.map((p: any) => p.name), ['q'])
  assert.deepEqual(dropped.body.skippedHeaders, ['?api_key'])

  const collection = {
    info: { _postman_id: 'test', name: 'c', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Echo', request: { method: 'GET', url: {
      raw: 'x', path: ['v1', 'echo'],
      query: [{ key: 'api_key', value: 'pm-leak-secret-999' }, { key: 'bad name', value: 'x' }, { key: 'q', value: 'hi' }],
    } } }],
  }
  const pm = await alice.req('POST', `/api/apps/${headerApp.id}/import-spec`, JSON.stringify(collection), { 'content-type': 'text/plain' })
  assert.equal(pm.status, 200)
  assert.ok(!JSON.stringify(pm.body).includes('pm-leak-secret-999'))
  assert.deepEqual(pm.body.tools[0].parameters.map((p: any) => p.name), ['api_key', 'q'])
})

test('exported configs keep the credential location', async () => {
  const app = await createApp(alice, fx, { apiKey: KEY, apiKeyIn: 'query', apiKeyHeader: 'appid' })
  const config = (await alice.get(`/api/apps/${app.id}/export`)).body
  assert.equal(config.app.apiKeyIn, 'query')
  assert.ok(!leaks(config))
  const imported = await alice.req('POST', '/api/apps/import-config', JSON.stringify(config), { 'content-type': 'text/plain' })
  assert.equal(imported.status, 201)
  assert.deepEqual([imported.body.apiKeyIn, imported.body.apiKeyHeader, imported.body.hasApiKey], ['query', 'appid', false])
})
