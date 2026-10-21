import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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

const exec = (appId: string, toolId: string, args: unknown = {}) => alice.post(`/api/apps/${appId}/tools/${toolId}/execute`, args)
const shape = (c: Client, appId: string, toolId: string, responseFields: unknown) => c.patch(`/api/apps/${appId}/tools/${toolId}`, { responseFields })

test('projection keeps the chosen paths, walks arrays and falls back when nothing matches', async () => {
  const { projectResponse, isValidFieldPath } = await import('../src/ingestion/toolSchema.js')
  const data = {
    numFound: 2, start: 0,
    docs: [
      { title: 'Dune', author: { name: 'Herbert', born: 1920 }, isbn: ['1', '2'] },
      { title: 'Emma', author: { name: 'Austen', born: 1775 }, isbn: [] },
    ],
  }
  assert.deepEqual(projectResponse(data, ['numFound', 'docs.title', 'docs.author.name']), {
    numFound: 2,
    docs: [{ title: 'Dune', author: { name: 'Herbert' } }, { title: 'Emma', author: { name: 'Austen' } }],
  })
  assert.deepEqual(projectResponse(data, ['docs.author']), { docs: [{ author: data.docs[0].author }, { author: data.docs[1].author }] })
  assert.deepEqual(projectResponse([{ id: 1, x: 2 }, { id: 2 }], ['id']), [{ id: 1 }, { id: 2 }])
  assert.equal(projectResponse(data, ['renamed.field']), data, 'an unmatched shape must return the full response')
  assert.equal(projectResponse('plain text', ['a']), 'plain text')
  for (const bad of ['', 'a..b', '__proto__', 'a.constructor', 'a b', 'x'.repeat(65)]) assert.equal(isValidFieldPath(bad), false, bad)
})

test('AI clients get the shaped response; the owner still sees the full one', async () => {
  const app = await createApp(alice, fx)
  const tool = await addTool(alice, app.id, { name: 'echo', path: '/echo', queryParams: [{ name: 'q', description: 'text' }] })
  assert.equal((await shape(alice, app.id, tool.id, ['query.q', 'method'])).status, 200)

  const res = await exec(app.id, tool.id, { q: 'hello' })
  assert.equal(res.body.shaped, true)
  assert.ok(res.body.data.headers, 'dashboard lost the full response')
  assert.deepEqual(JSON.parse(res.body.text), { method: 'GET', query: { q: 'hello' } })

  const { token } = (await alice.post(`/api/apps/${app.id}/tokens`, {})).body
  const mcp = new McpClient({ name: 'shaping-test', version: '1.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/${app.id}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  const called = await mcp.callTool({ name: 'echo', arguments: { q: 'via-mcp' } }) as { content: { text: string }[] }
  assert.deepEqual(JSON.parse(called.content[0].text), { method: 'GET', query: { q: 'via-mcp' } })
  await mcp.close()

  assert.equal((await shape(alice, app.id, tool.id, null)).status, 200)
  const full = await exec(app.id, tool.id, { q: 'x' })
  assert.equal(full.body.shaped, undefined)
  assert.ok(JSON.parse(full.body.text).headers)
})

test('error responses are never shaped, so the model sees why a call failed', async () => {
  const app = await createApp(alice, fx)
  const tool = await addTool(alice, app.id, { name: 'denied', path: '/unauthorized' })
  await shape(alice, app.id, tool.id, ['data.items'])
  const res = await exec(app.id, tool.id)
  assert.equal(res.body.statusCode, 401)
  assert.equal(res.body.shaped, undefined)
  assert.match(res.body.text, /invalid api key/)
})

test('shaping a long list fits far more useful items into the model budget', async () => {
  const app = await createApp(alice, fx)
  const tool = await addTool(alice, app.id, { name: 'many', path: '/many' })
  const shownCount = (text: string) => Number(text.match(/Showing (\d+) of 2000/)?.[1] ?? 2000)
  const before = shownCount((await exec(app.id, tool.id)).body.text)
  await shape(alice, app.id, tool.id, ['id', 'name'])
  const after = (await exec(app.id, tool.id)).body.text
  assert.ok(!after.includes('xxxxxxxx'), 'dropped field still sent')
  assert.ok(shownCount(after) > before * 2, `expected many more items (${before} -> ${shownCount(after)})`)
})

test('response fields are validated, owner-only, and survive export/import', async () => {
  const app = await createApp(alice, fx)
  const tool = await addTool(alice, app.id, { name: 'echo', path: '/echo' })
  assert.equal((await shape(alice, app.id, tool.id, ['a..b'])).status, 400)
  assert.equal((await shape(alice, app.id, tool.id, ['__proto__.x'])).status, 400)
  assert.equal((await shape(alice, app.id, tool.id, Array.from({ length: 101 }, (_, i) => `f${i}`))).status, 400)
  assert.equal((await shape(bob, app.id, tool.id, ['query'])).status, 404)
  await shape(alice, app.id, tool.id, ['query.q', 'query.q', 'method'])
  const [stored] = (await alice.get(`/api/apps/${app.id}/tools`)).body
  assert.deepEqual(stored.responseFields, ['query.q', 'method'])

  const config = (await alice.get(`/api/apps/${app.id}/export`)).body
  assert.deepEqual(config.tools[0].responseFields, ['query.q', 'method'])
  config.tools[0].responseFields.push('bad..path')
  const imported = await alice.req('POST', '/api/apps/import-config', JSON.stringify(config), { 'content-type': 'text/plain' })
  assert.equal(imported.status, 201)
  assert.deepEqual(imported.body.skipped, ['echo: response field "bad..path"'])
  const [copy] = (await alice.get(`/api/apps/${imported.body.id}/tools`)).body
  assert.deepEqual(copy.responseFields, ['query.q', 'method'])
})
