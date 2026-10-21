import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFixtures, startServer, registerUser, createApp, addTool, type Fixtures, type TestServer, type Client } from './helpers.js'

let fx: Fixtures
let srv: TestServer
let user: Client

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx)
  user = await registerUser(srv.base)
})
after(async () => {
  await srv.close()
  await fx.close()
})

test('manual tools can declare typed JSON body parameters', async () => {
  const app = await createApp(user, fx)
  const tool = await addTool(user, app.id, {
    name: 'create_post', method: 'POST', path: '/echo',
    queryParams: [
      { name: 'title', in: 'body', type: 'string', required: true, description: 'Post title' },
      { name: 'userId', in: 'body', type: 'integer', required: true },
      { name: 'draft', in: 'body', type: 'boolean' },
      { name: 'notify', in: 'query', type: 'boolean' },
    ],
  }) as any
  assert.deepEqual(tool.requestBodySchema.required, ['title', 'userId'])

  // Dashboard sends strings; they are coerced to the declared types before the upstream call.
  const res = await user.post(`/api/apps/${app.id}/tools/${tool.id}/execute`, { title: 'Hello', userId: '7', draft: 'false', notify: 'true' })
  assert.equal(res.body.statusCode, 200)
  const hit = fx.upstreamHits.at(-1)!
  assert.equal(hit.method, 'POST')
  assert.deepEqual(JSON.parse(hit.body), { title: 'Hello', userId: 7, draft: false })
  assert.equal(new URL(hit.url, 'http://x').searchParams.get('notify'), 'true')

  const missing = await user.post(`/api/apps/${app.id}/tools/${tool.id}/execute`, { userId: 1 })
  assert.equal(missing.body.statusCode, 0)
  assert.match(missing.body.error, /title/)
})

test('body parameters are rejected on GET tools and duplicate names are rejected', async () => {
  const app = await createApp(user, fx)
  const get = await user.post(`/api/apps/${app.id}/tools`, { name: 'g', method: 'GET', path: '/echo', queryParams: [{ name: 'x', in: 'body' }] })
  assert.equal(get.status, 400)
  const dup = await user.post(`/api/apps/${app.id}/tools`, {
    name: 'd', method: 'POST', path: '/items/{id}', queryParams: [{ name: 'id', in: 'body' }],
  })
  assert.equal(dup.status, 400)
})

test('tools can be created from a pasted curl command', async () => {
  const app = await createApp(user, fx, { apiKey: 'sk-curl-app-123456' })
  const base = `http://127.0.0.1:${fx.upstreamPort}/v1`
  const curl = `curl -X POST '${base}/items/123?notify=true&limit=5' \\
    -H "Authorization: Bearer sk_live_PASTED_FROM_DOCS" \\
    -H 'Content-Type: application/json' \\
    -H 'X-Request-Source: docs' \\
    -d '{"title": "Hello", "count": 2, "draft": false, "tags": ["a"]}'`
  const res = await user.post(`/api/apps/${app.id}/tools/from-curl`, { curl })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const tool = res.body.tool
  assert.equal(tool.method, 'POST')
  assert.equal(tool.path, '/items/{item_id}')
  assert.deepEqual(tool.parameters.map((p: any) => [p.name, p.in, p.schema.type]), [
    ['item_id', 'path', 'string'], ['notify', 'query', 'string'], ['limit', 'query', 'integer'], ['X-Request-Source', 'header', 'string'],
  ])
  assert.deepEqual(res.body.skippedHeaders, ['Authorization'])
  assert.deepEqual(Object.fromEntries(Object.entries(tool.requestBodySchema.properties).map(([k, v]: any) => [k, v.type])),
    { title: 'string', count: 'integer', draft: 'boolean', tags: 'array' })
  assert.ok(!JSON.stringify(res.body).includes('sk_live_PASTED_FROM_DOCS'), 'pasted credential stored in the tool')

  const run = await user.post(`/api/apps/${app.id}/tools/${tool.id}/execute`, {
    item_id: '9', notify: 'false', limit: 3, title: 'Hi', count: 1, draft: true, tags: ['x'],
  })
  assert.equal(run.body.statusCode, 200)
  assert.equal(run.body.data.id, '9')
  const hit = fx.upstreamHits.at(-1)!
  assert.equal(hit.method, 'POST')
  assert.equal(hit.url, '/v1/items/9?notify=false&limit=3')
  assert.equal(hit.headers.authorization, 'Bearer sk-curl-app-123456')
  assert.deepEqual(JSON.parse(hit.body), { title: 'Hi', count: 1, draft: true, tags: ['x'] })
})

test('curl commands for other hosts or outside the base path are rejected', async () => {
  const app = await createApp(user, fx)
  for (const curl of [
    'curl https://evil.example/v1/items',
    `curl http://127.0.0.1:${fx.upstreamPort}/admin/items`,
    'wget https://example.com',
    `curl -X POST http://127.0.0.1:${fx.upstreamPort}/v1/echo -d 'a=1&b=2'`,
  ]) {
    const res = await user.post(`/api/apps/${app.id}/tools/from-curl`, { curl })
    assert.equal(res.status, 400, `${curl} -> ${res.status}`)
  }
})

test('OpenAPI specs can be imported from pasted text (for specs on private hosts)', async () => {
  const app = await createApp(user, fx)
  const yaml = [
    'openapi: 3.0.0',
    'info: { title: Internal, version: "1" }',
    'paths:',
    '  /items/{id}:',
    '    get:',
    '      operationId: getItem',
    '      description: "' + 'x'.repeat(20_000) + '"',
    '      parameters:',
    '        - { name: id, in: path, required: true, schema: { type: string } }',
  ].join('\n')
  const res = await user.req('POST', `/api/apps/${app.id}/import-spec`, yaml, { 'content-type': 'text/plain' })
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200))
  assert.equal(res.body.imported, 1)
  const run = await user.post(`/api/apps/${app.id}/tools/${res.body.tools[0].id}/execute`, { id: 'from-text' })
  assert.equal(run.body.data.id, 'from-text')

  const bad = await user.req('POST', `/api/apps/${app.id}/import-spec`, 'not: [valid', { 'content-type': 'text/plain' })
  assert.equal(bad.status, 422)
  const empty = await user.req('POST', `/api/apps/${app.id}/import-spec`, 'openapi: 3.0.0\npaths: {}', { 'content-type': 'text/plain' })
  assert.equal(empty.status, 422)
})

test('Postman collections are detected and imported through the same endpoint', async () => {
  const app = await createApp(user, fx)
  const collection = {
    info: { _postman_id: 'abc', name: 'Fixture', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: 'Items',
        item: [
          {
            name: 'Get item',
            request: {
              method: 'GET',
              url: { raw: '{{baseUrl}}/v1/items/:id?verbose=1&skip=0', host: ['{{baseUrl}}'], path: ['v1', 'items', ':id'],
                query: [{ key: 'verbose', value: '1' }, { key: 'skip', value: '0', disabled: true }] },
            },
          },
        ],
      },
      {
        name: 'Create echo',
        request: {
          method: 'POST',
          header: [{ key: 'Authorization', value: 'Bearer {{token}}' }, { key: 'X-Team', value: 'core' }],
          url: '{{baseUrl}}/v1/echo',
          body: { mode: 'raw', raw: '{"title": "hi", "count": {{count}}, "owner": "{{owner}}"}' },
        },
      },
      { name: 'Upload file', request: { method: 'POST', url: '{{baseUrl}}/v1/upload', body: { mode: 'formdata', formdata: [] } } },
    ],
  }
  const res = await user.req('POST', `/api/apps/${app.id}/import-spec`, JSON.stringify(collection), { 'content-type': 'text/plain' })
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300))
  assert.equal(res.body.format, 'postman')
  assert.deepEqual(res.body.skipped, ['Upload file (formdata body)'])
  const byName = Object.fromEntries(res.body.tools.map((t: any) => [t.name, t]))
  assert.equal(byName.get_item.path, '/items/{id}')
  assert.deepEqual(byName.get_item.parameters.map((p: any) => [p.name, p.in, p.schema.type]), [['id', 'path', 'string'], ['verbose', 'query', 'integer']])
  assert.deepEqual(byName.create_echo.parameters.map((p: any) => p.name), ['X-Team'])
  assert.deepEqual(Object.keys(byName.create_echo.requestBodySchema.properties), ['title', 'count', 'owner'])

  const run = await user.post(`/api/apps/${app.id}/tools/${byName.get_item.id}/execute`, { id: 'pm-1', verbose: 2 })
  assert.equal(run.body.data.id, 'pm-1')
  assert.equal(fx.upstreamHits.at(-1)!.url, '/v1/items/pm-1?verbose=2')
})

test('dashboard executions report the exact request sent, without the credential', async () => {
  const app = await createApp(user, fx, { apiKey: 'sk-never-shown-123456' })
  const tool = await addTool(user, app.id, { name: 'item', path: '/items/{id}', queryParams: [{ name: 'verbose', type: 'boolean' }] })
  const res = await user.post(`/api/apps/${app.id}/tools/${tool.id}/execute`, { id: 'a b', verbose: 'true' })
  assert.deepEqual(res.body.request, { method: 'GET', url: `http://127.0.0.1:${fx.upstreamPort}/v1/items/a%20b?verbose=true` })
  assert.ok(!JSON.stringify(res.body).includes('sk-never-shown'))
})
