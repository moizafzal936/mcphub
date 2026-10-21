import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'crypto'
import { startFixtures, startServer, registerUser, createApp, addTool, Client, type Fixtures, type TestServer } from './helpers.js'

let fx: Fixtures
let srv: TestServer
let operator: Client
let other: Client

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx, { MCPHUB_RATE_AUTH_PER_15MIN: '4' })
  operator = await registerUser(srv.base, 'operator@example.test')
  other = await registerUser(srv.base, 'other@example.test')
})
after(async () => {
  await srv.close()
  await fx.close()
})

const exec = (c: Client, appId: string, toolId: string, args: unknown) => c.post(`/api/apps/${appId}/tools/${toolId}/execute`, args)

test('only the operator can see and claim ownerless apps', async () => {
  const { getDb } = await import('../src/storage/db.js')
  await getDb().execute({
    sql: 'INSERT INTO apps (id, name, base_url, api_key_header, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: ['legacy-app', 'Legacy', `http://127.0.0.1:${fx.upstreamPort}/v1`, 'Authorization', Date.now(), Date.now()],
  })
  assert.deepEqual((await other.get('/api/orphans')).body, { count: 0, canClaim: false })
  assert.equal((await other.post('/api/orphans/claim')).status, 403)
  assert.deepEqual((await operator.get('/api/orphans')).body, { count: 1, canClaim: true })
  assert.equal((await operator.post('/api/orphans/claim')).body.claimed, 1)
  assert.ok((await operator.get('/api/apps')).body.some((a: any) => a.id === 'legacy-app'))
  assert.equal((await other.get('/api/apps/legacy-app')).status, 404)
})

test('encryption key rotation re-encrypts every secret, and aborts cleanly on a wrong key', async () => {
  const { getDb, appRepo } = await import('../src/storage/db.js')
  const { rotateEncryptionKey } = await import('../src/security/rotateKey.js')
  const { initEncryptionKey } = await import('../src/security/secrets.js')
  const { getConfig } = await import('../src/config.js')

  const app = await createApp(operator, fx, { apiKey: 'sk-rotate-me-123456' })
  const tool = await addTool(operator, app.id, { name: 'echo', path: '/echo' })
  const reg = await fetch(`${srv.base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'c', redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'client_secret_post' }),
  })
  const client = await reg.json()

  const before = await getDb().execute({ sql: 'SELECT api_key FROM apps WHERE id = ?', args: [app.id] })
  await assert.rejects(rotateEncryptionKey(randomBytes(32).toString('base64'), randomBytes(32).toString('base64')))
  const unchanged = await getDb().execute({ sql: 'SELECT api_key FROM apps WHERE id = ?', args: [app.id] })
  assert.equal(unchanged.rows[0].api_key, before.rows[0].api_key, 'failed rotation modified data')

  const oldKey = getConfig().encryptionKey!
  const newKey = randomBytes(32).toString('base64')
  const result = await rotateEncryptionKey(oldKey, newKey)
  assert.ok(result.secrets >= 2)
  getConfig().encryptionKey = newKey
  initEncryptionKey()

  assert.equal(await appRepo.getApiKey(app.id), 'sk-rotate-me-123456')
  await exec(operator, app.id, tool.id, {})
  assert.equal(fx.upstreamHits.at(-1)!.headers.authorization, 'Bearer sk-rotate-me-123456')
  const stored = await getDb().execute({ sql: 'SELECT info FROM oauth_clients WHERE client_id = ?', args: [client.client_id] })
  assert.ok(!String(stored.rows[0].info).includes(client.client_secret), 'client secret stored in plaintext')
})

test('stale dynamically-registered OAuth clients are purged', async () => {
  const { getDb, purgeExpired } = await import('../src/storage/db.js')
  const old = Date.now() - 31 * 86_400_000
  await getDb().execute({ sql: 'INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)', args: ['stale-client', '{}', old] })
  await getDb().execute({ sql: 'INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)', args: ['fresh-client', '{}', Date.now()] })
  await purgeExpired(30, 1000)
  const left = await getDb().execute("SELECT client_id FROM oauth_clients WHERE client_id IN ('stale-client', 'fresh-client')")
  assert.deepEqual(left.rows.map(r => r.client_id), ['fresh-client'])
})

test('per-app rate limit stops upstream calls once exceeded', async () => {
  const app = await createApp(operator, fx, { rateLimitPerMin: 2 })
  const tool = await addTool(operator, app.id, { name: 'echo', path: '/echo' })
  const hits = fx.upstreamHits.length
  const results = [await exec(operator, app.id, tool.id, {}), await exec(operator, app.id, tool.id, {}), await exec(operator, app.id, tool.id, {})]
  assert.deepEqual(results.map(r => r.body.statusCode), [200, 200, 429])
  assert.equal(fx.upstreamHits.length, hits + 2)
})

test('tool arguments are validated against the declared schema before any request', async () => {
  const app = await createApp(operator, fx)
  const tool = await addTool(operator, app.id, {
    name: 'search', path: '/echo',
    queryParams: [{ name: 'limit', type: 'integer' }, { name: 'X-Trace', in: 'header' }],
  })
  const hits = fx.upstreamHits.length
  const bad: unknown[] = [
    { limit: 'abc' },
    { unknown: 1 },
    { limit: { nested: 1 } },
    { 'X-Trace': 'a'.repeat(70_000) },
    { 'X-Trace': 'ok\r\nX-Injected: 1' },
    [1, 2],
  ]
  for (const args of bad) {
    const res = await exec(operator, app.id, tool.id, args)
    assert.equal(res.body.statusCode, 0, `accepted ${JSON.stringify(args).slice(0, 60)}`)
  }
  assert.equal(fx.upstreamHits.length, hits, 'invalid arguments reached upstream')
  const ok = await exec(operator, app.id, tool.id, { limit: '5', 'X-Trace': 'abc' })
  assert.equal(ok.body.statusCode, 200)
  assert.equal(ok.body.data.query.limit, '5')
  assert.equal(fx.upstreamHits.at(-1)!.headers['x-trace'], 'abc')
})

test('logs redact sensitive fields and are bounded by age and count', async () => {
  const { getDb, purgeExpired } = await import('../src/storage/db.js')
  const app = await createApp(operator, fx)
  const tool = await addTool(operator, app.id, { name: 'login', path: '/echo', queryParams: [{ name: 'password' }, { name: 'q' }] })
  await exec(operator, app.id, tool.id, { password: 'hunter2-very-secret', q: 'visible' })
  const logs = JSON.stringify((await operator.get(`/api/apps/${app.id}/logs`)).body)
  assert.ok(!logs.includes('hunter2-very-secret'), 'password stored in logs')
  assert.ok(logs.includes('visible'))

  const now = Date.now()
  for (let i = 0; i < 8; i++) {
    await getDb().execute({
      sql: 'INSERT INTO tool_call_logs (id, app_id, tool_name, input, output, status_code, duration_ms, called_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [`log-${i}`, app.id, 't', '{}', '{}', 200, 1, i === 0 ? now - 40 * 86_400_000 : now - i * 1000],
    })
  }
  await purgeExpired(30, 5)
  const remaining = await getDb().execute({ sql: 'SELECT COUNT(*) AS n FROM tool_call_logs WHERE app_id = ?', args: [app.id] })
  assert.equal(Number(remaining.rows[0].n), 5)
  const aged = await getDb().execute("SELECT id FROM tool_call_logs WHERE id = 'log-0'")
  assert.equal(aged.rows.length, 0)
})

test('self-referencing OpenAPI specs import without hanging', async () => {
  const app = await createApp(operator, fx)
  const started = Date.now()
  const res = await operator.post(`/api/apps/${app.id}/import`, { specUrl: `http://127.0.0.1:${fx.upstreamPort}/spec-cyclic.json` })
  assert.equal(res.status, 200)
  assert.equal(res.body.imported, 1)
  assert.ok(Date.now() - started < 5000)
})

test('repeated failed logins are rate limited, then even the right password is refused', async () => {
  const c = new Client(srv.base)
  let status = 0
  for (let i = 0; i < 10 && status !== 429; i++) {
    status = (await c.post('/api/auth/login', { email: 'operator@example.test', password: `wrong-password-${i}` })).status
  }
  assert.equal(status, 429)
  const right = await c.post('/api/auth/login', { email: 'operator@example.test', password: 'correct horse battery staple' })
  assert.equal(right.status, 429)
})

test('per-tool stats count calls, errors and latency, scoped to the owner', async () => {
  const app = await createApp(operator, fx)
  const ok = await addTool(operator, app.id, { name: 'ok_tool', path: '/echo' })
  const missing = await addTool(operator, app.id, { name: 'missing_tool', path: '/nope' })
  await exec(operator, app.id, ok.id, {})
  await exec(operator, app.id, ok.id, {})
  await exec(operator, app.id, missing.id, {})
  const stats = (await operator.get(`/api/apps/${app.id}/tool-stats`)).body
  const byName = Object.fromEntries(stats.map((s: any) => [s.toolName, s]))
  assert.equal(byName.ok_tool.calls, 2)
  assert.equal(byName.ok_tool.errors, 0)
  assert.equal(byName.missing_tool.errors, 1)
  assert.equal(typeof byName.ok_tool.avgMs, 'number')
  assert.equal((await other.get(`/api/apps/${app.id}/tool-stats`)).status, 404)
})

test('health check reports the database state', async () => {
  const db = await import('../src/storage/db.js')
  assert.equal((await fetch(`${srv.base}/health`)).status, 200)
  const original = db.getDb().execute.bind(db.getDb())
  ;(db.getDb() as any).execute = async () => { throw new Error('disk gone') }
  try {
    const res = await fetch(`${srv.base}/health`)
    assert.equal(res.status, 503)
    assert.deepEqual(await res.json(), { status: 'unavailable' })
  } finally {
    ;(db.getDb() as any).execute = original
  }
  assert.equal((await fetch(`${srv.base}/health`)).status, 200)
})
