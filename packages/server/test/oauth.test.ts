import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { startFixtures, startServer, registerUser, createApp, addTool, type Fixtures, type TestServer, type Client } from './helpers.js'

const REDIRECT = 'http://127.0.0.1:9/callback'
let fx: Fixtures
let srv: TestServer
let alice: Client
let bob: Client

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx)
  alice = await registerUser(srv.base, 'alice-oauth@example.test')
  bob = await registerUser(srv.base, 'bob-oauth@example.test')
})
after(async () => {
  await srv.close()
  await fx.close()
})

/** In-memory OAuth client, like Claude's connector or Claude Code would keep. */
class TestOAuthProvider implements OAuthClientProvider {
  info?: OAuthClientInformationFull
  saved?: OAuthTokens
  verifier = ''
  authUrl?: URL
  get redirectUrl() { return REDIRECT }
  get clientMetadata() {
    return { client_name: 'Test Connector', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post' }
  }
  clientInformation() { return this.info }
  saveClientInformation(info: OAuthClientInformationFull) { this.info = info }
  tokens() { return this.saved }
  saveTokens(t: OAuthTokens) { this.saved = t }
  redirectToAuthorization(url: URL) { this.authUrl = url }
  saveCodeVerifier(v: string) { this.verifier = v }
  codeVerifier() { return this.verifier }
}

async function connect(appId: string, provider: TestOAuthProvider) {
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/${appId}`), { authProvider: provider })
  const client = new McpClient({ name: 'oauth-test', version: '1' })
  await client.connect(transport)
  return { client, transport }
}

/** Runs discovery + DCR + authorize up to the consent page and returns the pending request id. */
async function startAuthorization(appId: string, provider: TestOAuthProvider) {
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/${appId}`), { authProvider: provider })
  await assert.rejects(new McpClient({ name: 'oauth-test', version: '1' }).connect(transport), /Unauthorized/)
  assert.ok(provider.authUrl, 'client was not sent to the authorization endpoint')
  const res = await fetch(provider.authUrl, { redirect: 'manual' })
  assert.equal(res.status, 302)
  const consent = new URL(res.headers.get('location')!)
  assert.equal(consent.pathname, '/oauth/consent')
  return { transport, requestId: consent.searchParams.get('request')! }
}

async function approve(user: Client, requestId: string, approveIt = true) {
  return user.post(`/api/oauth/requests/${encodeURIComponent(requestId)}/decision`, { approve: approveIt })
}

test('discovery: 401 points to per-app protected resource metadata and the authorization server', async () => {
  const app = await createApp(alice, fx)
  const res = await fetch(`${srv.base}/mcp/${app.id}`, { method: 'POST' })
  assert.equal(res.status, 401)
  const header = res.headers.get('www-authenticate')!
  const metaUrl = header.match(/resource_metadata="([^"]+)"/)![1]
  const meta = await (await fetch(metaUrl)).json()
  assert.equal(meta.resource, `${srv.base}/mcp/${app.id}`)
  const as = await (await fetch(`${meta.authorization_servers[0].replace(/\/$/, '')}/.well-known/oauth-authorization-server`)).json()
  assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
  assert.ok(as.registration_endpoint)
})

test('full OAuth flow: register, consent, exchange code, then call tools', async () => {
  const app = await createApp(alice, fx, { apiKey: 'sk-oauth-upstream-123456' })
  await addTool(alice, app.id, { name: 'get_item', path: '/items/{id}' })
  const provider = new TestOAuthProvider()
  const { transport, requestId } = await startAuthorization(app.id, provider)

  const details = await alice.get(`/api/oauth/requests/${encodeURIComponent(requestId)}`)
  assert.equal(details.status, 200)
  assert.equal(details.body.clientName, 'Test Connector')
  assert.equal(details.body.app.id, app.id)

  const decision = await approve(alice, requestId)
  const redirect = new URL(decision.body.redirectUrl)
  assert.equal(redirect.origin + redirect.pathname, REDIRECT)
  assert.equal(redirect.searchParams.get('iss'), srv.base)
  await transport.finishAuth(redirect.searchParams.get('code')!)
  assert.ok(provider.saved?.access_token && provider.saved.refresh_token)

  const { client } = await connect(app.id, provider)
  const result: any = await client.callTool({ name: 'get_item', arguments: { id: 'via-oauth' } })
  assert.equal(result.isError, false)
  assert.deepEqual(JSON.parse(result.content[0].text), { id: 'via-oauth' })
  assert.equal(fx.upstreamHits.at(-1)!.headers.authorization, 'Bearer sk-oauth-upstream-123456')
  await client.close()

  const grants = await alice.get(`/api/apps/${app.id}/grants`)
  assert.equal(grants.body.length, 1)
  assert.equal(grants.body[0].clientName, 'Test Connector')
})

test('consent can only be given by the app owner, once', async () => {
  const app = await createApp(alice, fx)
  const provider = new TestOAuthProvider()
  const { requestId } = await startAuthorization(app.id, provider)
  assert.equal((await bob.get(`/api/oauth/requests/${encodeURIComponent(requestId)}`)).status, 404)
  assert.equal((await approve(bob, requestId)).status, 404)
  assert.equal((await approve(alice, requestId)).status, 200)
  assert.equal((await approve(alice, requestId)).status, 404, 'request could be decided twice')
})

test('denying consent returns access_denied and issues no code', async () => {
  const app = await createApp(alice, fx)
  const { requestId } = await startAuthorization(app.id, new TestOAuthProvider())
  const res = await approve(alice, requestId, false)
  const url = new URL(res.body.redirectUrl)
  assert.equal(url.searchParams.get('error'), 'access_denied')
  assert.equal(url.searchParams.get('code'), null)
})

test('authorization codes are single-use and bound to the PKCE verifier', async () => {
  const app = await createApp(alice, fx)
  const provider = new TestOAuthProvider()
  const { transport, requestId } = await startAuthorization(app.id, provider)
  const code = new URL((await approve(alice, requestId)).body.redirectUrl).searchParams.get('code')!

  const realVerifier = provider.verifier
  provider.verifier = 'x'.repeat(64)
  await assert.rejects(transport.finishAuth(code), 'wrong PKCE verifier was accepted')
  provider.verifier = realVerifier
  await transport.finishAuth(code)
  await assert.rejects(transport.finishAuth(code), 'authorization code was accepted twice')
})

test('authorization requests for other hosts or non-MCP resources are refused', async () => {
  const app = await createApp(alice, fx)
  const provider = new TestOAuthProvider()
  const { transport } = await startAuthorization(app.id, provider)
  void transport
  for (const resource of ['https://evil.example/mcp/' + app.id, `${srv.base}/api/apps`, `${srv.base}/mcp/${app.id}?x=1`]) {
    const url = new URL(provider.authUrl!)
    url.searchParams.set('resource', resource)
    const res = await fetch(url, { redirect: 'manual' })
    const location = new URL(res.headers.get('location')!)
    assert.equal(location.searchParams.get('error'), 'invalid_target', `${resource} accepted`)
  }
})

test('refresh tokens rotate; replaying an old one revokes the grant', async () => {
  const app = await createApp(alice, fx)
  await addTool(alice, app.id, { name: 'echo', path: '/echo' })
  const provider = new TestOAuthProvider()
  const { transport, requestId } = await startAuthorization(app.id, provider)
  await transport.finishAuth(new URL((await approve(alice, requestId)).body.redirectUrl).searchParams.get('code')!)
  const first = provider.saved!
  const tokenUrl = `${srv.base}/token`
  const refresh = (token: string) => fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: provider.info!.client_id, client_secret: provider.info!.client_secret! }),
  })

  const rotated = await refresh(first.refresh_token!)
  assert.equal(rotated.status, 200)
  const second = await rotated.json()
  assert.notEqual(second.refresh_token, first.refresh_token)

  assert.equal((await refresh(first.refresh_token!)).status, 400, 'old refresh token still worked')
  assert.equal((await refresh(second.refresh_token)).status, 400, 'grant survived refresh-token replay')
  const mcp = await fetch(`${srv.base}/mcp/${app.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${second.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  assert.equal(mcp.status, 401)
})

test('revoking a connection in the dashboard cuts off its access token', async () => {
  const app = await createApp(alice, fx)
  await addTool(alice, app.id, { name: 'echo', path: '/echo' })
  const provider = new TestOAuthProvider()
  const { transport, requestId } = await startAuthorization(app.id, provider)
  await transport.finishAuth(new URL((await approve(alice, requestId)).body.redirectUrl).searchParams.get('code')!)
  const { client } = await connect(app.id, provider)
  assert.equal((await client.listTools()).tools.length, 1)

  const [grant] = (await alice.get(`/api/apps/${app.id}/grants`)).body
  assert.equal((await bob.del(`/api/apps/${app.id}/grants/${grant.id}`)).status, 404)
  assert.equal((await alice.del(`/api/apps/${app.id}/grants/${grant.id}`)).status, 200)
  await assert.rejects(client.listTools())
})
