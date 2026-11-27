import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as wait } from 'node:timers/promises'
import { createFixturePanelSession } from './fixtures/panel-session.mjs'

// Catches native error capture bypassing request privacy, including delayed
// capture drop after the handler scope ends. Ordinary debug capture must survive.
const home = await mkdtemp(join(tmpdir(), 'full-privacy-native-'))
const sensitive = 'native-confidential-' + randomUUID()
const gatewayKey = 'native-fixture-gateway'
const upstream = http.createServer(async (request, response) => {
  let bytes = ''; for await (const chunk of request) bytes += chunk
  assert.ok(!bytes.includes(sensitive), 'private request must be masked upstream')
  response.writeHead(400, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message: 'native diagnostic ' + sensitive } }))
}).listen(0, '127.0.0.1')
await once(upstream, 'listening')
const reservation = http.createServer().listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: home,
  AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: gatewayKey,
  AGENT2API_CAPTCHA_ENABLED: '0', AGENT2API_ACCOUNT_KEY: '8'.repeat(64),
  AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0' }
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
const child = spawn(resolve(process.argv[2]), [], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const ended = once(child, 'exit'); let logs = ''
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', bytes => { logs += bytes })
let auth
async function call(path, body, method = body ? 'POST' : 'GET', headers = { 'x-api-key': gatewayKey }) {
  return fetch(base + path, { method, headers: { ...headers, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) })
}
async function ok(path, body, method, headers) {
  const response = await call(path, body, method, headers)
  assert.equal(response.status, 200, path + ' must succeed')
  return (await response.json()).data
}
async function assertFilesPrivate(dir) {
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, file.name)
    if (file.isDirectory()) await assertFilesPrivate(path)
    else {
      let bytes
      for (let attempt = 0; attempt < 30; attempt++) {
        try { bytes = await readFile(path); break }
        catch (error) {
          if (error.code === 'ENOENT') break
          if (error.code !== 'EBUSY' || attempt === 29) throw error
          await wait(25)
        }
      }
      assert.ok(!bytes?.includes(Buffer.from(sensitive)), 'private native diagnostic entered ' + file.name)
    }
  }
}
async function assertPrivate(protocol) {
  const rows = await ok('/api/stats/requests?limit=100', undefined, 'GET', auth)
  assert.ok(!JSON.stringify(rows).includes(sensitive), protocol + ' management logs leaked')
  const db = new DatabaseSync(join(home, 'agent2api.db'), { readOnly: true })
  try {
    for (const table of ['requests', 'request_raw', 'debug_traffic']) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
        for (const [column, value] of Object.entries(row)) {
          assert.ok(!String(value).includes(sensitive), `${protocol}: private native diagnostic entered ${table}.${column}`)
        }
      }
    }
  } finally { db.close() }
  assert.ok(!logs.includes(sensitive), protocol + ' console diagnostics leaked')
  await assertFilesPrivate(home)
}
try {
  for (let turn = 0; turn < 100; turn++) {
    if ((await fetch(base + '/health').catch(() => null))?.ok) break
    await wait(150)
  }
  const session = await createFixturePanelSession(base, { username: 'native-admin', password: randomUUID() + 'Aa!' })
  auth = { 'x-panel-token': session.accessToken }
  await ok('/api/debug', { debugMode: true }, 'PUT', auth)
  await ok('/api/privacy', { enabled: true, personal: true, words: [sensitive] }, 'PUT', auth)
  for (const [protocol, path] of [['responses', '/v1/responses'], ['anthropic', '/v1/messages'], ['chat_completions', '/v1/chat/completions']]) {
    const channel = await ok('/api/custom-providers', { name: 'Native ' + protocol, protocol,
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      keyGroups: [{ id: 'fixture', enabled: true, apiKeys: ['native-upstream-fixture'], models: ['wire-safe'] }] })
    const model = 'Native-Private-' + protocol
    const catalog = await ok('/api/routing/groups')
    await ok('/api/routing/groups', { revision: catalog.newRevision, id: model,
      group: { id: model, model, name: model, enabled: true, strategy: 'order', sticky: 'off',
        members: [{ id: 'fixture', provider: channel.provider.id, model: 'wire-safe', included: true, accountScope: 'all', accounts: [] }] } }, 'PUT')
    for (const stream of [false, true]) {
      const body = { model, stream, max_tokens: 128, ...(protocol === 'responses'
        ? { input: sensitive } : { messages: [{ role: 'user', content: sensitive }] }) }
      const response = await call(path, body)
      assert.equal(response.status, 400, protocol + ' must preserve native error status')
      assert.ok(!(await response.text()).includes(sensitive), protocol + ' error response leaked')
      await wait(170)
      await assertPrivate(protocol + ' stream=' + stream)
    }
  }
  // A normal request with privacy disabled keeps the existing debug behavior.
  await ok('/api/privacy', { enabled: false }, 'PUT', auth)
  const baseline = await call('/v1/responses', { model: 'Native-Private-responses', input: 'ordinary request' })
  assert.equal(baseline.status, 400)
  assert.ok((await baseline.text()).includes(sensitive))
  await wait(170)
  const db = new DatabaseSync(join(home, 'agent2api.db'), { readOnly: true })
  try {
    assert.ok(db.prepare('SELECT response_body FROM debug_traffic').all().some(row => row.response_body?.includes(sensitive)),
      'ordinary debug capture must preserve upstream diagnostics')
  } finally { db.close() }
  console.log('PASS three native protocols x aggregate/stream: private diagnostic excluded from management, raw records, debug traffic, console, database and WAL; ordinary debug capture retained')
} finally {
  if (child.exitCode === null) child.kill()
  await ended
  await new Promise(resolve => upstream.close(resolve))
  if (process.env.KEEP_PRIVACY_FIXTURE) console.log('Privacy fixture retained: ' + home)
  else await rm(home, { recursive: true, force: true, maxRetries: 3 })
}
