import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFixtures, startServer, registerUser, Client, type Fixtures, type TestServer } from './helpers.js'

const EMAIL = 'twofactor@example.test'
const PASSWORD = 'correct horse battery staple'
let fx: Fixtures
let srv: TestServer
let user: Client
let totp: typeof import('../src/security/totp.js')

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx)
  user = await registerUser(srv.base, EMAIL)
  totp = await import('../src/security/totp.js')
})
after(async () => {
  await srv.close()
  await fx.close()
})

const login = (body: Record<string, string>) => new Client(srv.base).post('/api/auth/login', { email: EMAIL, password: PASSWORD, ...body })

test('enabling 2FA requires a valid code; login then needs a fresh code', async () => {
  const setup = await user.post('/api/auth/2fa/setup')
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\/MCPHub/)
  const secret: string = setup.body.secret

  assert.equal((await user.post('/api/auth/2fa/enable', { code: '000000' })).status, 400)
  const step = totp.currentStep()
  assert.equal((await user.post('/api/auth/2fa/enable', { code: totp.totpCode(secret, step) })).status, 200)
  assert.equal((await user.get('/api/auth/me')).body.user.twoFactorEnabled, true)

  const noCode = await login({})
  assert.equal(noCode.status, 401)
  assert.equal(noCode.body.twoFactorRequired, true)
  assert.equal((await login({ code: '123456' })).status, 401)
  // The code used to enable is already consumed: replay is rejected.
  assert.equal((await login({ code: totp.totpCode(secret, step) })).status, 401)
  assert.equal((await login({ code: totp.totpCode(secret, step + 1) })).status, 200)
  assert.equal((await login({ code: totp.totpCode(secret, step + 1) })).status, 401, 'login code replay accepted')

  const { getDb } = await import('../src/storage/db.js')
  const row = await getDb().execute({ sql: 'SELECT totp_secret FROM users WHERE email = ?', args: [EMAIL] })
  assert.match(String(row.rows[0].totp_secret), /^enc:v1:/)
})

test('disabling 2FA needs both the password and a code', async () => {
  const email = 'disable-2fa@example.test'
  const c = await registerUser(srv.base, email)
  const { secret } = (await c.post('/api/auth/2fa/setup')).body
  const step = totp.currentStep()
  assert.equal((await c.post('/api/auth/2fa/enable', { code: totp.totpCode(secret, step) })).status, 200)

  assert.equal((await c.post('/api/auth/2fa/disable', { password: 'wrong-password-123', code: totp.totpCode(secret, step + 1) })).status, 401)
  assert.equal((await c.post('/api/auth/2fa/disable', { password: PASSWORD, code: '000000' })).status, 401)
  assert.equal((await c.post('/api/auth/2fa/disable', { password: PASSWORD, code: totp.totpCode(secret, step + 1) })).status, 200)
  const relogin = await new Client(srv.base).post('/api/auth/login', { email, password: PASSWORD })
  assert.equal(relogin.status, 200, '2FA still required after disabling')
})

test('operator password reset sets a new password and signs the user out everywhere', async () => {
  const { userRepo } = await import('../src/storage/db.js')
  const { hashPassword } = await import('../src/security/passwords.js')
  const email = 'reset@example.test'
  const session = await registerUser(srv.base, email)
  assert.equal((await session.get('/api/apps')).status, 200)

  const target = await userRepo.findByEmail(email)
  await userRepo.resetPassword(target!.id, await hashPassword('temporary-password-xyz'))
  assert.equal((await session.get('/api/apps')).status, 401, 'old session survived the reset')
  assert.equal((await new Client(srv.base).post('/api/auth/login', { email, password: PASSWORD })).status, 401)
  assert.equal((await new Client(srv.base).post('/api/auth/login', { email, password: 'temporary-password-xyz' })).status, 200)
})
