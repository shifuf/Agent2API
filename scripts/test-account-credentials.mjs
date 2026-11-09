import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'

// Real HTTP and browser behavior, using only disposable accounts and synthetic secrets.
const root = path.resolve(import.meta.dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent2api-credentials-'))
const binary = process.env.AGENT2API_SERVER_BIN || path.join(root, 'target/debug/agent2api-server.exe')
const reserve = net.createServer().listen(0, '127.0.0.1')
await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const base = `http://127.0.0.1:${port}`
const admin = 'fixture-credential-admin'
const savedKey = 'fixture-saved-api-key-123456'
const env = { ...process.env, AGENT2API_PROXY_HOME: home, AGENT2API_PROXY_PORT: String(port), AGENT2API_HOST: '127.0.0.1',
  AGENT2API_UI_DIR: path.join(root, 'desktop-tauri/ui'), AGENT2API_PROXY_API_KEY: admin, AGENT2API_ACCOUNT_KEY: '3'.repeat(64),
  AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_CAPTCHA_ENABLED: '0' }
for (const key of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[key]
const log = fs.openSync(path.join(home, 'server.log'), 'a')
const server = spawn(binary, [], { cwd: home, env, windowsHide: true, stdio: ['ignore', log, log] })
const exited = once(server, 'exit')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function request(url, body, key = admin, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + url, { method, headers: { ...(key ? { 'x-api-key': key } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  const data = await response.json()
  return { status: response.status, cache: response.headers.get('cache-control'), data: data.success === true ? data.data : data }
}
async function api(url, body, method) {
  const result = await request(url, body, admin, method)
  assert.equal(result.status, 200, `Unexpected status for ${url}`)
  return result.data
}
let browser
try {
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error('Fixture server exited')
    try { if ((await fetch(base + '/health')).ok) { ready = true; break } } catch {}
    await pause(500)
  }
  assert(ready, 'Fixture server unavailable')
  const channel = (await api('/api/custom-providers', { name: 'Credential test channel', protocol: 'chat_completions', baseUrl: 'http://127.0.0.1:1/v1',
    keyGroups: [{ id: 'test-group', name: 'Test', enabled: true, apiKeys: [savedKey], models: ['upstream-a'] }] })).provider
  const id = (await api('/api/custom-providers')).providers.find(provider => provider.id === channel.id).keyGroups[0].accountIds[0]
  const endpoint = `/api/accounts/${encodeURIComponent(id)}/credentials`
  const details = await request(endpoint)
  assert.equal(details.status, 200, 'Explicit credential read must succeed for the administrator')
  assert.equal(details.cache, 'no-store')
  assert.deepEqual(details.data.fields, [{ key: 'apiKey', value: savedKey }])
  assert.equal(details.data.id, id)
  assert.equal((await request('/api/accounts/missing-fixture/credentials')).status, 404)
  assert.ok((await request(endpoint, undefined, '')).status >= 400)
  const unrestricted = (await api('/api/keys', { name: 'Ordinary gateway key' })).created.key
  const restricted = (await api('/api/keys', { name: 'Restricted gateway key', allowedProviders: [channel.id] })).created.key
  for (const key of [unrestricted, restricted]) assert.equal((await request(endpoint, undefined, key)).status, 403)
  for (const url of ['/api/accounts', '/api/session', '/api/custom-providers']) {
    assert.ok(!JSON.stringify(await api(url)).includes(savedKey), `${url} must remain redacted`)
  }
  await api(`/api/accounts/${id}`, { enabled: false }, 'PATCH')
  assert.equal((await api(endpoint)).fields[0].value, savedKey, 'Disabled credentials remain inspectable')
  await api(`/api/accounts/${id}`, { enabled: true }, 'PATCH')
  const imported = await api('/api/accounts/import', { accounts: [{ id: 'fixture-plugin', provider: 'workbuddy', name: 'Plugin credential fixture',
    uid: 'fixture-identity', accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token',
    pluginSecret: { auth: { accessToken: 'fixture-nested-token' }, session: { cookie: 'fixture-cookie' } } }] })
  assert.equal(imported.failed, 0, 'Plugin fixture import')
  const plugin = await api(`/api/accounts/${imported.importedIds[0]}/credentials`)
  assert.equal(plugin.fields.find(field => field.key === 'accessToken').value, 'fixture-access-token')
  assert.deepEqual(JSON.parse(plugin.fields.find(field => field.key === 'pluginSecret').value),
    { auth: { accessToken: 'fixture-nested-token' }, session: { cookie: 'fixture-cookie' } })
  console.log('PASS single-account reads, redaction, no-store, auth rejection, disabled and plugin accounts')

  if (process.argv.includes('--balance')) {
    const result = await api('/api/accounts/import', { accounts: [{ id, provider: channel.id, apiKey: savedKey,
      balanceQuery: { accessToken: 'fixture-query-access', password: 'fixture-query-password', token: 'fixture-query-token', username: 'fixture-query-user' } }] })
    assert.equal(result.failed, 0)
    const queryDetails = await api(endpoint)
    assert.deepEqual(queryDetails.fields.filter(field => field.key.startsWith('balanceQuery.')), [
      { key: 'balanceQuery.accessToken', value: 'fixture-query-access' },
      { key: 'balanceQuery.password', value: 'fixture-query-password' },
      { key: 'balanceQuery.token', value: 'fixture-query-token' },
    ])
    console.log('PASS saved balance query credentials are inspectable')
  }

  if (!process.argv.includes('--api-only')) {
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })
    await context.addInitScript(key => { localStorage.setItem('agent2api.webKey', key); localStorage.setItem('agent2api.webKey.origin', key) }, admin)
    const page = await context.newPage()
    let reads = 0
    page.on('request', req => { if (req.url().endsWith('/credentials')) reads++ })
    await page.goto(base)
    await page.locator('.nav-item[data-page="accounts"]').click()
    const open = async () => {
      await page.locator('.acct-actions').getByRole('button', { name: '设置', exact: true }).first().click()
      await page.getByRole('button', { name: '凭证设置', exact: true }).click()
    }
    await open()
    assert.equal(reads, 0, 'Opening settings must not fetch secrets')
    await page.getByRole('button', { name: '查看密钥详情', exact: true }).click()
    const value = page.locator('[data-credential-value="apiKey"]')
    await value.waitFor()
    assert.equal(await value.inputValue(), savedKey)
    assert.equal(await page.locator('#account-api-key-input').inputValue(), '', 'Reveal must not fill the replacement draft')
    await page.getByRole('button', { name: '复制 API Key', exact: true }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), savedKey)
    await page.getByRole('button', { name: '隐藏密钥详情', exact: true }).click()
    await value.waitFor({ state: 'hidden' })
    assert.ok(!(await page.content()).includes(savedKey))
    await page.getByRole('button', { name: '查看密钥详情', exact: true }).click()
    await value.waitFor()
    await page.locator('.acct-settings-dialog').getByRole('button', { name: '取消', exact: true }).click()
    await open()
    assert.equal(await value.count(), 0, 'Reopening must clear revealed details')
    const beforeLate = reads
    let release
    const delayed = new Promise(resolve => { release = resolve })
    await page.route('**/credentials', async route => { const response = await route.fetch(); await delayed; await route.fulfill({ response }) })
    await page.getByRole('button', { name: '查看密钥详情', exact: true }).click()
    await page.waitForTimeout(150)
    await page.getByRole('button', { name: '隐藏密钥详情', exact: true }).click()
    release()
    await page.waitForTimeout(500)
    assert.equal(await value.count(), 0, 'Late responses must not restore hidden details')
    assert.equal(reads, beforeLate + 1)
    await page.unroute('**/credentials')
    await page.route('**/credentials', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"error":{"message":"fixture failure"}}' }))
    await page.getByRole('button', { name: '查看密钥详情', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '读取密钥详情失败，请重试' }).waitFor()
    assert.equal(await value.count(), 0)
    await page.unroute('**/credentials')
    console.log('PASS explicit reveal, copy, hide, reopen, replacement isolation, late-response and failure handling')

    await page.getByRole('button', { name: '查看密钥详情', exact: true }).click()
    await value.waitFor()
    await page.getByRole('button', { name: '清除已存密钥', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '清除', exact: true }).click()
    await value.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '查看密钥详情', exact: true }).click()
    if (process.argv.includes('--balance')) await page.locator('[data-credential-value="balanceQuery.accessToken"]').waitFor()
    else await page.getByText('此账号没有可查看的已保存凭证。', { exact: true }).waitFor()
    assert.equal(await value.count(), 0)
    console.log('PASS clearing a saved key invalidates the revealed details')
  }
  await api(`/api/accounts/${id}`, { noAuth: true }, 'PATCH')
  const empty = await api(endpoint)
  assert.equal(empty.noAuth, true)
  assert.equal(empty.fields.some(field => field.key === 'apiKey'), false)
  console.log('PASS no-auth accounts have no saved secrets')
  const panel = await api('/api/panel/setup?auth-mode=body', { username: 'fixture-admin', password: 'fixture-password-only' })
  const sessionRead = await fetch(base + endpoint, { headers: { 'x-panel-token': panel.accessToken } })
  assert.equal(sessionRead.status, 200, 'Administrator sessions must be supported without any gateway Key')
  assert.equal(sessionRead.headers.get('cache-control'), 'no-store')
  console.log('PASS administrator-session authentication')
  console.log(`Evidence: ${home}`)
} finally {
  await browser?.close()
  if (server.exitCode === null) server.kill()
  await Promise.race([exited, pause(5000)])
  fs.closeSync(log)
}
