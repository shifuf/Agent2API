// Management contract against a real server and a disposable SQLite database.
// node scripts/test-proxy-bindings.mjs <agent2api-server> [--browser]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { createFixturePanelSession } from './fixtures/panel-session.mjs'

const executable = process.argv[2]
assert.ok(executable, 'Pass a built agent2api-server binary')
await access(path.resolve(executable))
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-bindings-'))
const environmentGatewayKey = 'fixture-bindings-environment-gateway-key'
const panelCredentials = { username: 'fixture-bindings-admin', password: 'fixture-bindings-panel-password-only' }
let administrator
const secrets = ['fixture-account-access-token', 'fixture-account-refresh-token', 'fixture-plugin-cookie']
const retained = Array.from({ length: 203 }, (_, index) => ({
  id: `retained-${index}`, provider: 'workbuddy', name: `Retained account ${index}`, uid: `retained-user-${index}`,
  enabled: index !== 1, accessToken: secrets[0], refreshToken: secrets[1],
  pluginSecret: { cookie: secrets[2] }, proxy: null,
}))
await writeFile(path.join(directory, 'accounts.json'), JSON.stringify({ accounts: retained }))
const reserve = net.createServer().listen(0, '127.0.0.1')
await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, AGENT2API_PROXY_HOME: directory, AGENT2API_HOST: '127.0.0.1',
  AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: environmentGatewayKey,
  AGENT2API_ACCOUNT_KEY: '4'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0',
  AGENT2API_UI_DIR: path.resolve(import.meta.dirname, '../desktop-tauri/ui'), AGENT2API_CAPTCHA_ENABLED: '0' }
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
let child, stopped, fixtureDb, output = ''
function start() {
  child = spawn(path.resolve(executable), [], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-20_000) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-20_000) })
  stopped = once(child, 'exit')
}
async function stop() { if (child?.exitCode === null) { child.kill(); await stopped } }
async function request(endpoint, body, key = administrator, method = body === undefined ? 'GET' : 'POST') {
  const headers = { 'Content-Type': 'application/json' }
  if (typeof key === 'string') headers.Authorization = `Bearer ${key}`
  else if (key?.accessToken) headers['x-panel-token'] = key.accessToken
  const response = await fetch(base + endpoint, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) })
  const value = await response.json()
  return { status: response.status, body: value.success === true && Object.hasOwn(value, 'data') ? value.data : value }
}
async function ok(endpoint, body, method) {
  const result = await request(endpoint, body, administrator, method)
  assert.equal(result.status, 200, `${endpoint}: ${JSON.stringify(result.body)}`)
  return result.body
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, output)
    try { if ((await fetch(base + '/health')).ok) return } catch {}
    await pause(200)
  }
  throw new Error(`Fixture server did not start: ${output}`)
}
const bindings = () => ok('/api/proxies/bindings')
const config = account => account.proxy?.config || account.proxy || null
const account = async id => (await bindings()).accounts.find(row => row.id === id)
async function unchangedAfter(body, status = 400) {
  const before = (await bindings()).accounts
  const result = await request('/api/proxies/bindings', body)
  assert.equal(result.status, status, JSON.stringify(result.body))
  assert.deepEqual((await bindings()).accounts, before, 'An invalid batch must leave every account unchanged')
}

try {
  start(); await ready()
  administrator = { ...await createFixturePanelSession(base, panelCredentials), gatewayKey: environmentGatewayKey }
  assert.equal((await ok('/api/upgrade')).pending, true, 'The disposable legacy account file must be pending migration')
  const upgrade = await ok('/api/upgrade/run', {})
  assert.equal(upgrade.pending, false, 'Fixture setup must complete the real legacy migration')
  assert.equal(upgrade.outcomes.find(item => item.label === '账号')?.imported, retained.length, 'The real upgrade endpoint must seed every retained account')
  const initial = await bindings()
  assert.equal(initial.accounts.length, retained.length, 'The management binding list must retain accounts whose plugin is absent')
  for (const row of initial.accounts) {
    assert.equal(row.provider, 'workbuddy')
    assert.ok(row.providerLabel)
    assert.deepEqual(Object.keys(row).sort(), ['enabled', 'id', 'name', 'provider', 'providerLabel', 'proxy'])
  }
  for (const secret of secrets) assert.ok(!JSON.stringify(initial).includes(secret), 'Account credentials are never in a binding response')
  await ok('/api/accounts/retained-202', { proxy: { source: 'custom', protocol: 'http', host: '127.0.0.1', port: 8089, username: 'fixture-proxy-user', password: 'fixture-proxy-password' } }, 'PATCH')
  assert.ok(!JSON.stringify((await bindings()).accounts).includes('fixture-proxy-password'), 'Binding account metadata never exposes custom proxy credentials')
  const create = async name => (await ok('/api/proxies/pool', { name, protocol: 'http', host: '127.0.0.1', port: 8088, enabled: true })).items.find(row => row.name === name).id
  const first = await create('Binding exit A'), second = await create('Binding exit B'), disabled = await create('Disabled exit')
  await ok('/api/proxies/pool/enable', { id: disabled, enabled: false })
  const ids = ['retained-0', 'retained-1', 'retained-2']
  let saved = await ok('/api/proxies/bindings', { accountIds: ids, proxyIds: [first] })
  for (const id of ids) assert.deepEqual(config(saved.accounts.find(row => row.id === id)), { source: 'pool', proxyId: first })
  assert.deepEqual(saved.items.find(row => row.id === first).usedBy.map(row => row.id).sort(), [...ids].sort())
  assert.equal(saved.items.find(row => row.id === first).usedBy.find(row => row.id === 'retained-1').enabled, false)
  assert.ok(saved.items.find(row => row.id === first).usedBy.every(row => row.provider === 'workbuddy' && row.providerLabel))
  console.log('PASS many accounts bound to one exit, disabled account retained, provider labels and redaction')

  const channel = (await ok('/api/custom-providers', { name: 'Fixture channel', protocol: 'chat_completions', baseUrl: 'http://127.0.0.1:1/v1',
    keyGroups: [{ id: 'fixture-key-group', apiKeys: ['fixture-channel-secret'], enabled: true, models: ['fixture-model'] }] })).provider
  const channelAccount = (await ok('/api/custom-providers')).providers.find(row => row.id === channel.id).keyGroups[0].accountIds[0]
  await ok(`/api/accounts/${channelAccount}`, { name: 'Fixture channel login' }, 'PATCH')
  const channelSaved = await ok('/api/proxies/bindings', { accountIds: [channelAccount], proxyIds: [second] })
  const channelUsage = channelSaved.items.find(row => row.id === second).usedBy.find(row => row.id === channelAccount)
  assert.equal(channelUsage.providerLabel, 'Fixture channel')
  assert.equal(channelUsage.name, 'Fixture channel login')
  assert.ok(!JSON.stringify(channelSaved).includes('fixture-channel-secret'))

  saved = await ok('/api/proxies/bindings', { accountIds: ids, proxyIds: [second, first] })
  for (const id of ids) assert.deepEqual(config(saved.accounts.find(row => row.id === id)), { source: 'rotate', all: false, proxyIds: [second, first] })
  for (const id of [first, second]) assert.deepEqual(saved.items.find(row => row.id === id).usedBy.filter(row => ids.includes(row.id)).map(row => row.id).sort(), [...ids].sort())
  await stop(); start(); await ready()
  administrator = { ...await createFixturePanelSession(base, panelCredentials, 'login'), gatewayKey: environmentGatewayKey }
  assert.deepEqual(config(await account('retained-0')), { source: 'rotate', all: false, proxyIds: [second, first] })
  console.log('PASS explicit multiple exits retain order and survive restart')

  await ok('/api/accounts/retained-0', { proxy: { source: 'pool', proxyId: second } }, 'PATCH')
  const inverse = await bindings()
  assert.deepEqual(config(inverse.accounts.find(row => row.id === 'retained-0')), { source: 'pool', proxyId: second })
  assert.ok(!inverse.items.find(row => row.id === first).usedBy.some(row => row.id === 'retained-0'))
  await ok('/api/proxies/bindings', { accountIds: ['retained-1'], proxyIds: [] })
  assert.equal(config(await account('retained-1')), null)
  assert.deepEqual(config(await account('retained-2')), { source: 'rotate', all: false, proxyIds: [second, first] })
  const emptyBefore = (await bindings()).accounts
  await ok('/api/proxies/bindings', { accountIds: [], proxyIds: [] })
  assert.deepEqual((await bindings()).accounts, emptyBefore)
  console.log('PASS accounts-page inverse update, scoped unbind and empty selection no-op')

  for (const body of [
    { accountIds: ['retained-0', 'missing-account'], proxyIds: [first] },
    { accountIds: ['retained-0'], proxyIds: [first, 'missing-exit'] },
    { accountIds: ['retained-0'], proxyIds: [first, disabled] },
    { accountIds: ['retained-0', 'retained-0'], proxyIds: [first] },
    { accountIds: ['retained-0'], proxyIds: [first, first] },
    { accountIds: ['retained-0', ''], proxyIds: [first] },
    { accountIds: ['retained-0', 7], proxyIds: [first] },
    { accountIds: 'retained-0', proxyIds: [first] },
    { accountIds: ['retained-0'], proxyIds: null },
    { accountIds: ['retained-0'], proxyIds: [first], proxy: null },
    { accountIds: retained.slice(0, 201).map(row => row.id), proxyIds: [first] },
  ]) await unchangedAfter(body)
  await ok('/api/proxies/bindings', { accountIds: retained.slice(0, 200).map(row => row.id), proxyIds: [first] })
  console.log('PASS complete-batch validation, malformed/duplicate input rejection and 200-account boundary')

  // Offline subscription fixtures still exercise production validation and the real database.
  const { DatabaseSync } = await import('node:sqlite')
  const db = fixtureDb = new DatabaseSync(path.join(directory, 'agent2api.db'))
  const kernel = await ok('/api/subscriptions/kernel')
  const providerId = 'sub_bindings_fixture'
  const subscriptionContent = JSON.stringify({ proxies: [{ name: 'live-node', type: 'http', server: '127.0.0.1', port: 8088 }],
    'proxy-groups': [{ name: 'exit-group', type: 'select', proxies: ['live-node'] }, { name: 'invalid-group', type: 'select', proxies: ['nonexistent-member'] }] })
  await mkdir(path.join(kernel.kernelDir, 'providers'), { recursive: true })
  await writeFile(path.join(kernel.kernelDir, 'providers', `sub_${providerId}.yaml`), subscriptionContent)
  const kv = db.prepare('INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  const rawPool = JSON.parse(db.prepare('SELECT value FROM kv WHERE key=?').get('proxyPool').value)
  const subItem = (id, provider, node, port = null) => ({ id, source: 'subscription', name: node, providerId: provider, node, enabled: true, port })
  rawPool.items.push(subItem('orphan-exit', 'missing-subscription', 'gone', 12345), subItem('stale-exit', providerId, 'removed-node', 12346),
    subItem('group-exit', providerId, 'exit-group'), subItem('invalid-group-exit', providerId, 'invalid-group'), subItem('lazy-exit', providerId, 'live-node'))
  kv.run('proxyPool', JSON.stringify(rawPool))
  kv.run('subscriptions', JSON.stringify({ items: [{ id: providerId, name: 'Binding subscription', kind: 'local', enabled: true, content: subscriptionContent }] }))
  for (const id of ['orphan-exit', 'stale-exit', 'invalid-group-exit']) await unchangedAfter({ accountIds: ['retained-0'], proxyIds: [first, id] })
  saved = await ok('/api/proxies/bindings', { accountIds: ['retained-0', 'retained-2'], proxyIds: ['group-exit', 'lazy-exit'] })
  assert.equal(saved.items.find(row => row.id === 'group-exit').usedBy.length, 2, 'A subscription group shows every account bound to it')
  kv.run('subscriptions', JSON.stringify({ items: [{ id: providerId, name: 'Binding subscription', enabled: false, content: subscriptionContent, kind: 'local' }] }))
  await unchangedAfter({ accountIds: ['retained-0'], proxyIds: [first, 'group-exit'] })
  db.close()
  fixtureDb = null
  console.log('PASS orphan, stale node, invalid group and paused subscription rejection; lazy nodes and group bindings')

  const unrestricted = (await ok('/api/keys', { name: 'Binding unrestricted gateway key' })).created
  assert.deepEqual(unrestricted.allowedProviders || [], [])
  assert.deepEqual(unrestricted.allowedModels || [], [])
  const restricted = (await ok('/api/keys', { name: 'Binding restricted gateway key', allowedProviders: [channel.id], allowedModels: ['fixture-model'] })).created
  assert.deepEqual(restricted.allowedProviders, [channel.id])
  assert.deepEqual(restricted.allowedModels, ['fixture-model'])
  const forbiddenGatewayKeys = [
    { label: 'unrestricted gateway Key', key: unrestricted.key },
    { label: 'restricted gateway Key', key: restricted.key },
    { label: 'environment gateway Key', key: environmentGatewayKey },
  ]
  // These are valid legacy management credentials, so binding rejection cannot be
  // explained by an unknown Key or by tightening unrelated account/proxy routes.
  for (const { label, key } of [forbiddenGatewayKeys[0], forbiddenGatewayKeys[2]]) {
    for (const endpoint of ['/api/accounts', '/api/proxies/pool']) {
      const legacy = await request(endpoint, undefined, key)
      assert.equal(legacy.status, 200, label + ' retains existing ' + endpoint + ' access')
    }
  }
  const deniedWrite = { accountIds: ['retained-0'], proxyIds: [second] }
  assert.notDeepEqual(config(await account('retained-0')), { source: 'pool', proxyId: second }, 'The forbidden POST would change a real account if admitted')
  const authorizationDb = new DatabaseSync(path.join(directory, 'agent2api.db'), { readOnly: true })
  try {
    const storedAccounts = () => authorizationDb.prepare('SELECT * FROM accounts ORDER BY id').all()
    for (const { label, key } of forbiddenGatewayKeys) {
      assert.equal(typeof key, 'string')
      for (const method of ['GET', 'POST']) {
        const before = storedAccounts()
        const bindingsBefore = (await bindings()).accounts
        const result = await request('/api/proxies/bindings', method === 'POST' ? deniedWrite : undefined, key, method)
        assert.equal(result.status, 403, label + ' cannot ' + method + ' proxy bindings')
        assert.ok(!result.body.accounts && !result.body.data?.accounts, 'A denied GET must not expose binding accounts')
        assert.deepEqual(storedAccounts(), before, label + ' ' + method + ' leaves complete stored account rows unchanged')
        assert.deepEqual((await bindings()).accounts, bindingsBefore, label + ' ' + method + ' leaves public bindings unchanged')
        console.log('PASS ' + label + ' ' + method + ' denied with 403 and no account changes')
      }
    }
  } finally { authorizationDb.close() }
  const credentials = await ok('/api/accounts/retained-0/credentials')
  assert.equal(credentials.fields.find(field => field.key === 'accessToken').value, secrets[0])
  assert.equal(credentials.fields.find(field => field.key === 'refreshToken').value, secrets[1])
  const final = await bindings()
  for (const secret of secrets) assert.ok(!JSON.stringify(final).includes(secret))
  console.log('PASS real panel-session auth, all gateway Key types denied and account credentials preserved')
  if (process.argv.includes('--browser')) {
    const { checkBindingBrowser } = await import('./test-proxy-bindings-browser.mjs')
    await checkBindingBrowser(base, administrator, process.env.PROXY_BINDING_SCREENSHOT_DIR || directory, forbiddenGatewayKeys)
  }
} catch (error) {
  console.error(error.message)
  console.error('Fixture server diagnostic output:\n' + output)
  process.exitCode = 1
} finally {
  fixtureDb?.close()
  await stop()
  if (process.env.KEEP_PROXY_BINDING_FIXTURE === '1') console.log(`Fixture: ${directory}`)
  else {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('agent2api-bindings-'))
    await rm(directory, { recursive: true, force: true })
  }
}
