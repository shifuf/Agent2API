import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { createFixturePanelSession } from './fixtures/panel-session.mjs'

const binary = resolve(process.argv[2])
const seedBinary = resolve(process.argv[3] || process.argv[2])
const home = await mkdtemp(join(tmpdir(), 'agent2api-captcha-authority-'))
const reservation = createServer().listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const base = `http://127.0.0.1:${port}`
const secret = randomUUID(), replacementSecret = randomUUID()
const destinationKey = randomBytes(32), destinationPath = join(home, 'panel-captcha.key')
const credentials = { username: 'captcha-fixture', password: randomUUID() + 'Aa!' }
const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: home,
  AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: randomUUID(),
  AGENT2API_ACCOUNT_KEY: '8'.repeat(64), AGENT2API_CAPTCHA_ENABLED: '0',
  AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0' }
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
let child, exit, logs = '', auth = {}
const checks = []
async function start(executable) {
  child = spawn(executable, [], { env, cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  exit = once(child, 'exit')
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', bytes => { logs += bytes.toString() })
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fetch(base + '/health').catch(() => null))?.ok) return
    if (child.exitCode !== null) throw Error('Fixture server exited before health')
    await wait(100)
  }
  throw Error('Fixture server did not become healthy')
}
async function stop() { if (child?.exitCode === null) child.kill(); if (exit) await exit }
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { ...auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  const json = await response.json()
  return { status: response.status, data: json.data ?? json, json }
}
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); console.log('PASS', name) }
  catch (error) { checks.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message) }
}
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) await inspect(file)
    else {
      const bytes = await readFile(file)
      assert.ok(!bytes.includes(Buffer.from(secret)) && !bytes.includes(Buffer.from(replacementSecret)), 'Stored verifier secret must remain encrypted')
    }
  }
}
function slots() {
  const output = execFileSync(process.env.PYTHON || 'python', ['-c',
    "import sqlite3,json,sys; con=sqlite3.connect(sys.argv[1]); print(json.dumps(dict(con.execute(\"SELECT key,value FROM kv WHERE key IN ('panelCaptcha','panelTurnstile')\"))))", join(home, 'agent2api.db')], { windowsHide: true, encoding: 'utf8' })
  return JSON.parse(output)
}
function decrypt(envelope, key) {
  assert.ok(envelope.startsWith('enc1:'))
  const blob = Buffer.from(envelope.slice(5), 'base64')
  const cipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12))
  cipher.setAuthTag(blob.subarray(-16))
  return Buffer.concat([cipher.update(blob.subarray(12, -16)), cipher.final()]).toString('utf8')
}
try {
  await start(seedBinary)
  auth = { 'x-panel-token': (await createFixturePanelSession(base, credentials)).accessToken }
  const legacy = { provider: 'turnstile', siteKey: 'legacy-public', secret,
    widgetOrigin: 'https://fixture.invalid', hostnames: ['fixture.invalid'] }
  assert.equal((await request('/api/captcha/turnstile', 'PUT', legacy)).status, 200)
  await stop()
  const original = slots().panelTurnstile
  assert.ok(original, 'The seed binary must store the original legacy ciphertext')
  await writeFile(destinationPath, 'invalid-existing-key')
  await start(binary)
  auth = { 'x-panel-token': (await createFixturePanelSession(base, credentials, 'login')).accessToken }
  await check('failed key migration leaves legacy ciphertext and destination key untouched', async () => {
    assert.equal((await request('/api/captcha')).status, 503)
    assert.equal(slots().panelTurnstile, original)
    assert.equal(slots().panelCaptcha, undefined)
    assert.equal(await readFile(destinationPath, 'utf8'), 'invalid-existing-key')
    assert.equal((await request('/api/captcha', 'PUT', { captchaEnabled: false })).status, 200, 'A broken verifier key must not prevent disabling CAPTCHA')
  })
  await stop()
  await writeFile(destinationPath, destinationKey)
  await start(binary)
  auth = { 'x-panel-token': (await createFixturePanelSession(base, credentials, 'login')).accessToken }
  await check('legacy ciphertext survives restart and new editor retains omitted secret', async () => {
    const loaded = await request('/api/captcha')
    assert.equal(loaded.data.captchaProvider, 'turnstile')
    assert.equal(loaded.data.turnstileSecretSet, true)
    const saved = await request('/api/captcha', 'PUT', { captchaProvider: 'turnstile', turnstileSiteKey: 'migrated-public', turnstileHostnames: ['fixture.invalid'] })
    assert.equal(saved.status, 200, 'Saving a previously configured secret without entering it again must succeed')
    assert.equal(saved.data.turnstileSecretSet, true)
    assert.equal(slots().panelTurnstile, original)
    assert.equal(decrypt(JSON.parse(slots().panelCaptcha).secretKey, destinationKey), secret)
    assert.deepEqual(await readFile(destinationPath), destinationKey)
  })
  assert.equal((await request('/api/captcha', 'PUT', { captchaProvider: 'altcha' })).status, 200)
  await check('old save updates effective provider and new editor', async () => {
    assert.equal((await request('/api/captcha/turnstile', 'PUT', legacy)).status, 200)
    assert.equal((await request('/api/panel/status')).data.captchaProvider, 'turnstile')
    assert.equal((await request('/api/captcha')).data.captchaProvider, 'turnstile')
  })
  await check('toggle response preserves effective provider and stored secret', async () => {
    const toggled = await request('/api/captcha', 'PUT', { captchaWeb: true })
    assert.equal(toggled.status, 200)
    assert.equal(toggled.data.captchaProvider, 'turnstile')
    assert.equal(toggled.data.turnstileSecretSet, true)
    assert.equal((await request('/api/panel/status')).data.captchaProvider, 'turnstile')
  })
  await check('new save is reflected by compatible old API without leaking secret', async () => {
    const saved = await request('/api/captcha', 'PUT', { captchaProvider: 'turnstile', turnstileSiteKey: 'new-public', turnstileSecretKey: replacementSecret, turnstileHostnames: ['fixture.invalid'] })
    assert.equal(saved.status, 200)
    const old = await request('/api/captcha/turnstile')
    assert.equal(old.data.siteKey, 'new-public')
    assert.equal(old.data.hasSecret, true)
    assert.equal(old.data.widgetOrigin, 'https://fixture.invalid')
    assert.ok(!JSON.stringify(old.json).includes(replacementSecret))
    assert.equal(decrypt(JSON.parse(slots().panelCaptcha).secretKey, destinationKey), replacementSecret)
    assert.equal(slots().panelTurnstile, original)
  })
  await check('old recovery to ALTCHA changes login and keeps upstream toggle contract', async () => {
    assert.equal((await request('/api/captcha/turnstile', 'PUT', { provider: 'altcha' })).status, 200)
    assert.equal((await request('/api/panel/status')).data.captchaProvider, 'altcha')
    assert.ok((await request('/api/panel/captcha')).json.signature)
    assert.equal((await request('/api/captcha', 'PUT', { captchaEnabled: false })).status, 200)
    const settings = (await request('/api/captcha')).data
    assert.equal(settings.captchaDesktop, false)
    assert.equal(settings.captchaWeb, false)
    await createFixturePanelSession(base, credentials, 'login')
  })
  await stop()
  await check('all saved verifier secrets stay encrypted', async () => { await inspect(home); assert.ok(!logs.includes(secret) && !logs.includes(replacementSecret)) })
} finally {
  await stop()
  await writeFile(join(home, 'server.log'), logs)
  await writeFile(join(home, 'acceptance.json'), JSON.stringify({ binary, seedBinary, checks }, null, 2))
  console.log('REPORT', home)
}
if (checks.some(check => !check.passed)) process.exitCode = 1
