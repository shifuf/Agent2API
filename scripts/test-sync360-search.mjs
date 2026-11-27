import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'

assert.ok(process.argv[2], 'Pass the agent2api-server executable')
const binary = path.resolve(process.argv[2])
await access(binary)
const home = await mkdtemp(path.join(os.tmpdir(), 'a2-search-keys-'))
const reservation = createServer().listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const root = `http://127.0.0.1:${port}`
const secrets = ['fixture-old-search-secret-123', 'fixture-new-search-secret-456']
const admin = 'fixture-search-admin'
const endpoint = '/api/tools/providers/tavily'
let child, closed, session
function masked(text) {
  for (const secret of secrets) assert.ok(!text.includes(secret), 'a fixture secret was disclosed')
}
async function api(url, body, method = body === undefined ? 'GET' : 'PUT', key) {
  const headers = key ? { authorization: `Bearer ${key}` } : session ? { 'x-panel-token': session } : {}
  const response = await fetch(root + url, { method, headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
  const text = await response.text()
  masked(text)
  const value = JSON.parse(text)
  return [response.status, value.success === true && Object.hasOwn(value, 'data') ? value.data : value]
}
async function start() {
  session = undefined
  child = spawn(binary, [], { cwd: home, windowsHide: true, stdio: 'ignore', env: { ...process.env,
    AGENT2API_UI_DIR: path.resolve(import.meta.dirname, '../desktop-tauri/ui'),
    AGENT2API_PROXY_HOME: home, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
    AGENT2API_PROXY_API_KEY: admin, AGENT2API_ACCOUNT_KEY: '4'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_CAPTCHA_ENABLED: '0',
    AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' } })
  closed = once(child, 'exit')
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break
    let registered
    try { registered = (await api('/api/panel/status'))[1].registered } catch { await delay(150); continue }
    const action = registered ? 'login' : 'setup'
    const [status, panel] = await api(`/api/panel/${action}?auth-mode=body`, { username: 'fixture-search-admin', password: 'fixture-login-only-123' }, 'POST')
    assert.equal(status, 200, `test panel ${action}: ${panel.error?.message || panel.error || status}`)
    assert.ok(panel.accessToken, 'test panel did not issue a session')
    session = panel.accessToken; return
  }
  throw new Error('temporary server did not start')
}
async function stop() {
  if (!child) return
  child.kill(); await closed; child = undefined
}
function stored(edit) {
  const db = new DatabaseSync(path.join(home, 'agent2api.db'))
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key=?').get('toolServices')
    masked(row.value)
    const data = JSON.parse(row.value)
    const provider = data.providers.tavily
    if (edit) { edit(provider); db.prepare('UPDATE kv SET value=? WHERE key=?').run(JSON.stringify(data), 'toolServices') }
    return provider
  } finally { db.close() }
}
async function list() {
  const [status, providers] = await api('/api/tools/providers')
  assert.equal(status, 200)
  return providers.find(provider => provider.provider === 'tavily')
}
async function checkBrowserEditors() {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true })
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ locale: 'zh-CN', viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }, isMobile: mobile, hasTouch: mobile })
      try {
        await context.route('**/*', route => new URL(route.request().url()).origin === root
          ? route.continue({ headers: { ...route.request().headers(), 'x-panel-token': session } }) : route.abort())
        await isolateUpdateNotice(context)
        await context.addInitScript(key => { localStorage.setItem('agent2api.webKey', key); localStorage.setItem('agent2api.webKey.origin', key) }, admin)
        const page = await context.newPage()
        const open = async () => {
          await page.goto(mobile ? `${root}/m#tools` : root)
          if (!mobile) {
            await page.locator('.nav-item[data-page="tools"]').click()
            await page.getByRole('row').filter({ hasText: '网络搜索' }).first().getByRole('button', { name: '详情', exact: true }).click()
          }
          await page.getByRole('button', { name: '编辑', exact: true }).first().click()
          return page.getByRole('dialog').filter({ hasText: 'Tavily' }).last()
        }
        const dialog = await open()
        const before = (await list()).keys.length
        if (mobile) await dialog.getByRole('button', { name: '移除', exact: true }).last().click()
        else {
          await dialog.getByRole('button', { name: '添加密钥', exact: true }).click()
          await dialog.locator('input[type="password"]').last().fill(secrets[1])
        }
        await Promise.all([page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'PUT' && response.ok()),
          dialog.getByRole('button', { name: '保存', exact: true }).click()])
        assert.equal((await list()).keys.length, before + (mobile ? -1 : 1))
        const reopened = await open()
        assert.equal(await reopened.locator('input[type="password"]').count(), before + (mobile ? -1 : 1))
        masked(await page.locator('body').innerText())
      } finally { await context.close() }
    }
  } finally { await browser.close() }
  console.log('PASS desktop and mobile search key editors: save, reload, remove')
}
try {
  await start()
  assert.equal((await api(endpoint, { enabled: true, api_key: secrets[0] }))[0], 200)
  await stop()
  stored(provider => {
    const key = provider.keys?.[0] || provider
    assert.ok(key.encryptedKey)
    Object.assign(provider, { encryptedKey: key.encryptedKey, keyHint: key.keyHint }); delete provider.keys
  })
  await start()
  const old = await list()
  assert.equal(old.keys?.length, 1, 'legacy encrypted search key must project as one ordered masked key')
  const id = old.keys[0].id
  if (process.argv.includes('--browser')) await checkBrowserEditors()
  assert.equal((await api(endpoint, { keys: [{ id }, { api_key: secrets[1] }] }))[0], 200)
  const added = await list()
  assert.deepEqual(added.keys.map(key => key.search.status), ['ready', 'ready'])
  assert.equal(added.keys[0].id, id)
  assert.equal((await api(endpoint, { keys: [{ id: 'missing-key' }] }))[0], 400)
  const ordinary = 'fixture-search-caller'
  assert.equal((await api('/api/keys', { name: 'fixture search caller', key: ordinary }, 'POST'))[0], 200)
  assert.ok([401, 403].includes((await api(endpoint, { keys: [] }, 'PUT', ordinary))[0]))
  assert.ok([401, 403].includes((await api(endpoint, { keys: [] }, 'PUT', admin))[0]))
  assert.ok([401, 403].includes((await api(endpoint + '/key', undefined, 'DELETE', ordinary))[0]))
  assert.ok([401, 403].includes((await api(endpoint + '/test?key_id=invalid', {}, 'POST', ordinary))[0]))
  await stop()
  assert.equal(stored().keys.length, 2)
  await start()
  assert.deepEqual((await list()).keys.map(key => key.id), added.keys.map(key => key.id))
  const reversed = added.keys.map(key => ({ id: key.id })).reverse()
  assert.equal((await api(endpoint, { keys: reversed }))[0], 200)
  assert.deepEqual((await list()).keys.map(key => key.id), reversed.map(key => key.id))
  assert.equal((await api(endpoint, { keys: [{ id: added.keys[1].id }] }))[0], 200)
  assert.equal((await list()).active_key_id, added.keys[1].id)
  secrets.push('p2@')
  assert.equal((await api(endpoint, { keys: [{ api_key: secrets[2] }] }))[0], 200)
  assert.equal((await api(endpoint + '/key', undefined, 'DELETE'))[0], 200)
  assert.equal((await list()).configured, false)
  console.log('PASS search key migration, ordering, masking, validation, permissions, persistence and removal')
} finally {
  await stop()
  await rm(home, { recursive: true, force: true, maxRetries: 5 })
}
