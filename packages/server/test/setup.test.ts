import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { startFixtures, startServer, Client, type Fixtures, type TestServer } from './helpers.js'

// Production-like setup: sign-up closed and no web bootstrap, as on a fresh public server.
let fx: Fixtures
let srv: TestServer

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx, { MCPHUB_ALLOW_SIGNUP: 'false', MCPHUB_WEB_BOOTSTRAP: 'false' })
})
after(async () => {
  await srv.close()
  await fx.close()
})

test('a fresh server refuses web sign-up until the operator is created on the server', async () => {
  const visitor = new Client(srv.base)
  assert.deepEqual((await visitor.get('/api/auth/status')).body, { signupOpen: false, bootstrap: false, needsSetup: true })
  const attempt = await visitor.post('/api/auth/register', { email: 'first@example.test', password: 'correct horse battery staple' })
  assert.equal(attempt.status, 403)
  assert.match(attempt.body.error, /create-operator/)

  const { createOperatorAccount } = await import('../src/auth/operator.js')
  const account = await createOperatorAccount('  Owner@Example.test ')
  assert.equal(account.email, 'owner@example.test')
  assert.ok(account.password.length >= 24)
  await assert.rejects(createOperatorAccount('second@example.test'), /already exists/)

  const owner = new Client(srv.base)
  assert.equal((await owner.post('/api/auth/login', { email: 'owner@example.test', password: account.password })).status, 200)
  assert.equal((await owner.get('/api/orphans')).body.canClaim, true, 'the created account is not the operator')
  assert.deepEqual((await visitor.get('/api/auth/status')).body, { signupOpen: false, bootstrap: false, needsSetup: false })
  assert.equal((await visitor.post('/api/auth/register', { email: 'late@example.test', password: 'correct horse battery staple' })).status, 403)
})

test('the backup command writes a consistent copy and keeps only the newest ones', async () => {
  const run = () => execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/backup.ts', '2'], {
    cwd: join(import.meta.dirname, '..'), env: { ...process.env }, encoding: 'utf8',
  })
  for (let i = 0; i < 3; i++) {
    assert.match(run(), /Backup written: /)
    await new Promise(r => setTimeout(r, 1100))
  }
  const dir = join(srv.dataDir, 'backups')
  const files = readdirSync(dir).filter(f => f.endsWith('.db'))
  assert.equal(files.length, 2)
  const { createClient } = await import('@libsql/client')
  const copy = createClient({ url: `file:${join(dir, files.at(-1)!)}` })
  const users = await copy.execute('SELECT email FROM users')
  assert.deepEqual(users.rows.map(r => r.email), ['owner@example.test'])
  copy.close()
  assert.ok(existsSync(join(dir, files[0])))
})
