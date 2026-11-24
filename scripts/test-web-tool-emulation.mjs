// Real management authentication and persistence against a disposable server.
// node scripts/test-web-tool-emulation.mjs <agent2api-server>
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { createFixturePanelSession } from './fixtures/panel-session.mjs'

const binary = path.resolve(process.argv[2] || '')
assert.ok(process.argv[2], 'Pass a built server binary')
await access(binary)
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-web-tools-'))
const reserve = net.createServer().listen(0, '127.0.0.1')
await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const base = `http://127.0.0.1:${port}`
const credentials = { username: 'fixture-web-tools-admin', password: randomUUID() + '.Tools!' }
const env = { ...process.env, AGENT2API_PROXY_HOME: directory, AGENT2API_HOST: '127.0.0.1',
  AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: 'fixture-web-tools-bootstrap-key',
  AGENT2API_ACCOUNT_KEY: '6'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0',
  AGENT2API_CAPTCHA_ENABLED: '0' }
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
let child, exited, administrator, output = ''
function start() {
  child = spawn(binary, [], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(child, 'exit')
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-20_000) })
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-20_000) })
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, output)
    try { if ((await fetch(base + '/health')).ok) return } catch {}
    await pause(200)
  }
  throw new Error('Fixture server did not start: ' + output)
}
async function stop() { if (child?.exitCode === null) { child.kill(); await exited } }
async function request(endpoint, body, authorization = administrator, method = body === undefined ? 'GET' : 'PUT') {
  const headers = { 'Content-Type': 'application/json' }
  if (typeof authorization === 'string') headers.Authorization = 'Bearer ' + authorization
  else if (authorization?.accessToken) headers['x-panel-token'] = authorization.accessToken
  const response = await fetch(base + endpoint, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) })
  const value = await response.json()
  return { status: response.status, body: value.success === true && Object.hasOwn(value, 'data') ? value.data : value }
}
async function settings() {
  const result = await request('/api/web-tool-emulation')
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body
}

try {
  start(); await ready()
  administrator = await createFixturePanelSession(base, credentials)
  assert.equal((await settings()).enabled, true)
  assert.deepEqual((await settings()).providers, [], 'No absent guest receives an invented contract')
  for (const body of [{}, { enabled: 'true' }, { enabled: true, extra: true }]) {
    assert.equal((await request('/api/web-tool-emulation', body)).status, 400)
    assert.equal((await settings()).enabled, true, 'Invalid writes must not mutate the setting')
  }
  console.log('PASS default declaration boundary and strict boolean writes')

  const unrestricted = await request('/api/keys', { name: 'Web tools unrestricted' }, administrator, 'POST')
  assert.equal(unrestricted.status, 200)
  const restricted = await request('/api/keys', { name: 'Web tools restricted', allowedProviders: ['workbuddy'] }, administrator, 'POST')
  assert.equal(restricted.status, 200)
  for (const method of ['GET', 'PUT']) {
    const body = method === 'PUT' ? { enabled: false } : undefined
    for (const authorization of [null, 'unknown-fixture-key']) {
      assert.equal((await request('/api/web-tool-emulation', body, authorization, method)).status, 401)
    }
    const denied = await request('/api/web-tool-emulation', body, restricted.body.created.key, method)
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'management_access_denied')
    assert.equal((await settings()).enabled, true)
  }
  console.log('PASS missing, invalid and restricted Key rejection without mutation')

  assert.equal((await request('/api/web-tool-emulation', { enabled: false }, unrestricted.body.created.key)).status, 200)
  assert.equal((await settings()).enabled, false)
  assert.equal((await request('/api/web-tool-emulation', undefined, unrestricted.body.created.key)).status, 200)
  await stop(); start(); await ready()
  administrator = await createFixturePanelSession(base, credentials, 'login')
  assert.equal((await settings()).enabled, false, 'A real restart must retain the saved switch')
  assert.equal((await request('/api/web-tool-emulation', { enabled: true })).status, 200)
  assert.equal((await settings()).enabled, true)
  console.log('PASS real administrator and unrestricted Key access, restart persistence and restoration')
} finally {
  await stop()
  const target = path.resolve(directory)
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
  assert.ok(path.basename(target).startsWith('agent2api-web-tools-'))
  await rm(target, { recursive: true, force: true })
}
