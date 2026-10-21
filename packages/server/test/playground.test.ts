import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import type { AddressInfo } from 'net'
import { startFixtures, startServer, registerUser, createApp, addTool, type Fixtures, type TestServer, type Client } from './helpers.js'

let fx: Fixtures
let srv: TestServer
let user: Client
let fakeClaude: http.Server
const claudeRequests: { headers: http.IncomingHttpHeaders; body: any }[] = []

// Local stand-in for the Anthropic Messages API: asks for one tool call, then answers.
function startFakeClaude(): Promise<string> {
  fakeClaude = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw)
      claudeRequests.push({ headers: req.headers, body })
      const last = body.messages.at(-1)
      const toolResult = Array.isArray(last.content) ? last.content.find((b: any) => b.type === 'tool_result') : undefined
      const content = toolResult
        ? [{ type: 'text', text: `Found item: ${toolResult.content}` }]
        : [{ type: 'tool_use', id: 'toolu_1', name: 'get_item', input: { id: '42' } }]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `msg_${claudeRequests.length}`, type: 'message', role: 'assistant', model: body.model, content,
        stop_reason: toolResult ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }))
    })
  })
  return new Promise(resolve => fakeClaude.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(fakeClaude.address() as AddressInfo).port}`)))
}

before(async () => {
  fx = await startFixtures()
  srv = await startServer(fx)
  user = await registerUser(srv.base)
})
after(async () => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_BASE_URL
  fakeClaude?.close()
  await srv.close()
  await fx.close()
})

test('playground reports that it needs an API key when none is configured', async () => {
  delete process.env.ANTHROPIC_API_KEY
  const app = await createApp(user, fx)
  assert.deepEqual((await user.get('/api/playground/status')).body, { enabled: false })
  const res = await user.post(`/api/apps/${app.id}/playground`, { messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 503)
})

test('playground runs the Claude tool-use loop through the guarded executor', async () => {
  process.env.ANTHROPIC_BASE_URL = await startFakeClaude()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
  const app = await createApp(user, fx, { apiKey: 'sk-upstream-for-playground' })
  await addTool(user, app.id, { name: 'get_item', path: '/items/{id}' })

  const res = await user.post(`/api/apps/${app.id}/playground`, { messages: [{ role: 'user', content: 'Get item 42' }] })
  assert.equal(res.status, 200)
  assert.match(res.body.reply, /Found item: .*"id": "42"/s)
  assert.deepEqual(res.body.steps.map((s: any) => [s.tool, s.statusCode]), [['get_item', 200]])

  assert.equal(fx.upstreamHits.at(-1)!.url, '/v1/items/42')
  assert.equal(fx.upstreamHits.at(-1)!.headers.authorization, 'Bearer sk-upstream-for-playground')
  assert.equal(claudeRequests[0].headers['x-api-key'], 'sk-ant-test-key')
  assert.deepEqual(claudeRequests[0].body.tools[0].input_schema.required, ['id'])
  assert.ok(!JSON.stringify(claudeRequests).includes('sk-upstream-for-playground'), 'upstream credential sent to the model')

  const other = await registerUser(srv.base)
  assert.equal((await other.post(`/api/apps/${app.id}/playground`, { messages: [{ role: 'user', content: 'x' }] })).status, 404)
})
