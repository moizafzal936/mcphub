import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFixtures, startServer, registerUser, createApp, addTool, type Fixtures, type TestServer, type Client } from './helpers.js'

const SECRET = 'sk-test-SECRET-1234567890abcdef'
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

test('API responses never contain the stored credential', async () => {
  const created = await createApp(user, fx, { apiKey: SECRET })
  const responses = [
    created,
    (await user.get('/api/apps')).body,
    (await user.get(`/api/apps/${created.id}`)).body,
    (await user.patch(`/api/apps/${created.id}`, { name: 'renamed' })).body,
  ]
  for (const body of responses) {
    const text = JSON.stringify(body)
    assert.ok(!text.includes(SECRET), `secret leaked in ${text.slice(0, 200)}`)
    assert.ok(!/"apiKey"/.test(text), 'apiKey field present in response')
  }
  assert.equal(created.hasApiKey, true)
})

test('credential is stored as AES-GCM ciphertext and bound to its app (no row swapping)', async () => {
  const { getDb } = await import('../src/storage/db.js')
  const a = await createApp(user, fx, { apiKey: SECRET })
  const b = await createApp(user, fx, { apiKey: 'sk-other-key-abcdefghijklmnop' })
  const rows = await getDb().execute({ sql: 'SELECT id, api_key FROM apps WHERE id IN (?, ?)', args: [a.id, b.id] })
  for (const r of rows.rows) {
    assert.match(String(r.api_key), /^enc:v1:/)
    assert.ok(!String(r.api_key).includes(SECRET))
  }
  // Moving A's ciphertext onto B must not decrypt (AAD binds ciphertext to the app id).
  const aCipher = rows.rows.find(r => r.id === a.id)!.api_key
  await getDb().execute({ sql: 'UPDATE apps SET api_key = ? WHERE id = ?', args: [aCipher, b.id] })
  const tool = await addTool(user, b.id, { name: 'echo', path: '/echo' })
  const hits = fx.upstreamHits.length
  const res = await user.post(`/api/apps/${b.id}/tools/${tool.id}/execute`, {})
  assert.equal(res.body.statusCode, 0)
  assert.match(res.body.error, /could not be decrypted/)
  assert.equal(fx.upstreamHits.length, hits, 'request sent with a swapped credential')
})

test('legacy plaintext credentials are encrypted by the startup migration', async () => {
  const { getDb, migrate, appRepo } = await import('../src/storage/db.js')
  const app = await createApp(user, fx)
  await getDb().execute({ sql: 'UPDATE apps SET api_key = ? WHERE id = ?', args: ['legacy-plaintext-key-123', app.id] })
  const result = await migrate()
  assert.equal(result.encryptedLegacySecrets, 1)
  const row = await getDb().execute({ sql: 'SELECT api_key FROM apps WHERE id = ?', args: [app.id] })
  assert.match(String(row.rows[0].api_key), /^enc:v1:/)
  assert.equal(await appRepo.getApiKey(app.id), 'legacy-plaintext-key-123')
  assert.equal((await migrate()).encryptedLegacySecrets, 0, 'migration is not idempotent')
})

test('upstream receives the decrypted credential; it is scrubbed from tool output and logs', async () => {
  const app = await createApp(user, fx, { apiKey: SECRET })
  const tool = await addTool(user, app.id, { name: 'leak', path: '/leak' })
  const res = await user.post(`/api/apps/${app.id}/tools/${tool.id}/execute`, {})
  assert.equal(res.status, 200)
  assert.equal(fx.upstreamHits.at(-1)!.headers.authorization, `Bearer ${SECRET}`)
  assert.ok(!JSON.stringify(res.body).includes(SECRET), 'credential echoed back to the caller')
  const logs = await user.get(`/api/apps/${app.id}/logs`)
  assert.ok(!JSON.stringify(logs.body).includes(SECRET), 'credential stored in logs')
})

test('custom credential header is sent as-is', async () => {
  const app = await createApp(user, fx, { apiKey: 'xkey-abcdef123456', apiKeyHeader: 'X-API-Key' })
  const tool = await addTool(user, app.id, { name: 'echo', path: '/echo' })
  await user.post(`/api/apps/${app.id}/tools/${tool.id}/execute`, {})
  assert.equal(fx.upstreamHits.at(-1)!.headers['x-api-key'], 'xkey-abcdef123456')
  assert.equal(fx.upstreamHits.at(-1)!.headers.authorization, undefined)
})

test('reserved headers cannot be used as the credential header', async () => {
  for (const apiKeyHeader of ['Host', 'Cookie', 'Content-Length', 'X-Bad\r\nInjected']) {
    const res = await user.post('/api/apps', { name: 'x', baseUrl: `http://127.0.0.1:${fx.upstreamPort}/v1`, apiKey: 'k', apiKeyHeader })
    assert.equal(res.status, 400, `apiKeyHeader ${JSON.stringify(apiKeyHeader)} accepted`)
  }
})

test('credential can be rotated, re-targeted and removed without leaking it', async () => {
  const app = await createApp(user, fx, { apiKey: 'sk-old-key-1234567890' })
  const tool = await addTool(user, app.id, { name: 'echo', path: '/echo' })
  const run = () => user.post(`/api/apps/${app.id}/tools/${tool.id}/execute`, {})

  const rotated = await user.patch(`/api/apps/${app.id}`, { apiKey: 'sk-new-key-0987654321' })
  assert.equal(rotated.status, 200)
  assert.ok(!JSON.stringify(rotated.body).includes('sk-new-key'))
  await run()
  assert.equal(fx.upstreamHits.at(-1)!.headers.authorization, 'Bearer sk-new-key-0987654321')

  await user.patch(`/api/apps/${app.id}`, { apiKeyHeader: 'X-API-Key', rateLimitPerMin: 50 })
  await run()
  assert.equal(fx.upstreamHits.at(-1)!.headers['x-api-key'], 'sk-new-key-0987654321')

  const cleared = await user.patch(`/api/apps/${app.id}`, { apiKey: null })
  assert.equal(cleared.body.hasApiKey, false)
  await run()
  assert.equal(fx.upstreamHits.at(-1)!.headers['x-api-key'], undefined)

  for (const bad of [{ rateLimitPerMin: 0 }, { apiKeyHeader: 'Host' }, { name: '' }, { ownerId: 'someone-else' }]) {
    assert.equal((await user.patch(`/api/apps/${app.id}`, bad)).status, 400, JSON.stringify(bad))
  }
})
