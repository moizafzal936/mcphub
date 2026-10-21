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
