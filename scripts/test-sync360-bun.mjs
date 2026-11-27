import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createFixturePanelSession, installFixturePanelSession } from './fixtures/panel-session.mjs'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'

assert.ok(process.argv[2], 'pass the candidate server executable')
const root = await mkdtemp(path.join(os.tmpdir(), 'a2api-bun-preflight-'))
await mkdir(path.join(root, 'package'))
await writeFile(path.join(root, 'package/index.mjs'), 'export default { id: "fixture", server: async () => ({}) }')
const manifest = { name: '@fixture/provider', version: '1.2.3', exports: { './server': './index.mjs' }, scripts: { postinstall: 'exit 1' } }
async function pack(body) {
  await writeFile(path.join(root, 'package/package.json'), JSON.stringify(body))
  execFileSync('tar', ['-czf', 'archive.tgz', 'package'], { cwd: root })
  const bytes = await readFile(path.join(root, 'archive.tgz'))
  return { archive: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }
}
const reservation = net.createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
const base = `http://127.0.0.1:${port}`, key = randomUUID()
const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: path.join(root, 'data'), AGENT2API_SELF_UPDATE: '0', AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: key, AGENT2API_ACCOUNT_KEY: '2'.repeat(64), AGENT2API_CAPTCHA_ENABLED: '0' }
env.AGENT2API_WINDOWS_UPDATE = '0'
env.AGENT2API_SYSTEMD_UPDATE = '0'
env.AGENT2API_UI_DIR = path.resolve(import.meta.dirname, '../desktop-tauri/ui')
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
const server = spawn(path.resolve(process.argv[2]), [], { cwd: root, env, windowsHide: true, stdio: 'ignore' })
const ended = once(server, 'exit')
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null)
    try { if ((await fetch(base + '/health')).ok) break } catch {}
    await delay(100)
  }
  const auth = await createFixturePanelSession(base, { username: 'fixture-admin', password: randomUUID() + '!Aa' })
  const entry = await pack(manifest)
  async function inspect(body, expected, headers = { 'x-panel-token': auth.accessToken }) {
    const response = await fetch(base + '/api/plugins/community/inspect', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    assert.equal(response.status, expected, 'community package inspection')
    const json = await response.json(); return json.data ?? json
  }
  await inspect(entry, 403, { authorization: `Bearer ${key}` })
  const result = await inspect(entry, 200)
  assert.equal(result.name, manifest.name); assert.equal(result.entry, 'index.mjs'); assert.equal(result.sha256, entry.sha256)
  assert.equal(result.installed, false); assert.equal(result.executed, false); assert.equal(result.lifecycleScripts, true)
  await inspect({ ...entry, sha256: '0'.repeat(64) }, 400)
  for (const source of [{ kind: 'npm', name: '@fixture/provider', revision: 'latest' }, { kind: 'github', name: 'org/repo', revision: 'main' }, { kind: 'github', name: '../sensitive', revision: 'a'.repeat(40) }]) {
    const denied = await fetch(base + '/api/plugins/community/inspect-source', { method: 'POST', headers: { 'x-panel-token': auth.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ ...source, sha256: entry.sha256 }) })
    assert.equal(denied.status, 400, 'mutable or unsafe source must be rejected before network access')
  }
  await inspect(await pack({ ...manifest, exports: { './server': '../outside.mjs' } }), 400)
  await inspect(await pack({ ...manifest, exports: { './server': './missing.mjs' } }), 400)
  async function archives(body, expected, headers = { 'x-panel-token': auth.accessToken }) {
    const response = await fetch(base + '/api/plugins/community/archives', { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) })
    assert.equal(response.status, expected, 'community archive management')
    const json = await response.json(); return json.data ?? json
  }
  await archives(undefined, 403, { authorization: `Bearer ${key}` })
  assert.deepEqual((await archives(undefined, 200)).items, [])
  await inspect({ ...entry, retain: true }, 403, { authorization: `Bearer ${key}` })
  assert.equal((await inspect({ ...entry, retain: true }, 200)).retained, true)
  const newer = await pack({ ...manifest, version: '1.3.0' })
  await inspect({ ...newer, retain: true }, 400)
  await inspect({ ...newer, sha256: '0'.repeat(64), retain: true, previousSha256: entry.sha256 }, 400)
  assert.equal((await archives(undefined, 200)).items[0].sha256, entry.sha256)
  await inspect({ ...newer, retain: true, previousSha256: entry.sha256 }, 200)
  const [saved] = (await archives(undefined, 200)).items
  assert.equal(saved.sha256, newer.sha256); assert.equal(saved.previousSha256, entry.sha256); assert.equal(saved.executed, false)
  await archives({ action: 'rollback', name: manifest.name, sha256: entry.sha256 }, 400)
  await archives({ action: 'rollback', name: manifest.name, sha256: newer.sha256 }, 200)
  assert.equal((await archives(undefined, 200)).items[0].sha256, entry.sha256)
  const database = new DatabaseSync(path.join(env.AGENT2API_PROXY_HOME, 'community-archives.sqlite'), { readOnly: true })
  try { assert.equal(createHash('sha256').update(database.prepare('SELECT body FROM archives WHERE name=?').get(manifest.name).body).digest('hex'), entry.sha256) } finally { database.close() }
  await archives({ action: 'remove', name: manifest.name, sha256: entry.sha256 }, 200)
  assert.deepEqual((await archives(undefined, 200)).items, [])
  console.log('PASS inert local archive store, failed/stale upgrade preserves prior bytes, explicit rollback and removal')
  const proxySource = { kind: 'npm', name: 'is-number', revision: '7.0.0', sha256: '7b75c1057198cf97696909a9bee176c9c5e9bcb5b03bf3ecef2f484defadd51e' }
  const post = (endpoint, body) => fetch(base + endpoint, { method: 'POST', headers: { 'x-panel-token': auth.accessToken, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const tunnels = []
  const proxy = http.createServer().on('connect', (request, socket) => { tunnels.push(request.url); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') }).listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  try {
    assert.equal((await post('/api/update/proxy', { proxy: { source: 'pool', proxyId: 'missing-fixture' } })).status, 200)
    assert.equal((await post('/api/plugins/community/inspect-source', proxySource)).status, 503)
    assert.equal((await post('/api/update/proxy', { proxy: { source: 'custom', protocol: 'http', host: '127.0.0.1', port: proxy.address().port } })).status, 200)
    assert.equal((await post('/api/plugins/community/inspect-source', proxySource)).status, 502)
    assert.deepEqual(tunnels, ['registry.npmjs.org:443'])
  } finally { await new Promise(resolve => proxy.close(resolve)); assert.equal((await post('/api/update/proxy', { proxy: null })).status, 200) }
  console.log('PASS disabled update proxy fails closed; pinned npm uses selected CONNECT proxy without fallback')
  if (process.argv.includes('--browser')) {
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
    const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true })
    try { for (const mobile of [false, true]) {
      const context = await browser.newContext({ locale: 'zh-CN', viewport: mobile ? {width:390,height:844} : {width:1400,height:900}, isMobile:mobile })
      await installFixturePanelSession(context, base, auth, key); await isolateUpdateNotice(context)
      const page = await context.newPage(); page.on('dialog', dialog => dialog.accept())
      let showProbe = false
      if (process.argv.includes('--probe-ui')) await page.route('**/api/plugins/community/archives', async route => {
        if (route.request().method() !== 'GET') return route.continue()
        const result = await route.fetch(), json = await result.json(); (json.data ?? json).executionAvailable = showProbe
        return route.fulfill({response: result, json})
      })
      await page.goto(mobile ? base+'/m#more' : base)
      if (mobile) await page.locator('[data-screen="more"]').getByRole('button',{name:/网关插件/}).click()
      else await page.locator('.nav-item[data-page="plugins"]').click()
      const pane = page.locator('[data-community-inspector]:visible'); await pane.locator('summary').click()
      await pane.locator('input[type=file]').setInputFiles({ name:'fixture.tgz', mimeType:'application/gzip', buffer: Buffer.from(entry.archive,'base64') })
      await pane.getByLabel('SHA-256').fill(entry.sha256); await pane.getByRole('button',{name:'检查归档'}).click()
      await pane.getByRole('button',{name:/保存已检查/}).click(); await pane.getByText(manifest.name+'@'+manifest.version,{exact:false}).filter({visible:true}).first().waitFor()
      await pane.getByRole('button',{name:'删除',exact:true}).waitFor()
      assert.equal(await pane.getByRole('button',{name:'隔离试跑',exact:true}).count(), 0, 'no runnable probe advertised without kit')
      if (process.argv.includes('--probe-ui')) {
        showProbe = true; await pane.locator('summary').click(); await pane.locator('summary').click()
        let probes = 0
        await page.route('**/api/plugins/community/probe', async route => {
          probes++; assert.deepEqual(route.request().postDataJSON(), { name: manifest.name, sha256: entry.sha256 })
          if (probes > 1) await delay(750)
          await route.fulfill({json:{success:true,data:{status:'completed',hook:'server',sha256:entry.sha256,metadataOnly:true,installed:false}}}).catch(() => {})
        })
        const probe = pane.getByRole('button',{name:'隔离试跑',exact:true})
        await probe.click(); await pane.getByText('隔离试跑完成，未启用插件。',{exact:true}).waitFor()
        const sent = page.waitForRequest(req => req.url().endsWith('/api/plugins/community/probe'))
        await probe.click(); await sent; await pane.getByRole('button',{name:'取消',exact:true}).click()
        await pane.getByText('已取消',{exact:true}).waitFor(); await delay(850)
        assert.equal(await pane.locator('output').innerText(),'已取消'); assert.equal(probes,2)
      }
      await pane.getByRole('button',{name:'删除',exact:true}).click(); await pane.getByRole('button',{name:'删除',exact:true}).waitFor({state:'hidden'})
      assert.deepEqual((await archives(undefined, 200)).items, []); await context.close()
    } } finally { await browser.close() }
    console.log('PASS desktop and mobile panel inspect, retain without activation and delete the same verified archive')
    if (process.argv.includes('--probe-ui')) console.log('PASS desktop and mobile diagnostic controls, exact hash, capability gating and cancellation (simulated guest responses)')
  }
  if (process.argv.includes('--public-sources')) {
    const samples = [
      { kind: 'npm', name: 'is-number', revision: '7.0.0', sha256: '7b75c1057198cf97696909a9bee176c9c5e9bcb5b03bf3ecef2f484defadd51e' },
      { kind: 'github', name: 'jonschlinkert/is-number', revision: '98e8ff1da1a89f93d1397a24d7413ed15421c139', sha256: '4e169d1ea361d1b92907a6ab2dd6bcd781c85027858d99df1596a712aab49506' },
    ]
    for (const source of samples) {
      const response = await fetch(base + '/api/plugins/community/inspect-source', { method: 'POST', headers: { 'x-panel-token': auth.accessToken, 'content-type': 'application/json' }, body: JSON.stringify(source) })
      assert.equal(response.status, 200, source.kind)
      const { data } = await response.json()
      assert.equal(data.name, 'is-number'); assert.equal(data.entry, 'index.js'); assert.equal(data.version, '7.0.0')
      assert.equal(data.sha256, source.sha256); assert.equal(data.installed, false); assert.equal(data.executed, false)
    }
    console.log('PASS pinned public npm version and GitHub commit checked without importing the packages')
  }
  console.log('PASS admin-only offline community package inspection, immutable digest, bounded entry, no lifecycle execution or activation')
} finally { if (server.exitCode === null) { server.kill(); await ended } }
