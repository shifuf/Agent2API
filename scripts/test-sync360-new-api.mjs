import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { usageAggregateOf, usageSupplementReadingsOf } from '../desktop-tauri/ui-shared/usage-readings.ts'

const binary = process.argv[2] || process.env.AGENT2API_SERVER_BIN
assert.ok(binary, 'Usage: node scripts/test-sync360-new-api.mjs <server binary>')
const admin = 'new-api-fixture-admin'
const secret = 'new-api-fixture-console-credential'
const privateField = 'new-api-private-fixture-marker'
const accountIdHeader = '317'
const home = await mkdtemp(path.join(tmpdir(), 'agent2api-new-api-'))
const calls = []
let fixture
const plan = (total, used, overflow, extra = {}) => ({ subscription: { amount_total: total, amount_used: used,
  status: 'active', allow_wallet_overflow: overflow, next_reset_time: 4100000000, end_time: 4102444800, ...extra },
  plan: { title: 'Fixture Plan' }, internal: privateField })
const listen = async server => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
const leaked = []
const sink = createServer((req, res) => { leaked.push(req.url); res.writeHead(200).end('{}') })
const sinkUrl = await listen(sink)
const upstream = createServer((req, res) => {
  const route = req.url.replace('/relay/api/', '')
  calls.push({ route, auth: req.headers.authorization, user: req.headers['new-api-user'] })
  const data = route === 'user/self' ? { data: { quota: fixture.wallet, used_quota: 22, access_token: privateField } }
    : route === 'status' ? { data: { quota_per_unit: 2, quota_display_type: 'USD', private: privateField } }
      : route === 'subscription/self' ? { data: { subscriptions: fixture.plans, billing_preference: fixture.pref,
        all_subscriptions: [plan(200, 0, false)], internal: privateField } } : null
  if (route === 'subscription/self' && fixture.redirect) return res.writeHead(302, { Location: sinkUrl }).end()
  const status = route === 'subscription/self' && fixture.missing || !data ? 404 : 200
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
})
const upstreamUrl = await listen(upstream)
const reserve = createServer()
const gateway = await listen(reserve)
await close(reserve)
const env = { ...process.env, AGENT2API_PROXY_HOME: home, AGENT2API_PROXY_PORT: new URL(gateway).port,
  AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_API_KEY: admin, AGENT2API_ACCOUNT_KEY: '4'.repeat(64),
  AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_CAPTCHA_ENABLED: '0' }
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
const server = spawn(path.resolve(binary), [], { cwd: home, env, windowsHide: true, stdio: 'ignore' })
const exit = once(server, 'exit')
const api = async (route, body, method = body ? 'POST' : 'GET') => {
  const res = await fetch(gateway + route, { method,
    headers: { 'x-api-key': admin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000) })
  assert.equal(res.status, 200, route)
  return (await res.json()).data
}
try {
  for (let attempt = 0; ; attempt++) {
    assert.ok(attempt < 120 && server.exitCode === null, 'fixture server unavailable')
    try { if ((await fetch(gateway + '/health')).ok) break } catch {}
    await pause(250)
  }
  fixture = { wallet: 0, plans: [] }
  const { provider } = await api('/api/custom-providers', { name: 'New API fixture', protocol: 'chat_completions',
    balanceScheme: 'new_api', baseUrl: upstreamUrl + '/relay/v1', keyGroups: [
      { id: 'fixture', name: 'Fixture', enabled: true, apiKeys: ['fixture-inference-key'], models: ['fixture'] }] })
  const id = (await api('/api/custom-providers')).providers.find(row => row.id === provider.id).keyGroups[0].accountIds[0]
  const imported = await api('/api/accounts/import', { accounts: [{ id, provider: provider.id, apiKey: 'fixture-inference-key',
    balanceQuery: { accessToken: secret, userId: accountIdHeader } }] })
  assert.equal(imported.failed, 0)
  const cases = [
    { name: 'zero wallet and active plan', wallet: 0, plans: [plan(20, 8, true)], value: 6 },
    { name: 'exhausted plan forbids overflow', wallet: 10, plans: [plan(20, 20, false)], value: 0 },
    { name: 'exhausted plan allows overflow', wallet: 10, plans: [plan(20, 20, true)], value: 5 },
    { name: 'subscription only', pref: 'subscription_only', wallet: 10, plans: [plan(16, 8, true)], value: 4 },
    { name: 'wallet only', pref: 'wallet_only', wallet: 10, plans: [plan(16, 8, false)], value: 5 },
    { name: 'wallet first', pref: 'wallet_first', wallet: 10, plans: [plan(16, 8, false)], value: 9 },
    { name: 'subscription first without overflow', pref: 'subscription_first', wallet: 4, plans: [plan(12, 8, false), plan(8, 4, true)], value: 4 },
    { name: 'negative wallet cannot subtract from plan', wallet: -8, plans: [plan(10, 4, true)], value: 3 },
    { name: 'unlimited subscription', wallet: 4, plans: [plan(0, 7, false)], value: null, unlimited: true },
    { name: 'unknown consumption is not zero', wallet: 4, plans: [plan(20, undefined, false)], value: null },
    { name: 'expired subscriptions and history ignored', wallet: 6, plans: [plan(20, 8, true, { end_time: 1 })], value: 3, legacy: true },
    { name: 'old site 404', wallet: 8, plans: [], missing: true, value: 4, legacy: true },
    { name: 'do not follow a foreign origin', wallet: 8, plans: [], redirect: true, value: 4, legacy: true },
  ]
  for (const item of cases) {
    fixture = item
    calls.length = 0
    const row = (await api(`/api/accounts/usage?id=${encodeURIComponent(id)}`)).results.find(row => row.id === id)
    assert.equal(row.error, null, item.name)
    assert.equal(row.usage.available, item.value, item.name)
    assert.equal(row.usage.unit, 'USD', item.name)
    assert.equal(row.usage.quota, item.wallet)
    assert.equal(Boolean(row.usage.unlimited), Boolean(item.unlimited), item.name)
    const summary = usageAggregateOf(row.usage, text => text)
    assert.equal(summary?.remaining ?? null, item.value)
    assert.equal(Boolean(summary?.unlimited), Boolean(item.unlimited))
    if (item.legacy) assert.equal(row.usage.subscription, null)
    else {
      assert.equal(row.usage.subscription.planName, 'Fixture Plan')
      const details = usageSupplementReadingsOf(row.usage, text => text, String)
      assert.ok(details.length > 1, 'wallet and subscription details available')
      assert.equal(row.usage.subscription.resetsAt, 4100000000000)
    }
    assert.deepEqual(calls.map(call => call.route).sort(), ['status', 'subscription/self', 'user/self'], item.name)
    for (const call of calls) {
      assert.equal(call.auth, call.route === 'status' ? undefined : `Bearer ${secret}`)
      assert.equal(call.user, call.route === 'status' ? undefined : accountIdHeader)
    }
    const serialized = JSON.stringify([row, await api('/api/accounts/usage/snapshot')])
    assert.ok(!serialized.includes(secret) && !serialized.includes(privateField) && !serialized.includes('subscriptionRaw'), item.name)
    assert.deepEqual(leaked, [])
    console.log('PASS', item.name)
  }
  const proxyCalls = []
  const proxy = createServer((req, res) => {
    proxyCalls.push(new URL(req.url).pathname)
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":{"quota":24}}')
  })
  try {
    const proxyUrl = await listen(proxy)
    const configured = await api('/api/proxies/pool', { name: 'New API fixture proxy', protocol: 'http',
      host: '127.0.0.1', port: Number(new URL(proxyUrl).port), enabled: true })
    const proxyId = configured.items.find(item => item.name === 'New API fixture proxy').id
    await api(`/api/accounts/${id}`, { proxy: { source: 'pool', proxyId } }, 'PATCH')
    calls.length = 0
    const query = () => api(`/api/accounts/usage?id=${encodeURIComponent(id)}`)
    assert.equal((await query()).results[0].usage.available, 24)
    assert.deepEqual(proxyCalls.sort(), ['/relay/api/status', '/relay/api/subscription/self', '/relay/api/user/self'])
    assert.deepEqual(calls, [])
    await api('/api/proxies/pool/enable', { id: proxyId, enabled: false })
    const failed = (await query()).results[0]
    assert.equal(failed.usage, null)
    assert.ok(failed.error)
    assert.deepEqual(calls, [], 'unavailable account proxy must not send console credentials directly')
    assert.equal(proxyCalls.length, 3)
    console.log('PASS bound proxy on every request; disabled proxy never falls back to direct')
  } finally { await close(proxy) }
} finally {
  if (server.exitCode === null) server.kill()
  await exit
  await Promise.all([close(upstream), close(sink)])
  await rm(home, { recursive: true, force: true, maxRetries: 3 })
}
