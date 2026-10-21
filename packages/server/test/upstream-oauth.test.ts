import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  startFixtures, startServer, registerUser, addTool, Client, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET,
  type Fixtures, type TestServer,
} from './helpers.js'

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

const tokenUrl = (path = '/oauth/token') => `http://127.0.0.1:${fx.upstreamPort}${path}`

async function oauthApp(oauth: Record<string, unknown> = {}, secret: string | null = OAUTH_CLIENT_SECRET) {
  const res = await alice.post('/api/apps', {
    name: 'OAuth API', baseUrl: `http://127.0.0.1:${fx.upstreamPort}/v1`,
    authType: 'oauth2_client_credentials',
    oauth: { tokenUrl: tokenUrl(), clientId: OAUTH_CLIENT_ID, ...oauth },
    ...(secret ? { apiKey: secret } : {}),
  })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const tool = await addTool(alice, res.body.id, { name: 'protected', path: '/protected' })
  return { app: res.body, tool }
}

const exec = (appId: string, toolId: string) => alice.post(`/api/apps/${appId}/tools/${toolId}/execute`, {})
const leaks = (value: unknown) => {
  const text = JSON.stringify(value)
  return text.includes(OAUTH_CLIENT_SECRET) || text.includes(encodeURIComponent(OAUTH_CLIENT_SECRET)) || /fixture-access-token-\d+/.test(text)
}

test('a token is fetched once, sent as Bearer, reused, and never exposed', async () => {
  const { app, tool } = await oauthApp({ scope: 'read:items' })
  assert.equal(app.authType, 'oauth2_client_credentials')
  assert.deepEqual(app.oauth, { tokenUrl: tokenUrl(), clientId: OAUTH_CLIENT_ID, scope: 'read:items', clientAuth: 'basic' })
  assert.equal(app.hasApiKey, true)
  assert.ok(!leaks(app))

  const before = fx.tokenHits.length
  const results = [await exec(app.id, tool.id), await exec(app.id, tool.id), await exec(app.id, tool.id)]
  assert.deepEqual(results.map(r => r.body.statusCode), [200, 200, 200])
  assert.equal(fx.tokenHits.length - before, 1, 'token was not cached')

  const tokenRequest = fx.tokenHits.at(-1)!
  assert.match(String(tokenRequest.headers.authorization), /^Basic /)
  assert.equal(new URLSearchParams(tokenRequest.body).get('scope'), 'read:items')
  assert.equal(new URLSearchParams(tokenRequest.body).get('client_secret'), null, 'secret sent in the body in basic mode')
  assert.match(String(fx.upstreamHits.at(-1)!.headers.authorization), /^Bearer fixture-access-token-\d+$/)

  // The fixture echoes the token back; it must be redacted everywhere we return or store it.
  assert.equal(results[0].body.data.token, '[REDACTED]')
  assert.ok(!leaks(results), 'secret or token returned to the dashboard')
  assert.ok(!leaks((await alice.get(`/api/apps/${app.id}/logs`)).body), 'secret or token stored in logs')
  assert.ok(!leaks((await alice.get(`/api/apps/${app.id}/export`)).body), 'secret or token exported')
})

test('client_secret_post sends the credentials in the form body', async () => {
  const { app, tool } = await oauthApp({ clientAuth: 'post' })
  assert.equal((await exec(app.id, tool.id)).body.statusCode, 200)
  const form = new URLSearchParams(fx.tokenHits.at(-1)!.body)
  assert.equal(form.get('client_id'), OAUTH_CLIENT_ID)
  assert.equal(form.get('client_secret'), OAUTH_CLIENT_SECRET)
  assert.equal(fx.tokenHits.at(-1)!.headers.authorization, undefined)
})

test('a revoked token is replaced once; short-lived tokens are refreshed before use', async () => {
  const { app, tool } = await oauthApp()
  assert.equal((await exec(app.id, tool.id)).body.statusCode, 200)
  fx.revokeTokens()
  const hits = fx.tokenHits.length
  const retried = await exec(app.id, tool.id)
  assert.equal(retried.body.statusCode, 200, 'expired token was not replaced')
  assert.equal(fx.tokenHits.length - hits, 1)

  const short = await oauthApp({ tokenUrl: tokenUrl('/oauth/token-short') })
  const before = fx.tokenHits.length
  await exec(short.app.id, short.tool.id)
  await exec(short.app.id, short.tool.id)
  assert.equal(fx.tokenHits.length - before, 2, 'a token about to expire was reused')
})

test('token endpoint failures are reported without leaking the secret', async () => {
  const { app, tool } = await oauthApp({}, 'wrong-secret-value-123')
  const hits = fx.upstreamHits.length
  const res = await exec(app.id, tool.id)
  assert.equal(res.body.statusCode, 0)
  assert.match(res.body.error, /Could not get an access token: Token endpoint returned HTTP 401 \(invalid_client: Client authentication failed\)/)
  assert.ok(!JSON.stringify(res.body).includes('wrong-secret-value-123'))
  assert.equal(fx.upstreamHits.length, hits, 'called the API without a token')

  const mac = await oauthApp({ tokenUrl: tokenUrl('/oauth/token-mac') })
  assert.match((await exec(mac.app.id, mac.tool.id)).body.error, /only Bearer tokens/)

  const noSecret = await oauthApp({}, null)
  assert.match((await exec(noSecret.app.id, noSecret.tool.id)).body.error, /No OAuth client secret/)
})

test('the token URL must be public and settings are validated', async () => {
  const base = { name: 'x', baseUrl: `http://127.0.0.1:${fx.upstreamPort}/v1`, authType: 'oauth2_client_credentials' }
  const internal = await alice.post('/api/apps', { ...base, oauth: { tokenUrl: `http://127.0.0.1:${fx.internalPort}/token`, clientId: 'c' } })
  assert.equal(internal.status, 400)
  assert.equal((await alice.post('/api/apps', { ...base, oauth: { tokenUrl: 'file:///etc/passwd', clientId: 'c' } })).status, 400)
  assert.equal((await alice.post('/api/apps', base)).status, 400, 'OAuth without a token URL was accepted')
  assert.equal((await alice.post('/api/apps', { ...base, oauth: { tokenUrl: tokenUrl(), clientId: '' } })).status, 400)
  assert.equal(fx.internalHits.length, 0)
})

test('switching methods, testing the setup, ownership and config export', async () => {
  const { app, tool } = await oauthApp()
  const check = await alice.post(`/api/apps/${app.id}/auth/test`)
  assert.deepEqual(check.body, { ok: true, tokenType: 'Bearer', expiresIn: 3600 })
  assert.equal((await bob.post(`/api/apps/${app.id}/auth/test`)).status, 404)

  // A new secret takes effect immediately: the cached token is dropped.
  await alice.patch(`/api/apps/${app.id}`, { apiKey: 'rotated-but-wrong-123' })
  const failed = await alice.post(`/api/apps/${app.id}/auth/test`)
  assert.equal(failed.body.ok, false)
  assert.match((await exec(app.id, tool.id)).body.error, /invalid_client/)

  const toKey = await alice.patch(`/api/apps/${app.id}`, { authType: 'api_key' })
  assert.deepEqual([toKey.body.authType, toKey.body.oauth, toKey.body.apiKeyHeader], ['api_key', undefined, 'Authorization'])
  assert.equal((await alice.post(`/api/apps/${app.id}/auth/test`)).status, 400)

  const back = await alice.patch(`/api/apps/${app.id}`, {
    authType: 'oauth2_client_credentials', apiKey: OAUTH_CLIENT_SECRET,
    oauth: { tokenUrl: tokenUrl(), clientId: OAUTH_CLIENT_ID, audience: 'https://api.example.test' },
  })
  assert.equal(back.status, 200)
  assert.equal((await exec(app.id, tool.id)).body.statusCode, 200)
  assert.equal(new URLSearchParams(fx.tokenHits.at(-1)!.body).get('audience'), 'https://api.example.test')

  const config = (await alice.get(`/api/apps/${app.id}/export`)).body
  assert.equal(config.app.authType, 'oauth2_client_credentials')
  assert.equal(config.app.oauth.clientId, OAUTH_CLIENT_ID)
  const imported = await alice.req('POST', '/api/apps/import-config', JSON.stringify(config), { 'content-type': 'text/plain' })
  assert.equal(imported.status, 201)
  assert.deepEqual([imported.body.authType, imported.body.hasApiKey], ['oauth2_client_credentials', false])
  config.app.oauth.tokenUrl = `http://127.0.0.1:${fx.internalPort}/token`
  const bad = await alice.req('POST', '/api/apps/import-config', JSON.stringify(config), { 'content-type': 'text/plain' })
  assert.equal(bad.status, 422)
})
