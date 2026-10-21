import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFixtures, startServer, Client, registerUser, createApp, addTool, type Fixtures, type TestServer } from './helpers.js'

let fx: Fixtures
let srv: TestServer

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx, { MCPHUB_ALLOW_SIGNUP: 'false' })
})
after(async () => {
  await srv.close()
  await fx.close()
})

test('first user can bootstrap, then signup is closed unless MCPHUB_ALLOW_SIGNUP=true', async () => {
  const anon = new Client(srv.base)
  assert.deepEqual((await anon.get('/api/auth/status')).body, { signupOpen: true, bootstrap: true, needsSetup: false })
  const owner = await registerUser(srv.base, 'owner@example.test')
  assert.equal((await owner.get('/api/auth/me')).body.user.email, 'owner@example.test')
  assert.equal((await anon.get('/api/auth/status')).body.signupOpen, false)
  const second = await new Client(srv.base).post('/api/auth/register', { email: 'intruder@example.test', password: 'correct horse battery staple' })
  assert.equal(second.status, 403)
})

test('every dashboard API route rejects unauthenticated requests', async () => {
  const anon = new Client(srv.base)
  const routes: [string, string][] = [
    ['GET', '/api/stats'], ['GET', '/api/apps'], ['POST', '/api/apps'], ['GET', '/api/apps/x'],
    ['PATCH', '/api/apps/x'], ['DELETE', '/api/apps/x'], ['POST', '/api/apps/x/import'],
    ['GET', '/api/apps/x/tools'], ['POST', '/api/apps/x/tools'], ['PATCH', '/api/apps/x/tools/y'],
    ['DELETE', '/api/apps/x/tools/y'], ['POST', '/api/apps/x/tools/y/execute'], ['GET', '/api/apps/x/logs'],
    ['GET', '/api/apps/x/tokens'], ['POST', '/api/apps/x/tokens'], ['DELETE', '/api/apps/x/tokens/y'],
    ['GET', '/api/auth/me'],
  ]
  for (const [method, path] of routes) {
    const res = await anon.req(method, path, method === 'GET' || method === 'DELETE' ? undefined : {})
    assert.equal(res.status, 401, `${method} ${path} returned ${res.status}`)
  }
  const forged = await anon.req('GET', '/api/apps', undefined, { cookie: 'mcphub_session=forged-token' })
  assert.equal(forged.status, 401)
})

test('login: wrong password and unknown email get the same generic 401', async () => {
  const c = new Client(srv.base)
  const wrong = await c.post('/api/auth/login', { email: 'owner@example.test', password: 'not the password at all' })
  const unknown = await c.post('/api/auth/login', { email: 'nobody@example.test', password: 'not the password at all' })
  assert.equal(wrong.status, 401)
  assert.equal(unknown.status, 401)
  assert.equal(wrong.body.error, unknown.body.error)
  const ok = await c.post('/api/auth/login', { email: 'OWNER@example.test', password: 'correct horse battery staple' })
  assert.equal(ok.status, 200)
})

test('session cookie is HttpOnly + SameSite and logout invalidates it server-side', async () => {
  const c = new Client(srv.base)
  const res = await c.post('/api/auth/login', { email: 'owner@example.test', password: 'correct horse battery staple' })
  const setCookie = res.headers.get('set-cookie')!
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Lax/i)
  const stolen = c.cookie
  assert.equal((await c.post('/api/auth/logout')).status, 200)
  const replay = await new Client(srv.base).req('GET', '/api/apps', undefined, { cookie: stolen })
  assert.equal(replay.status, 401)
})

test('CSRF: cross-site browser requests are rejected, same-origin allowed', async () => {
  const c = new Client(srv.base)
  await c.post('/api/auth/login', { email: 'owner@example.test', password: 'correct horse battery staple' })
  const evilOrigin = await c.req('POST', '/api/apps', { name: 'x', baseUrl: 'https://example.com' }, { origin: 'https://evil.example' })
  assert.equal(evilOrigin.status, 403)
  const crossSite = await c.req('DELETE', '/api/apps/whatever', undefined, { 'sec-fetch-site': 'cross-site' })
  assert.equal(crossSite.status, 403)
  const sameOrigin = await c.req('GET', '/api/apps', undefined, { origin: srv.base, 'sec-fetch-site': 'same-origin' })
  assert.equal(sameOrigin.status, 200)
})

test("authorization: a user cannot see, modify, execute or mint tokens for another user's app", async () => {
  // Re-open signup so several tenants can register on this server.
  ;(await import('../src/config.js')).getConfig().allowSignup = true

  const alice = await registerUser(srv.base, 'alice@example.test')
  const bob = await registerUser(srv.base, 'bob@example.test')
  const app = await createApp(alice, fx)
  const tool = await addTool(alice, app.id, { name: 'echo', path: '/echo' })

  assert.equal((await bob.get('/api/apps')).body.length, 0, 'app list leaks across users')
  const attempts: [string, string, unknown?][] = [
    ['GET', `/api/apps/${app.id}`],
    ['PATCH', `/api/apps/${app.id}`, { name: 'pwned' }],
    ['POST', `/api/apps/${app.id}/import`, { specUrl: `http://127.0.0.1:${fx.upstreamPort}/openapi.json` }],
    ['GET', `/api/apps/${app.id}/tools`],
    ['POST', `/api/apps/${app.id}/tools`, { name: 'x', method: 'GET', path: '/x' }],
    ['PATCH', `/api/apps/${app.id}/tools/${tool.id}`, { enabled: false }],
    ['POST', `/api/apps/${app.id}/tools/${tool.id}/execute`, {}],
    ['GET', `/api/apps/${app.id}/logs`],
    ['GET', `/api/apps/${app.id}/tokens`],
    ['POST', `/api/apps/${app.id}/tokens`, {}],
    ['DELETE', `/api/apps/${app.id}/tools/${tool.id}`],
    ['DELETE', `/api/apps/${app.id}`],
  ]
  const hitsBefore = fx.upstreamHits.length
  for (const [method, path, body] of attempts) {
    const res = await bob.req(method, path, body)
    assert.equal(res.status, 404, `${method} ${path} returned ${res.status}`)
  }
  assert.equal(fx.upstreamHits.length, hitsBefore, 'cross-tenant execute reached upstream')
  const still = await alice.get(`/api/apps/${app.id}/tools`)
  assert.equal(still.body.length, 1)
  assert.equal(still.body[0].enabled, true)
})

test('tool IDOR: a tool id cannot be addressed through a different app, even one you own', async () => {
  const carol = await registerUser(srv.base, 'carol@example.test')
  const a = await createApp(carol, fx, { name: 'A' })
  const b = await createApp(carol, fx, { name: 'B' })
  const toolA = await addTool(carol, a.id, { name: 'echo', path: '/echo' })
  assert.equal((await carol.patch(`/api/apps/${b.id}/tools/${toolA.id}`, { enabled: false })).status, 404)
  assert.equal((await carol.post(`/api/apps/${b.id}/tools/${toolA.id}/execute`, {})).status, 404)
  assert.equal((await carol.del(`/api/apps/${b.id}/tools/${toolA.id}`)).status, 404)
  assert.equal((await carol.get(`/api/apps/${a.id}/tools`)).body[0].enabled, true)
})
