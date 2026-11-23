// Usage: node scripts/test-sticky-prepare.mjs <linked-sticky-timing-gateway> [node]
// The helper links the current production server library; only the worker and
// upstream dependency are controlled. Nothing connects to external accounts.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const helper = path.resolve(process.argv[2])
const worker = fileURLToPath(new URL('./fixtures/sticky-timing-worker.mjs', import.meta.url))
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-sticky-prepare-'))
const control = path.join(directory, 'control.json')
await writeFile(control, JSON.stringify({ slowPrepare: false }))
const key = 'isolated-sticky-preparation-admin'
const calls = [], sockets = new Set()
let phase = '', bFailures = 0, child, exited, log = '', base, fixtureAccounts
const upstream = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const channel = String(request.headers.authorization).replace('Bearer timing-', '')
  calls.push({ channel, model: body.model })
  if (phase && channel === 'a') {
    await delay(850)
    response.writeHead(429, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'fixture quota exhausted' } }))
    return
  }
  if (phase === 'quota-switch' && channel === 'b' && bFailures++ === 0) {
    response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'fixture temporarily unavailable' } }))
    return
  }
  if (phase === 'quota-headers' && channel === 'b') await delay(600)
  if (phase === 'quota-timeout' && channel === 'b') await delay(1500)
  if (response.destroyed) return
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: channel }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
})
upstream.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) })
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
async function api(endpoint, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + endpoint, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'x-session-id': 'prepare-fixture' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) })
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  return value.success === true && Object.hasOwn(value, 'data') ? value.data : value
}
async function group(id) {
  const catalog = await api('/api/routing/groups')
  await api('/api/routing/groups', { id, revision: catalog.newRevision, group: { id, name: id, model: 'sticky/' + id,
    strategy: 'order', sticky: 'auto', firstToken: 1, patience: -1, enabled: true,
    members: ['a', 'b', 'c'].map(channel => ({ id: channel, provider: 'timing-fixture', model: id + '-' + channel,
      included: true, accountScope: 'selected', accounts: [fixtureAccounts[channel]], weight: 1 })) } }, 'PUT')
  return 'sticky/' + id
}
async function chat(model) {
  const result = await api('/v1/chat/completions', { model, stream: false, messages: [{ role: 'user', content: 'ping' }] })
  return result.choices[0].message.content
}
let passed = 0, failures = []
try {
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
  base = 'http://127.0.0.1:' + port
  const env = { ...process.env, AGENT2API_PROXY_HOME: directory, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
    AGENT2API_PROXY_API_KEY: key, AGENT2API_ACCOUNT_KEY: '5'.repeat(64), AGENT2API_SELF_UPDATE: '0',
    AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' }
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
  child = spawn(helper, [process.argv[3] || process.execPath, worker, path.join(directory, 'worker.json'),
    'http://127.0.0.1:' + upstream.address().port, control], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(child, 'exit')
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { log += chunk })
  for (let attempt = 0; !log.includes('TIMING_FIXTURE_READY'); attempt++) {
    if (child.exitCode !== null) throw Error('Fixture exited: ' + log.slice(-3000))
    assert(attempt < 200, 'Fixture startup timed out')
    await delay(50)
  }
  fixtureAccounts = JSON.parse(await readFile(path.join(directory, 'worker.json'), 'utf8')).accounts
  await api('/api/retry', { retryCount: 0, retryCrossProviderCount: 0, retryIntervalSeconds: 0, noRetryStatusCodes: [] }, 'PUT')
  await api('/api/routing', { routingFailoverBackoff: false, routingSink: false, routingBreakerEnabled: false, routingBreakerTimeoutSeconds: 10 }, 'PUT')
  for (const [name, want, sequence] of [
    ['quota-switch', 'b', ['a', 'b', 'b']],
    ['quota-headers', 'b', ['a', 'b']],
    ['quota-timeout', 'c', ['a', 'b', 'b', 'c']],
  ]) {
    phase = ''; await writeFile(control, JSON.stringify({ slowPrepare: false }))
    const model = await group(name)
    assert.equal(await chat(model), 'a')
    phase = name; bFailures = 0
    await writeFile(control, JSON.stringify({ slowPrepare: true }))
    const start = calls.length
    try {
      assert.equal(await chat(model), want, 'B preparation must not inherit A deadline or consume a B failure')
      assert.deepEqual(calls.slice(start).map(call => call.channel), sequence, 'Only actual B sends consume its two-failure allowance')
      console.log('PASS ' + name); passed++
    } catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message) }
  }
  if (failures.length) process.exitCode = 1
  console.log(`Sticky preparation: ${passed} passed, ${failures.length} failed`)
} finally {
  if (child?.exitCode === null) child.kill()
  if (exited) await Promise.race([exited, delay(5000)])
  for (const socket of sockets) socket.destroy()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  await writeFile(path.join(directory, 'server.log'), log)
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({ passed, failures, calls }, null, 2))
  console.log('Evidence ' + directory)
}
