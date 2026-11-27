import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { setTimeout as pause } from 'node:timers/promises'
import { createFixturePanelSession, installFixturePanelSession } from './fixtures/panel-session.mjs'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'

const binary = process.argv[2] || process.env.AGENT2API_SERVER_BIN
assert.ok(binary, 'Usage: node scripts/test-sync360-notifications.mjs <agent2api-server>')
const home = await mkdtemp(path.join(tmpdir(), 'agent2api-notify-'))
const admin = 'fixture-admin-key'
const credentials = { username: 'operator', password: 'fixture-login-password' }
const marker = 'synthetic-notification-private-marker'
const records = []
let rejected = false
const sink = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  records.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)), tag: req.headers['x-fixture'], method: req.method })
  if (rejected === 'stall') return
  res.writeHead(rejected ? 403 : 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(rejected
    ? { message: marker + '-echo' } : { code: 200, ok: true }))
})
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
const sinkUrl = `http://127.0.0.1:${await listen(sink)}`
const reserve = createServer()
const port = await listen(reserve)
await close(reserve)
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, AGENT2API_PROXY_HOME: home, AGENT2API_PROXY_PORT: String(port), AGENT2API_HOST: '127.0.0.1',
  AGENT2API_UI_DIR: process.env.AGENT2API_UI_DIR || path.resolve(import.meta.dirname, '../desktop-tauri/ui'),
  AGENT2API_PROXY_API_KEY: admin, AGENT2API_ACCOUNT_KEY: '5'.repeat(64), AGENT2API_SELF_UPDATE: '0',
  AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_CAPTCHA_ENABLED: '0', NO_PROXY: '127.0.0.1,localhost' }
for (const key of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[key]
const app = spawn(path.resolve(binary), [], { cwd: home, env, windowsHide: true, stdio: 'ignore' })
const done = once(app, 'exit')
async function call(url, method, headers, payload) {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(20000) })
  const text = await response.text()
  assert.ok(!text.includes(marker), 'no notification secrets or provider error body in any management reply')
  let json
  try { json = JSON.parse(text) } catch {}
  return { status: response.status, data: json?.data ?? json }
}
try {
  for (let attempt = 0; ; attempt++) {
    assert.ok(app.exitCode === null && attempt < 120, 'fixture server unavailable')
    try { if ((await fetch(base + '/health')).ok) break } catch {}
    await pause(250)
  }
  const session = await createFixturePanelSession(base, credentials)
  const headers = { Cookie: `${session.cookie.name}=${session.cookie.value}` }
  const route = '/api/notifications'
  const current = await call(route, 'GET', headers)
  assert.equal(current.status, 200, 'administrator can open notification settings')
  assert.equal(current.data?.enabled, false)
  const key = (await call('/api/keys', 'POST', headers, { name: 'ordinary gateway key' })).data.created.key
  for (const [method, endpoint, payload] of [['GET', route], ['PUT', route, { enabled: true }], ['POST', route + '/test', { channel: 'bark' }]]) {
    assert.ok((await call(endpoint, method, { 'x-api-key': key }, payload)).status >= 400)
  }
  const config = { enabled: false, events: { loginFailure: true, loginSuccess: true, checkinFailure: true }, channels: {
    webhook: { enabled: true, url: `${sinkUrl}/hook/${marker}`, headers: { 'X-Fixture': marker + '-header' } },
    telegram: { enabled: true, apiBase: sinkUrl, botToken: marker + '-bot', chatId: marker + '-chat' },
    bark: { enabled: true, serverUrl: sinkUrl, deviceKey: marker + '-device', group: 'test-group' },
  } }
  const saved = await call(route, 'PUT', headers, config)
  assert.equal(saved.status, 200)
  assert.equal(saved.data.channels.webhook.urlSet, true)
  assert.equal(saved.data.channels.telegram.botTokenSet, true)
  assert.equal(saved.data.channels.bark.deviceKeySet, true)
  assert.equal((await call('/api/panel/login', 'POST', {}, { ...credentials, password: 'incorrect' })).status, 401)
  await pause(400)
  assert.equal(records.length, 0, 'disabled notifications emit no automatic traffic')
  for (const channel of ['webhook', 'telegram', 'bark']) {
    const result = await call(route + '/test', 'POST', headers, { channel })
    assert.equal(result.status, 200)
    assert.equal(result.data.sent, true)
  }
  assert.deepEqual(records.map(record => record.method), ['POST', 'POST', 'POST'])
  assert.equal(records[0].url, `/hook/${marker}`)
  assert.equal(records[0].tag, marker + '-header')
  assert.equal(records[0].body.event, 'test')
  assert.equal(records[1].url, `/bot${marker}-bot/sendMessage`)
  assert.equal(records[1].body.chat_id, marker + '-chat')
  assert.equal(records[2].url, '/push')
  assert.equal(records[2].body.device_key, marker + '-device')
  assert.equal(records[2].body.group, 'test-group')
  rejected = true
  for (const channel of ['webhook', 'telegram', 'bark']) {
    assert.equal((await call(route + '/test', 'POST', headers, { channel })).status, 502)
  }
  rejected = 'stall'
  const beforeTimeout = Date.now()
  assert.equal((await call(route + '/test', 'POST', headers, { channel: 'webhook' })).status, 502)
  assert.ok(Date.now() - beforeTimeout < 12500, 'stalled channel is bounded')
  rejected = false
  records.length = 0
  assert.equal((await call(route, 'PUT', headers, { enabled: true })).status, 200)
  assert.equal((await call('/api/panel/login', 'POST', {}, { ...credentials, password: 'incorrect' })).status, 401)
  await createFixturePanelSession(base, credentials, 'login')
  for (let count = 0; count < 80 && records.length < 6; count++) await pause(50)
  await pause(150)
  assert.equal(records.length, 6)
  assert.deepEqual(records.filter(row => row.url.startsWith('/hook/')).map(row => row.body.event).sort(), ['login_failure', 'login_success'])
  console.log('PASS admin-only settings, encrypted write-only fields, three protocols, sanitized failures, disabled silence and exactly-once login events')
  if (process.argv.includes('--browser')) {
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
    try {
      for (const mobile of [false, true]) {
        const context = await browser.newContext({ locale: 'zh-CN', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: mobile })
        await installFixturePanelSession(context, base, session, admin)
        await isolateUpdateNotice(context)
        const page = await context.newPage()
        const openPanel = async () => {
          await page.goto(mobile ? `${base}/m#settings` : base)
          if (!mobile) {
            await page.locator('.nav-item[data-page="settings"]').click()
            await page.locator('.settings-nav-item[data-cat="gateway"]').click()
          }
          await page.locator('[data-notification-settings] > button').click()
          const panel = page.locator('[data-notification-settings]')
          await panel.locator('input[type="password"]').first().waitFor()
          assert.equal(await panel.locator('input[type="password"]').evaluateAll(nodes => nodes.some(node => node.value)), false)
          return panel
        }
        let panel = await openPanel()
        const enabled = panel.locator('input[type="checkbox"]').first()
        assert.equal(await enabled.isChecked(), !mobile)
        await enabled.click()
        const saved = page.waitForResponse(res => res.url().endsWith('/api/notifications') && res.request().method() === 'PUT')
        await panel.getByRole('button', { name: /^(保存|save)$/i }).click()
        assert.equal((await saved).status(), 200)
        await page.goto('about:blank')
        panel = await openPanel()
        assert.equal(await panel.locator('input[type="checkbox"]').first().isChecked(), mobile)
        const sent = page.waitForResponse(res => res.url().endsWith('/api/notifications/test'))
        await panel.getByRole('button', { name: /测试发送|send test/i }).first().click()
        assert.equal((await sent).status(), 200)
        await context.close()
        console.log('PASS', mobile ? 'mobile' : 'desktop', 'notifications: open, edit, reload, masked values and send test')
      }
    } finally { await browser.close() }
  }
} finally {
  if (app.exitCode === null) app.kill()
  await done
  await close(sink)
  try {
    for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const bytes = await readFile(path.join(entry.parentPath, entry.name))
      assert.ok(!bytes.includes(marker), 'no notification credentials or echoed errors in logs, database or WAL')
    }
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 3 }) }
}
