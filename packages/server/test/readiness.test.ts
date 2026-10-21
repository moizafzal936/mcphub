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

const readiness = (appId: string) => alice.get(`/api/apps/${appId}/readiness`).then(r => r.body)
const issue = (r: any, id: string) => r.issues.find((i: any) => i.id === id)

test('well-described tools score 100 and only get the informational note about writes', async () => {
  const app = await createApp(alice, fx)
  await addTool(alice, app.id, {
    name: 'search_items', description: 'Search the item catalogue by keyword; returns id, title and price for each match.', path: '/echo',
    queryParams: [{ name: 'q', description: 'Keywords, e.g. "red shoes"', required: true }],
  })
  await addTool(alice, app.id, {
    name: 'create_item', method: 'POST', description: 'Create a catalogue item and return it with its new id.', path: '/items/new',
    queryParams: [{ name: 'title', in: 'body', description: 'Item title shown to customers' }],
  })
  const r = await readiness(app.id)
  assert.equal(r.score, 100)
  assert.equal(r.grade, 'great')
  assert.equal(r.exposed, 2)
  assert.deepEqual(r.issues.map((i: any) => [i.id, i.severity]), [['writes-enabled', 'info']])
})

test('generated, duplicate and missing descriptions are flagged with the tools to fix', async () => {
  const app = await createApp(alice, fx)
  const curl = await alice.post(`/api/apps/${app.id}/tools/from-curl`, { curl: `curl 'http://127.0.0.1:${fx.upstreamPort}/v1/echo?q=hello'` })
  assert.equal(curl.status, 201)
  const same = 'Returns the current status of the order pipeline.'
  await addTool(alice, app.id, { name: 'status_a', description: same, path: '/echo' })
  await addTool(alice, app.id, { name: 'status_b', description: same, path: '/echo' })
  await addTool(alice, app.id, { name: 'get_item', description: 'One item by its id, with title and price.', path: '/items/{id}' })

  const r = await readiness(app.id)
  assert.deepEqual(issue(r, 'weak-descriptions').tools, ['get_echo'])
  assert.deepEqual(issue(r, 'duplicate-descriptions').tools.sort(), ['status_a', 'status_b'])
  // The path parameter created for {id} is described only by its own name.
  assert.deepEqual(issue(r, 'undocumented-params').tools, ['get_item'])
  assert.ok(r.score < 100 && r.score > 0)

  const generated = await createApp(alice, fx)
  for (const path of ['echo', 'items/1']) {
    await alice.post(`/api/apps/${generated.id}/tools/from-curl`, { curl: `curl 'http://127.0.0.1:${fx.upstreamPort}/v1/${path}'` })
  }
  const bare = await readiness(generated.id)
  assert.equal(bare.grade, 'needs-work', 'an app with only generated descriptions was graded as fine')
  assert.equal(issue(bare, 'weak-descriptions').severity, 'high')
  assert.equal(issue(r, 'writes-enabled'), undefined)
})

test('fixing descriptions in place raises the score, and parameter edits are validated', async () => {
  const app = await createApp(alice, fx)
  const tool = await addTool(alice, app.id, {
    name: 'make_note', method: 'POST', description: 'POST /notes', path: '/notes/{folder}',
    queryParams: [{ name: 'text', in: 'body' }, { name: 'tag', in: 'query' }],
  })
  const before = await readiness(app.id)
  assert.ok(issue(before, 'weak-descriptions'))
  assert.ok(issue(before, 'undocumented-params'))

  assert.equal((await alice.patch(`/api/apps/${app.id}/tools/${tool.id}`, { parameterDescriptions: { nope: 'x' } })).status, 400)
  assert.equal((await bob.patch(`/api/apps/${app.id}/tools/${tool.id}`, { parameterDescriptions: { text: 'x' } })).status, 404)

  const fixed = await alice.patch(`/api/apps/${app.id}/tools/${tool.id}`, {
    description: 'Create a note in a folder and return the saved note with its id.',
    parameterDescriptions: { folder: 'Folder name, e.g. "inbox"', text: 'Note body in plain text', tag: 'Optional label, e.g. "urgent"' },
  })
  assert.equal(fixed.status, 200)
  const after = await readiness(app.id)
  assert.equal(after.score, 100)
  assert.equal(issue(after, 'undocumented-params'), undefined)

  const [stored] = (await alice.get(`/api/apps/${app.id}/tools`)).body
  assert.equal(stored.parameters.find((p: any) => p.name === 'folder').description, 'Folder name, e.g. "inbox"')
  assert.equal(stored.requestBodySchema.properties.text.description, 'Note body in plain text')
  assert.equal(stored.requestBodySchema.properties.text.type, 'string')
})

test('readiness judges what AI clients actually see: read-only filtering and hidden query keys', async () => {
  const writesOnly = await createApp(alice, fx)
  await addTool(alice, writesOnly.id, { name: 'delete_all', method: 'DELETE', description: 'Delete every record in the account permanently.', path: '/echo' })
  await alice.patch(`/api/apps/${writesOnly.id}`, { readOnly: true })
  const hidden = await readiness(writesOnly.id)
  assert.equal(hidden.exposed, 0)
  assert.equal(hidden.score, 0)
  assert.equal(hidden.issues[0].id, 'no-tools')

  const queryKey = await createApp(alice, fx, { apiKeyIn: 'query', apiKeyHeader: 'api_key' })
  await addTool(alice, queryKey.id, {
    name: 'lookup', description: 'Look up a record by keyword and return its details.', path: '/echo',
    queryParams: [{ name: 'api_key' }, { name: 'q', description: 'Keyword to look up' }],
  })
  const r = await readiness(queryKey.id)
  assert.equal(issue(r, 'undocumented-params'), undefined, 'the hidden credential parameter was counted')
  assert.equal(r.score, 100)
  assert.equal((await bob.get(`/api/apps/${queryKey.id}/readiness`)).status, 404)
})

test('long tool lists are flagged', async () => {
  const { assessReadiness } = await import('../src/ingestion/readiness.js')
  const app = { id: 'a', ownerId: 'u', name: 'A', baseUrl: 'https://x.test', apiKeyHeader: 'Authorization', apiKeyIn: 'header' as const, hasApiKey: false, rateLimitPerMin: null, readOnly: false, createdAt: 0, updatedAt: 0 }
  const tool = (i: number) => ({ id: `t${i}`, appId: 'a', name: `tool_${i}`, description: `Fetch report number ${i} with all of its line items.`, method: 'GET' as const, path: `/r/${i}`, parameters: [], enabled: true })
  const many = assessReadiness(app, Array.from({ length: 45 }, (_, i) => tool(i)))
  assert.equal(many.issues[0].id, 'many-tools')
  assert.equal(many.issues[0].severity, 'medium')
  assert.equal(many.score, 90)
  const tooMany = assessReadiness(app, Array.from({ length: 120 }, (_, i) => tool(i)))
  assert.equal(tooMany.issues[0].severity, 'high')
})
