import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createFixturePanelSession } from './fixtures/panel-session.mjs'

const executable = path.resolve(process.argv[2] || 'target/debug/agent2api-server')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-phase-'))
const key = randomUUID()
let finishReason = 'stop'
const upstream = http.createServer(async (request, response) => {
  for await (const chunk of request) { void chunk }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  response.write(frame({ role: 'assistant', content: 'fixture output' }))
  if (finishReason === 'tool_calls') response.write(frame({ tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }))
  response.end(frame({}, finishReason) + 'data: [DONE]\n\n')
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const reserve = http.createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: directory, AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: key, AGENT2API_ACCOUNT_KEY: '1'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_CAPTCHA_ENABLED: '0' }
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
const child = spawn(executable, [], { cwd: directory, env, windowsHide: true, stdio: 'ignore' })
const ended = once(child, 'exit')
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, 'fixture server exited')
    try { if ((await fetch(base + '/health')).ok) break } catch {}
    await delay(150)
  }
  const admin = await createFixturePanelSession(base, { username: 'fixture-admin', password: randomUUID() + '!Aa' })
  async function management(endpoint, method = 'GET', body, status = 200, headers = { 'x-panel-token': admin.accessToken }) {
    const response = await fetch(base + endpoint, { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    assert.equal(response.status, status, `${method} ${endpoint}`)
    const value = await response.json()
    return value.success === true && Object.hasOwn(value, 'data') ? value.data : value
  }
  const endpoint = '/api/reasoning-collapse'
  assert.equal((await management(endpoint)).thirdPartyReasoningCollapse, false)
  await management(endpoint, 'PUT', { thirdPartyReasoningCollapse: 'true' }, 400)
  const restricted = await management('/api/keys', 'POST', { name: 'Phase fixture', allowedProviders: ['workbuddy'] })
  await management(endpoint, 'PUT', { thirdPartyReasoningCollapse: true }, 403, { authorization: `Bearer ${restricted.created.key}` })
  await management(endpoint, 'PUT', { thirdPartyReasoningCollapse: true }, 403, { authorization: `Bearer ${key}` })
  const channel = await management('/api/custom-providers', 'POST', { name: 'Phase fixture', protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', enabled: true, apiKeys: ['local-only'], models: ['wire'] }] })
  const model = 'Phase-Public'
  const groups = await management('/api/routing/groups')
  await management('/api/routing/groups', 'PUT', { revision: groups.newRevision, id: model, group: { id: model, name: model, model, enabled: true, strategy: 'order', sticky: 'off', members: [{ id: 'source', provider: channel.provider.id, model: 'wire', included: true, accountScope: 'all', accounts: [] }] } })
  async function check(stream, agent, expected) {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'user-agent': agent, 'content-type': 'application/json' }, body: JSON.stringify({ model, stream, input: randomUUID(), tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }] }), signal: AbortSignal.timeout(20000) })
    assert.equal(response.status, 200)
    let result
    if (stream) {
      const frames = (await response.text()).split(/\r?\n/).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
      result = frames.find(frame => ['response.completed', 'response.incomplete'].includes(frame.type))?.response
      const done = frames.find(frame => frame.type === 'response.output_item.done' && frame.item.type === 'message')
      assert.ok(done); assert.equal(done.item.phase, expected)
    } else result = await response.json()
    assert.ok(result); assert.equal(result.output.find(item => item.type === 'message').phase, expected)
  }
  for (const stream of [false, true]) await check(stream, 'codex-tui/1', undefined)
  assert.equal((await management(endpoint, 'PUT', { thirdPartyReasoningCollapse: true })).thirdPartyReasoningCollapse, true)
  for (const stream of [false, true]) {
    finishReason = 'stop'; await check(stream, 'codex-tui/1', 'final_answer'); await check(stream, 'fixture/1', undefined)
    finishReason = 'length'; await check(stream, 'codex-tui/1', undefined)
    finishReason = 'tool_calls'; await check(stream, 'codex-tui/1', 'commentary')
  }
  console.log('PASS Responses phase: default off, strict settings, panel permission, stream/aggregate, client, truncation and tools')
} finally {
  if (child.exitCode === null) { child.kill(); await ended }
  await new Promise(resolve => upstream.close(resolve))
}
