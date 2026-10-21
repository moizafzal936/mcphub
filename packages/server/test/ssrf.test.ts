import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startFixtures, startServer, registerUser, createApp, addTool, type Fixtures, type TestServer, type Client } from './helpers.js'

let fx: Fixtures
let srv: TestServer
let user: Client
let ssrf: typeof import('../src/security/ssrf.js')

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx)
  user = await registerUser(srv.base)
  ssrf = await import('../src/security/ssrf.js')
})
after(async () => {
  await srv.close()
  await fx.close()
})
afterEach(() => ssrf.setResolverForTesting(undefined))

function assertInternalUntouched() {
  assert.equal(fx.internalHits.length, 0, `internal service was reached: ${JSON.stringify(fx.internalHits.map(h => h.url))}`)
}

test('address classification blocks private, loopback, link-local, metadata and wrapped forms', () => {
  const blocked = [
    '127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.0.1', '169.254.169.254', '100.100.100.200', '100.64.0.1',
    '0.0.0.0', '192.0.0.192', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001::1', '[::1]',
  ]
  for (const ip of blocked) assert.equal(ssrf.isAddressAllowed(ip, 80), false, `${ip} allowed`)
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(ssrf.isAddressAllowed(ip, 443), true, `${ip} blocked`)
  }
  // The allowlist is exact ip:port, not the whole host.
  assert.equal(ssrf.isAddressAllowed('127.0.0.1', fx.upstreamPort), true)
  assert.equal(ssrf.isAddressAllowed('127.0.0.1', fx.internalPort), false)
})

test('base URLs pointing at internal destinations are rejected at app creation', async () => {
  const p = fx.internalPort
  const targets = [
    `http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://[::1]:${p}`, `http://[::ffff:127.0.0.1]:${p}`,
    `http://2130706433:${p}`, `http://0x7f.1:${p}`, `http://0177.0.0.1:${p}`, `http://0:${p}`,
    'http://169.254.169.254/latest/meta-data', 'http://[fd00:ec2::254]/', 'http://10.0.0.5/', 'http://192.168.1.1/',
    'http://[fe80::1]/', 'file:///etc/passwd', 'gopher://127.0.0.1:6379/_x', 'http://user:pass@example.com/',
  ]
  for (const baseUrl of targets) {
    const res = await user.post('/api/apps', { name: 'ssrf', baseUrl })
    assert.equal(res.status, 400, `${baseUrl} -> ${res.status} ${JSON.stringify(res.body)}`)
  }
  assertInternalUntouched()
})

test('connect-time guard blocks internal targets even when creation-time checks are bypassed', async () => {
  const { getDb } = await import('../src/storage/db.js')
  const app = await createApp(user, fx)
  const tool = await addTool(user, app.id, { name: 'echo', path: '/echo' })
  for (const baseUrl of [`http://[::ffff:127.0.0.1]:${fx.internalPort}`, `http://localhost:${fx.internalPort}`, `http://[::1]:${fx.internalPort}`]) {
    await getDb().execute({ sql: 'UPDATE apps SET base_url = ? WHERE id = ?', args: [baseUrl, app.id] })
    const res = await user.post(`/api/apps/${app.id}/tools/${tool.id}/execute`, {})
    assert.equal(res.body.statusCode, 0, `${baseUrl}: ${JSON.stringify(res.body)}`)
    assert.match(res.body.error, /blocked|ECONNREFUSED/)
  }
  assertInternalUntouched()
})

test('DNS rebinding: a name that resolved public at creation but private at connect time is blocked', async () => {
  let calls = 0
  ssrf.setResolverForTesting((_host, cb) => {
    calls++
    cb(null, [{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }])
  })
  const created = await user.post('/api/apps', { name: 'rebind', baseUrl: `http://rebind.test:${fx.internalPort}` })
  assert.equal(created.status, 201, 'creation-time check should have seen the public answer')
  const tool = await addTool(user, created.body.id, { name: 'echo', path: '/echo' })
  const res = await user.post(`/api/apps/${created.body.id}/tools/${tool.id}/execute`, {})
  assert.equal(res.body.statusCode, 0)
  assert.match(res.body.error, /blocked/)
  assert.ok(calls >= 2, 'connect-time lookup did not run')
  assertInternalUntouched()
})

test('DNS answers mixing public and private addresses are rejected', async () => {
  ssrf.setResolverForTesting((_h, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]))
  await assert.rejects(ssrf.assertResolvesPublic('http://mixed.test/'), /blocked/)
  await assert.rejects(ssrf.safeRequest({ url: `http://mixed.test:${fx.internalPort}/`, redirects: 'none' }), /blocked/)
  assertInternalUntouched()
})

test('tool calls never follow redirects to internal hosts or other origins', async () => {
  const app = await createApp(user, fx, { apiKey: 'sk-redirect-test-123456' })
  const internal = await addTool(user, app.id, { name: 'r_internal', path: '/redirect-internal' })
  const cross = await addTool(user, app.id, { name: 'r_cross', path: '/redirect-cross' })
  const same = await addTool(user, app.id, { name: 'r_same', path: '/redirect-same' })

  const r1 = await user.post(`/api/apps/${app.id}/tools/${internal.id}/execute`, {})
  assert.equal(r1.body.statusCode, 302, 'redirect to internal host was followed')
  assertInternalUntouched()

  const before = fx.upstreamHits.length
  const r2 = await user.post(`/api/apps/${app.id}/tools/${cross.id}/execute`, {})
  assert.equal(r2.body.statusCode, 302, 'cross-origin redirect was followed')
  assert.equal(fx.upstreamHits.length, before + 1, 'credential was replayed to another origin')

  const r3 = await user.post(`/api/apps/${app.id}/tools/${same.id}/execute`, {})
  assert.equal(r3.body.statusCode, 200)
  assert.equal(r3.body.data.query.redirected, '1')
})

test('OpenAPI import: internal spec URLs and redirects to internal hosts are blocked', async () => {
  const app = await createApp(user, fx)
  const direct = await user.post(`/api/apps/${app.id}/import`, { specUrl: `http://127.0.0.1:${fx.internalPort}/openapi.json` })
  assert.equal(direct.status, 422)
  const mapped = await user.post(`/api/apps/${app.id}/import`, { specUrl: `http://[::ffff:127.0.0.1]:${fx.internalPort}/openapi.json` })
  assert.equal(mapped.status, 422)
  const redirected = await user.post(`/api/apps/${app.id}/import`, { specUrl: `http://127.0.0.1:${fx.upstreamPort}/spec-redirect-internal` })
  assert.equal(redirected.status, 422)
  const onCreate = await user.post('/api/apps', {
    name: 'spec-ssrf', baseUrl: `http://127.0.0.1:${fx.upstreamPort}/v1`, specUrl: `http://localhost:${fx.internalPort}/openapi.json`,
  })
  assert.equal(onCreate.status, 201)
  assert.match(onCreate.body.warning, /not a public address/)
  assertInternalUntouched()
})

test('proxy environment variables cannot route requests around the guard', async () => {
  process.env.HTTP_PROXY = `http://127.0.0.1:${fx.internalPort}`
  process.env.http_proxy = process.env.HTTP_PROXY
  try {
    const app = await createApp(user, fx)
    const tool = await addTool(user, app.id, { name: 'echo', path: '/echo' })
    const res = await user.post(`/api/apps/${app.id}/tools/${tool.id}/execute`, {})
    assert.equal(res.body.statusCode, 200)
  } finally {
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy
  }
  assertInternalUntouched()
})
