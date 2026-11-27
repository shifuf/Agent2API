import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { createFixturePanelSession, installFixturePanelSession } from './fixtures/panel-session.mjs'

const root = resolve(import.meta.dirname, '..')
const home = await mkdtemp(join(tmpdir(), 'agent2api-branding-'))
const reservation = createServer().listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: home, AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: 'fixture-brand-key', AGENT2API_CAPTCHA_ENABLED: '0', AGENT2API_ACCOUNT_KEY: '6'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_UI_DIR: join(root, 'desktop-tauri/ui') }
for (const key of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[key]
let child, exited
async function start() {
  child = spawn(resolve(process.argv[2]), [], { cwd: home, env, stdio: 'ignore', windowsHide: true })
  exited = once(child, 'exit')
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited: ${child.exitCode}`)
    if ((await fetch(base + '/health').catch(() => null))?.ok) return
    await wait(200)
  }
  throw new Error('Fixture server not ready')
}
async function stop() { if (child?.exitCode === null) child.kill(); await exited }
const publicPath = '/api/panel/branding'
const put = (path, body, headers = {}) => fetch(base + path, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const read = async () => { const response = await fetch(base + publicPath); assert.equal(response.status, 200, 'public branding endpoint'); return (await response.json()).data }
async function verifyBrowser(session, site) {
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE })
  try {
    const guest = await browser.newContext({ locale: 'en-US' })
    const login = await guest.newPage()
    await login.goto(base + '/login'); await login.getByRole('heading', { name: site.displayName, exact: true }).waitFor()
    assert.equal(await login.locator(`img[src$="${site.logoUrl}"]`).count(), 1)
    await guest.route('**/api/panel/branding', route => route.fulfill({ status: 404, body: '' }))
    await login.reload(); await login.getByRole('heading', { name: 'Agent2API', exact: true }).waitFor()
    await guest.close()
    const packaged = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 } })
    await packaged.addInitScript(origin => {
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => false, Plugins: {} }
      localStorage.setItem('agent2api.servers', JSON.stringify([{ id: 'fixture', name: 'Fixture', base: origin }]))
      localStorage.setItem('agent2api.activeServer', 'fixture')
    }, base)
    const apk = await packaged.newPage(); await apk.goto(base + '/m')
    await apk.getByRole('heading', { name: new RegExp(site.displayName) }).filter({ visible: true }).first().waitFor()
    await apk.locator('input[type="password"]').waitFor({ state: 'visible' }); await apk.locator(`img[src$="${site.logoUrl}"]:visible`).first().waitFor()
    await packaged.close()
    const context = await browser.newContext({ locale: 'en-US' })
    await installFixturePanelSession(context, base, session, env.AGENT2API_PROXY_API_KEY)
    const page = await context.newPage(); await page.goto(base + '/')
    await page.getByRole('heading', { name: site.displayName, exact: true }).waitFor()
    await page.locator('.nav-item[data-page="settings"]').click()
    await page.locator('#settings-nav [data-cat="display"]').click()
    const desktop = page.locator('[data-cat="display"] fieldset').filter({ has: page.locator('input[type="file"]') })
    await desktop.locator('input[maxlength="64"]').fill('Desktop fixture')
    await desktop.locator('button').first().click()
    try { await page.getByRole('heading', { name: 'Desktop fixture', exact: true }).waitFor({ timeout: 8000 }) }
    catch (error) { throw new Error(`Desktop save: output=${await desktop.locator('output').textContent()} serverName=${(await read()).displayName} bridge=${await page.evaluate(() => typeof window.workbuddyDesktop?.saveBranding)}`, { cause: error }) }
    const mobile = await context.newPage(); await mobile.setViewportSize({ width: 390, height: 844 }); await mobile.goto(base + '/m#settings')
    const editor = mobile.locator('fieldset').filter({ has: mobile.locator('input[type="file"]') })
    await editor.locator('input[maxlength="64"]').fill('Mobile fixture'); await editor.locator('button').first().click()
    await mobile.waitForFunction(() => document.title.includes('Mobile fixture'))
    await page.reload(); await page.getByRole('heading', { name: 'Mobile fixture', exact: true }).waitFor()
    assert.deepEqual(await read(), { ...site, displayName: 'Mobile fixture' })
    await context.close(); console.log('PASS web login/fallback, simulated packaged mobile login, desktop and mobile brand editors, cross-client refresh')
  } finally { await browser.close() }
}
try {
  await start()
  const defaults = { displayName: 'Agent2API', logoUrl: null }
  assert.deepEqual(await read(), defaults)
  const credentials = { username: 'branding-admin', password: 'fixture-brand-password' }
  let session = await createFixturePanelSession(base, credentials)
  const auth = { Cookie: `${session.cookie.name}=${session.cookie.value}` }
  for (const headers of [{}, { 'x-api-key': env.AGENT2API_PROXY_API_KEY }]) assert.ok([401, 403].includes((await put('/api/branding', { displayName: 'No' }, headers)).status))
  assert.notEqual((await put(publicPath, { displayName: 'No' }, auth)).status, 200)
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgZGL+DwABFAEG1rmmRQAAAABJRU5ErkJggg==', 'base64')
  const unsafe = 'untrusted-trailing-data'
  const image = 'data:image/png;base64,' + Buffer.concat([original, Buffer.from(unsafe)]).toString('base64')
  const saved = await put('/api/branding', { displayName: ' My Site ', logo: image }, auth)
  assert.equal(saved.status, 200, await saved.text())
  const brand = await read()
  assert.equal(brand.displayName, 'My Site'); assert.match(brand.logoUrl, /^\/api\/panel\/branding\/logo\?v=[a-f0-9]{64}$/)
  const icon = await fetch(base + brand.logoUrl)
  assert.equal(icon.headers.get('content-type'), 'image/png'); assert.equal(icon.headers.get('x-content-type-options'), 'nosniff')
  assert.ok(!Buffer.from(await icon.arrayBuffer()).includes(Buffer.from(unsafe)))
  assert.equal((await fetch(base + brand.logoUrl, { headers: { 'if-none-match': icon.headers.get('etag') } })).status, 304)
  for (const invalid of [{ logo: 'data:image/svg+xml;base64,PHN2Zy8+' }, { logo: 'https://example.invalid/logo' }, { logo: image.replace('image/png', 'image/jpeg') }, { displayName: 'a\nb' }]) assert.equal((await put('/api/branding', invalid, auth)).status, 400)
  assert.equal((await put('/api/captcha', { captchaDesktop: false, captchaWeb: false }, auth)).status, 200)
  await stop(); await start(); session = await createFixturePanelSession(base, credentials, 'login'); auth.Cookie = `${session.cookie.name}=${session.cookie.value}`
  assert.deepEqual(await read(), brand)
  if (process.argv.includes('--browser')) await verifyBrowser(session, brand)
  assert.equal((await put('/api/branding', { logo: null, displayName: null }, auth)).status, 200)
  assert.deepEqual(await read(), defaults); assert.equal((await fetch(base + publicPath + '/logo')).status, 404)
  console.log('PASS public/admin split, normalized logo, invalid uploads, ETag, atomic patch, config rewrite, restart and reset')
} finally {
  await stop()
  await rm(home, { force: true, recursive: true, maxRetries: 3 })
}
