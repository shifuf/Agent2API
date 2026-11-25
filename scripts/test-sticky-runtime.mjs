// Usage: node scripts/test-sticky-runtime.mjs <linked-sticky-timing-gateway> [node]
// Real Host, scoped RpcAdapter and HTTP routing; only the plugin is controlled.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-sticky-runtime-'))
const control = path.join(directory, 'control.json')
const worker = fileURLToPath(new URL('./fixtures/sticky-timing-worker.mjs', import.meta.url))
const helper = path.resolve(process.argv[2])
const key = 'isolated-sticky-runtime-admin'
const provider = 'qwenwork' // Enabled scoped runtime: exercises strict_errors rather than the legacy path.
await writeFile(control, JSON.stringify({ mode: '524' }))
const reserve = http.createServer()
reserve.listen(0, '127.0.0.1')
await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const base = 'http://127.0.0.1:' + port
const env = { ...process.env, AGENT2API_PROXY_HOME: directory, AGENT2API_HOST: '127.0.0.1',
  AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: key, AGENT2API_ACCOUNT_KEY: '6'.repeat(64),
  AGENT2API_SELF_UPDATE: '0', AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '',
  AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' }
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
const child = spawn(helper, [process.argv[3] || process.execPath, worker, path.join(directory, 'worker.json'),
  'http://127.0.0.1:9', control, provider], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const exited = once(child, 'exit')
let log = '', passed = 0
const failures = [], cases = []
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { log += chunk })
async function request(endpoint, body, method = body ? 'POST' : 'GET') {
  return fetch(base + endpoint, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) })
}
async function api(endpoint, body, method) {
  const response = await request(endpoint, body, method)
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  return value.success === true && Object.hasOwn(value, 'data') ? value.data : value
}
async function calls() {
  return (await readFile(control + '.rpc.jsonl', 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(call => call.method === 'conversation')
}
try {
  for (let attempt = 0; !log.includes('TIMING_FIXTURE_READY'); attempt++) {
    assert.equal(child.exitCode, null, 'Fixture exited: ' + log.slice(-3000))
    assert(attempt < 200, 'Fixture startup timed out')
    await delay(50)
  }
  const accounts = JSON.parse(await readFile(path.join(directory, 'worker.json'), 'utf8')).accounts
  await api('/api/retry', { retryCount: 0, retryCrossProviderCount: 0, retryIntervalSeconds: 0, noRetryStatusCodes: [] }, 'PUT')
  await api('/api/routing', { routingFailoverBackoff: false, routingSink: false,
    routingBreakerEnabled: false, routingBreakerTimeoutSeconds: 10 }, 'PUT')
  for (const mode of ['524', '503', 'cleanup']) for (const stream of [false, true]) {
    const id = `runtime-${mode}-${stream ? 'stream' : 'json'}`
    const catalog = await api('/api/routing/groups')
    await api('/api/routing/groups', { id, revision: catalog.newRevision, group: {
      id, name: id, model: 'sticky/' + id, strategy: 'order', sticky: 'auto', firstToken: 0, patience: -1, enabled: true,
      members: [
        { id: 'A', provider, model: `runtime-${mode}-a`, included: true, accountScope: 'selected', accounts: [accounts.a, accounts.b], weight: 1 },
        { id: 'B', provider, model: `runtime-${mode}-c`, included: true, accountScope: 'selected', accounts: [accounts.c], weight: 1 },
      ],
    } }, 'PUT')
    await writeFile(control, JSON.stringify({ mode }))
    const start = (await calls()).length
    try {
      const response = await request('/v1/chat/completions', { model: 'sticky/' + id, stream,
        messages: [{ role: 'user', content: 'isolated runtime check ' + id }] })
      const text = await response.text()
      const sequence = (await calls()).slice(start).map(call => call.channel)
      cases.push({ id, status: response.status, sequence })
      if (mode === 'cleanup') {
        assert.equal(response.status, 502, text)
        assert.deepEqual(sequence, ['a'], 'Unconfirmed cleanup must stop before another account or channel')
        assert.equal(JSON.parse(text).error.code, 'network_cleanup_unconfirmed')
      } else {
        assert.equal(response.status, 200, text)
        assert.deepEqual(sequence.slice(0, 2).sort(), ['a', 'b'], 'The two failed sends must use different accounts')
        assert.equal(sequence.length, 3, 'Freeze channel A after two failed sends')
        assert.equal(sequence[2], 'c')
        if (stream) {
          assert(!text.includes('"error"'), text)
          assert.equal(text.match(/data: \[DONE\]/g)?.length, 1, text)
          const frames = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
            .map(line => JSON.parse(line.slice(6)))
          assert.equal(frames.map(frame => frame.choices?.[0]?.delta?.content || '').join(''), 'c')
        } else assert.equal(JSON.parse(text).choices[0].message.content, 'c')
      }
      console.log('PASS ' + id)
      passed++
    } catch (error) {
      failures.push({ id, error: error.stack })
      console.error('FAIL ' + id + ': ' + error.message)
    }
  }
  if (failures.length) process.exitCode = 1
  console.log(`Sticky runtime: ${passed} passed, ${failures.length} failed`)
} finally {
  if (child.exitCode === null) child.kill()
  await Promise.race([exited, delay(5000)])
  await writeFile(path.join(directory, 'server.log'), log)
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({ passed, failures, cases }, null, 2))
  console.log('Evidence ' + directory)
}
