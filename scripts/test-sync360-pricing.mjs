import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { createFixturePanelSession, installFixturePanelSession } from './fixtures/panel-session.mjs'
import { fileURLToPath } from 'node:url'

assert.ok(process.argv[2], 'pass the candidate server executable')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-pricing-'))
const key = randomUUID()
const cacheTiers = { ephemeral_5m_input_tokens: 18, ephemeral_1h_input_tokens: 12 }
const upstream = http.createServer(async (request, response) => {
  for await (const chunk of request) { void chunk }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (request.url.startsWith('/v1/messages')) {
    const frames = [
      { type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: 'wire-cache', usage: { input_tokens: 60, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 30, cache_creation: cacheTiers } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ]
    return response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
  }
  const frames = [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } } }]
  response.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n')
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const reserve = http.createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: directory, AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: key, AGENT2API_ACCOUNT_KEY: '4'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_CAPTCHA_ENABLED: '0' }
env.AGENT2API_UI_DIR = fileURLToPath(new URL('../desktop-tauri/ui/', import.meta.url))
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
const child = spawn(path.resolve(process.argv[2]), [], { cwd: directory, env, windowsHide: true, stdio: 'ignore' })
const ended = once(child, 'exit')
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, 'fixture exited before health check')
    try { if ((await fetch(base + '/health')).ok) break } catch {}
    await delay(150)
  }
  const credentials = { username: 'fixture-admin', password: randomUUID() + '!Aa' }
  let admin = await createFixturePanelSession(base, credentials)
  const bearer = { authorization: `Bearer ${key}` }
  async function call(endpoint, method = 'GET', body, status = 200, headers = { 'x-panel-token': admin.accessToken }) {
    const response = await fetch(base + endpoint, { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    assert.equal(response.status, status, `${method} ${endpoint}`)
    const value = await response.json()
    return value.success === true && Object.hasOwn(value, 'data') ? value.data : value
  }
  const endpoint = '/api/model-pricing'
  assert.equal((await call(endpoint)).currency, 'usd')
  await call(endpoint, 'PUT', { currency: 'usd' }, 403, bearer)
  const registered = await call('/api/custom-providers', 'POST', { name: 'Pricing fixture', protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', enabled: true, apiKeys: ['fixture'], models: ['wire-fixture'] }] })
  const model = 'Pricing-Public'
  const groups = await call('/api/routing/groups')
  await call('/api/routing/groups', 'PUT', { revision: groups.newRevision, id: model, group: { id: model, name: model, model, enabled: true, strategy: 'order', sticky: 'off', members: [{ id: 'source', provider: registered.provider.id, model: 'wire-fixture', included: true, accountScope: 'all', accounts: [] }] } })
  const seen = new Set()
  async function completion() {
    const result = await call('/v1/chat/completions', 'POST', { model, messages: [{ role:'user', content: randomUUID() }] }, 200, bearer)
    assert.equal(result.choices[0].message.content, 'ok')
    for (let attempt = 0; attempt < 60; attempt++) {
      const rows = (await call(`/api/stats/requests?model=${model}`)).entries
      const entry = rows.find(row => row.status === 200 && !seen.has(row.id))
      if (entry) { seen.add(entry.id); return entry }
      await delay(100)
    }
    assert.fail('missing request journal entry')
  }
  const unknown = await completion(); assert.equal(unknown.costUsd, null)
  const prices = { '*/wire-fixture': { input: 10, output: 20, cacheRead: 2 }, [`*/${model}`]: { input: 999, output: 999 } }
  await call(endpoint, 'PUT', { currency: 'usd', modelPrices: prices })
  const priced = await completion(); assert.equal(priced.costUsd, (60 * 10 + 10 * 20 + 40 * 2) / 1e6); assert.equal(priced.credit, null)
  await call(endpoint, 'PUT', { currency: 'usd', modelPrices: { '*/wire-fixture': { input: 0, output: 0 } } })
  assert.equal((await completion()).costUsd, 0)
  const rows = (await call(`/api/stats/requests?model=${model}`)).entries
  assert.equal(rows.find(row => row.id === priced.id).costUsd, priced.costUsd)
  assert.equal(rows.find(row => row.id === unknown.id).costUsd, null)
  const { overview } = await call('/api/stats/summary?range=all')
  assert.equal(overview.costUsd, priced.costUsd); assert.equal(overview.pricedRequests, 2)
  await call(endpoint + '/reprice', 'POST', { id: priced.id }, 403, bearer)
  await call(endpoint + '/reprice', 'POST', { id: priced.id })
  const after = (await call(`/api/stats/requests?model=${model}`)).entries
  assert.equal(after.find(row => row.id === priced.id).costUsd, 0)
  assert.equal(after.find(row => row.id === unknown.id).costUsd, null)
  assert.equal((await call('/api/stats/summary?range=all')).overview.costUsd, 0)
  const fromMs = Date.now() - 60_000, toMs = Date.now() + 1
  const emptyRange = { fromMs: 1000, toMs: 2000 }
  const empty = await call(endpoint + '/reprice', 'POST', emptyRange)
  assert.deepEqual(empty, { updated: 0, skipped: 0 })
  await call(endpoint + '/reprice', 'POST', { fromMs, toMs }, 403, bearer)
  await call(endpoint + '/reprice', 'POST', { fromMs: toMs, toMs: fromMs }, 400)
  await call(endpoint + '/reprice', 'POST', { id: priced.id, fromMs, toMs }, 400)
  await call(endpoint, 'PUT', { modelPrices: { '*/wire-fixture': { input: 2, currency: 'eur' } } }, 400)
  await call(endpoint, 'PUT', { modelPrices: { '*/wire-fixture': { imput: 2 } } }, 400)
  await call(endpoint, 'PUT', { modelPrices: prices })
  assert.deepEqual(await call(endpoint + '/reprice', 'POST', { fromMs, toMs }), { updated: 3, skipped: 0 })
  assert.ok(Math.abs((await call('/api/stats/summary?range=all')).overview.costUsd - 3 * priced.costUsd) < 1e-12)
  if (!process.argv.includes('--only-fx')) {
    const cacheModel = 'Pricing-Anthropic'
    const provider = await call('/api/custom-providers', 'POST', { name: 'Cache pricing fixture', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', enabled: true, apiKeys: ['fixture'], models: ['wire-cache'] }] })
    const updated = await call('/api/routing/groups')
    await call('/api/routing/groups', 'PUT', { revision: updated.newRevision, id: cacheModel, group: { id: cacheModel, name: cacheModel, model: cacheModel, enabled: true, strategy: 'order', sticky: 'off', members: [{ id: 'source', provider: provider.provider.id, model: 'wire-cache', included: true, accountScope: 'all', accounts: [] }] } })
    await call(endpoint, 'PUT', { modelPrices: { '*/wire-cache': { input: 10, output: 20, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 7 } } })
    const message = await call('/v1/messages', 'POST', { model: cacheModel, max_tokens: 100, messages: [{ role: 'user', content: 'test' }] }, 200, bearer)
    assert.equal(message.content[0].text, 'ok')
    assert.deepEqual(message.usage, { input_tokens: 60, output_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 30, cache_creation: cacheTiers })
    const [record] = (await call(`/api/stats/requests?model=${cacheModel}`)).entries
    assert.equal(record.cacheReadTokens, 4)
    assert.equal(record.pricingEvidence.cacheWrite, 30); assert.equal(record.pricingEvidence.cacheWrite1h, 12)
    assert.ok(Math.abs(record.costUsd - (60 * 10 + 4 * 2 + 18 * 3 + 12 * 7 + 10 * 20) / 1e6) < 1e-12)
    console.log('PASS Anthropic round trip: cache read, 5m/1h writes and estimated cost')
  }
  if (!process.argv.includes('--only-anthropic')) {
    const stamp = Date.now()
    await call(endpoint, 'PUT', { modelPrices: { '*/wire-fixture': { currency: 'cny', input: 5, output: 10, cacheRead: 1 } } })
    const snapshots = []
    for (const rate of [8.03, null]) {
      const database = new DatabaseSync(path.join(directory, 'agent2api.db'))
      try {
        if (rate) database.prepare('INSERT OR REPLACE INTO kv (key,value) VALUES (?,?)').run('fxRateCache', JSON.stringify({ rate, updatedAt: stamp }))
        else database.prepare('DELETE FROM kv WHERE key=?').run('fxRateCache')
      } finally { database.close() }
      const backup = { filePath: path.join(directory, `rate-${rate}.a2ab`), password: randomUUID() + 'Aa!', includeLogs: true }
      await call('/api/backup/export', 'POST', backup)
      await call('/api/backup/import', 'POST', backup)
      admin = await createFixturePanelSession(base, credentials, 'login')
      assert.deepEqual((await call(endpoint)).fx, { rate: rate ?? 7.2, updatedAt: rate ? stamp : 0, stale: !rate, fallback: !rate })
      const row = await completion()
      assert.equal(row.pricingEvidence.quote.fx.rate, rate ?? 7.2)
      assert.ok(Math.abs(row.costUsd - (60 * 5 + 10 * 10 + 40) / 1e6 / (rate ?? 7.2)) < 1e-12)
      snapshots.push(row)
    }
    const restoredRows = (await call(`/api/stats/requests?model=${model}`)).entries
    for (const snapshot of snapshots) assert.equal(restoredRows.find(row => row.id === snapshot.id).costUsd, snapshot.costUsd)
    console.log('PASS FX snapshots and CNY estimates follow actual database restore without repricing older requests')
  }
  if (process.argv.includes('--browser')) {
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
    try {
      for (const mobile of [false, true]) {
        const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1360, height: 850 }, locale: 'zh-CN' })
        await installFixturePanelSession(context, base, admin, key)
        const page = await context.newPage()
        await page.goto(mobile ? `${base}/m#settings` : base)
        if (!mobile) {
          await page.locator('.nav-item[data-page="settings"]').click()
          await page.locator('.settings-nav-item[data-cat="gateway"]').click()
        }
        const panel = page.locator('[data-pricing-panel]')
        await panel.locator('summary').click()
        const select = panel.locator('select'); await select.waitFor()
        assert.equal(await select.inputValue(), mobile ? 'cny' : 'usd')
        await select.selectOption(mobile ? 'usd' : 'cny')
        const saved = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'PUT')
        await panel.locator('[data-pricing-save]').click(); assert.equal((await saved).status(), 200)
        assert.equal((await call(endpoint)).currency, mobile ? 'usd' : 'cny')
        await panel.locator('[data-reprice-from]').fill('2020-01-01')
        await panel.locator('[data-reprice-to]').fill('2020-01-01')
        const recalculated = page.waitForResponse(response => response.url().endsWith('/api/model-pricing/reprice'))
        await panel.locator('[data-pricing-reprice]').click(); assert.equal((await recalculated).status(), 200)
        await context.close()
      }
    } finally { await browser.close() }
    console.log('PASS desktop and mobile pricing settings persist across clients')
  }
  console.log('PASS request pricing: management access, actual model, cached usage, unknown vs zero, immutable historical cost and independent credit')
} finally {
  if (child.exitCode === null) { child.kill(); await ended }
  await new Promise(resolve => upstream.close(resolve))
}
