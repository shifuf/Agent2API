import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { createFixturePanelSession } from './fixtures/panel-session.mjs'

const directory = await mkdtemp(join(tmpdir(), 'oauth-storage-'))
const listener = createServer().listen(0, '127.0.0.1')
await once(listener, 'listening')
const port = listener.address().port
await new Promise(done => listener.close(done))
const base = `http://127.0.0.1:${port}`
const credentials = { username: 'oauth-storage-admin', password: randomUUID() + 'Aa!' }
const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: directory, AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: randomUUID(), AGENT2API_ACCOUNT_KEY: '7'.repeat(64), AGENT2API_CAPTCHA_ENABLED: '0', AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_UI_DIR: resolve(import.meta.dirname, '../desktop-tauri/ui') }
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
let child, exited, session
async function start() {
  child = spawn(resolve(process.argv[2]), [], { env, cwd: directory, windowsHide: true, stdio: 'ignore' })
  exited = once(child, 'exit')
  for (let turn = 0; turn < 100; turn++) {
    if ((await fetch(base + '/health').catch(() => null))?.ok) return
    await delay(100)
  }
  throw Error('OAuth storage fixture did not start')
}
async function stop() { if (child?.exitCode === null) child.kill(); if (exited) await exited; child = null }
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-panel-token': session.accessToken }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  const payload = await response.json()
  assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(payload)}`)
  return payload.data
}
async function findDatabase(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.name === 'agent2api.db') return file
    if (entry.isDirectory()) { const nested = await findDatabase(file); if (nested) return nested }
  }
}
try {
  await start()
  session = await createFixturePanelSession(base, credentials)
  await request('/api/panel-oauth', 'PUT', { provider: 'google', origin: 'https://legacy.example.test', enabled: true, clientId: 'legacy-client', secret: 'legacy-secret' })
  await request('/api/panel/oauth/settings', 'PUT', { publicBaseUrl: 'https://external.example.test', google: { enabled: true, clientId: 'external-client', clientSecret: 'external-secret', allowedEmails: ['admin@example.test'] } })
  assert.equal((await request('/api/panel-oauth')).google.clientId, 'legacy-client')
  assert.equal((await request('/api/panel/oauth/settings')).google.clientId, 'external-client')
  await stop()
  await start()
  session = await createFixturePanelSession(base, credentials, 'login')
  assert.equal((await request('/api/panel-oauth')).google.clientId, 'legacy-client')
  assert.equal((await request('/api/panel/oauth/settings')).google.clientId, 'external-client')
  await stop()
  const database = new DatabaseSync(await findDatabase(directory))
  try {
    const legacy = JSON.parse(database.prepare('SELECT value FROM kv WHERE key=?').get('panelOauth').value)
    const external = JSON.parse(database.prepare('SELECT value FROM kv WHERE key=?').get('panelOauthExternal').value)
    assert.equal(legacy.version, 1)
    assert.ok(legacy.settingsEnc.startsWith('enc1:'))
    assert.ok(external.google.clientSecretEnc.startsWith('enc1:'))
    assert.ok(!JSON.stringify([legacy, external]).includes('external-secret'))
    database.prepare('DELETE FROM kv WHERE key=?').run('panelOauthExternal')
    database.prepare('UPDATE kv SET value=? WHERE key=?').run(JSON.stringify(external), 'panelOauth')
  } finally { database.close() }
  await start()
  session = await createFixturePanelSession(base, credentials, 'login')
  assert.equal((await request('/api/panel/oauth/settings')).google.clientId, 'external-client')
  assert.equal((await request('/api/panel-oauth')).google.enabled, false)
  console.log('PASS independent legacy/external OAuth storage, restart persistence, encrypted secrets, upstream storage migration')
} finally { await stop(); await rm(directory, { recursive: true, force: true, maxRetries: 4 }) }
