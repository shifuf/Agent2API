import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'
import { createFixturePanelSession, installFixturePanelSession } from './fixtures/panel-session.mjs'

const executable = path.resolve(process.argv[2])
const home = await mkdtemp(path.join(os.tmpdir(), 'a2-title-routes-'))
const admin = 'title-fixture-admin', source = 'Source-Chat', target = 'Title-Cheap'
const endpoint = '/api/models/title-routes', calls = []
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body)
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const frame = (delta, reason) => 'data: ' + JSON.stringify({ id: 'fixture', model: body.model, choices: [{ index: 0, delta, finish_reason: reason }] }) + '\n\n'
  res.end(frame({ role: 'assistant', content: 'title-fixture-ok' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n')
})
const upstreamPort = await listen(upstream), reserved = http.createServer(), port = await listen(reserved)
await new Promise(resolve => reserved.close(resolve))
const url = `http://127.0.0.1:${port}`
const child = spawn(executable, [], { cwd: home, windowsHide: true, stdio: 'ignore', env: { ...process.env,
  AGENT2API_UI_DIR: path.resolve(import.meta.dirname, '../desktop-tauri/ui'),
  AGENT2API_PROXY_HOME: home, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
  AGENT2API_PROXY_API_KEY: admin, AGENT2API_ACCOUNT_KEY: '5'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_CAPTCHA_ENABLED: '0',
  AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' } })
const exited = once(child, 'exit')
let session
async function call(route, body, method = body ? 'POST' : 'GET', credential = null, ua = 'test') {
  const auth = credential ? { authorization: `Bearer ${credential}` } : session ? { 'x-panel-token': session.accessToken } : {}
  const response = await fetch(url + route, { method, headers: { ...auth, 'content-type': 'application/json', 'user-agent': ua },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) })
  const text = await response.text(); let result
  try { result = JSON.parse(text) } catch { result = text.slice(0, 240) }
  return [response.status, result?.success && Object.hasOwn(result, 'data') ? result.data : result]
}
async function ok(...args) { const [status, body] = await call(...args); assert.equal(status, 200, `${args[0]} ${JSON.stringify(body)}`); return body }
async function browserCheck() {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true })
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ locale: 'zh-CN', viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }, isMobile: mobile, hasTouch: mobile })
      try {
        await installFixturePanelSession(context, url, session, admin)
        await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort())
        await isolateUpdateNotice(context)
        const page = await context.newPage()
        const open = async () => {
          await page.goto(mobile ? `${url}/m#routing` : url)
          if (!mobile) await page.locator('.nav-item[data-page="routing"]').click()
          await page.getByRole('button', { name: '标题生成', exact: true }).click()
          const dialog = page.getByRole('dialog', { name: '标题生成' }); await dialog.getByRole('checkbox', { name: '启用', exact: true }).waitFor()
          return dialog
        }
        const dialog = await open(), models = dialog.getByRole('combobox'), before = (await ok(endpoint)).config.rules.length
        if (mobile) await dialog.getByRole('button', { name: '移除', exact: true }).last().click()
        else {
          await dialog.getByRole('button', { name: '添加规则', exact: true }).click()
          await dialog.getByRole('checkbox', { name: 'Codex', exact: true }).last().check()
          await models.last().selectOption(source)
        }
        await Promise.all([page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'PUT' && response.ok()), dialog.getByRole('button', { name: '保存', exact: true }).click()])
        const count = before + (mobile ? -1 : 1)
        assert.equal((await ok(endpoint)).config.rules.length, count)
        const reopened = await open(); assert.equal(await reopened.getByRole('combobox').count(), count)
        if (!mobile) assert.equal(await reopened.getByRole('combobox').last().inputValue(), source)
        if (process.argv.includes('--prompt')) {
          const openPrompts = async () => {
            if (mobile) {
              await page.goto(`${url}/m?prompt-editor=more#more`)
              await page.locator('[data-screen="more"]').getByRole('button', { name: '设置', exact: true }).first().click()
              await page.locator('[data-screen="settings"]').waitFor()
            } else { await page.goto(url); await page.locator('.nav-item[data-page="settings"]').click(); await page.locator('#settings-nav [data-cat="gateway"]').click() }
            try { await page.getByRole('button', { name: '条件提示词', exact: true }).click({timeout:10000}) }
            catch (error) {
              const state = await page.evaluate(() => ({ path: location.pathname + location.hash, title: document.title, screen: document.querySelector('[data-screen]')?.getAttribute('data-screen'), pane: document.querySelector('.settings-pane.active')?.getAttribute('data-cat'), promptButtons: [...document.querySelectorAll('button')].filter(button => /提示词|prompt/i.test(button.textContent || '')).map(button => ({label: button.innerText, visible: !!button.getClientRects().length})).slice(0,10) }))
              throw new Error(`Prompt editor is not reachable (${mobile ? 'mobile' : 'desktop'}): ${JSON.stringify(state)}`, {cause:error})
            }
            const editor = page.getByRole('dialog', { name: '条件提示词' }); await editor.getByRole('button', { name: '添加规则', exact: true }).waitFor(); return editor
          }
          const prompts = await openPrompts(), name = prompts.getByLabel('规则名称', { exact: true }).first()
          assert.equal(await name.inputValue(), mobile ? 'desktop fixture' : 'fixture')
          await name.fill(mobile ? 'mobile fixture' : 'desktop fixture')
          const preview = prompts.locator('fieldset').filter({ has: page.locator('legend', { hasText: '命中测试' }) }).last()
          await preview.getByLabel('对外模型', { exact: true }).fill(source); await preview.getByLabel('客户端', { exact: true }).fill('Codex')
          await preview.getByRole('button', { name: '预览', exact: true }).click(); await preview.getByText(mobile ? 'mobile fixture' : 'desktop fixture', { exact: true }).waitFor()
          await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/prompt/rules') && response.request().method() === 'PUT' && response.ok()), prompts.getByRole('button', { name: '保存', exact: true }).click()])
          const updated = await openPrompts(); assert.equal(await updated.getByLabel('规则名称', { exact: true }).first().inputValue(), mobile ? 'mobile fixture' : 'desktop fixture')
        }
      } finally { await context.close() }
    }
  } finally { await browser.close() }
  console.log('PASS title rule editor: desktop add, mobile remove, save and reload')
  if (process.argv.includes('--prompt')) console.log('PASS conditional prompt editors: desktop and mobile edit, preview, save and reload')
}
try {
  let ready = false
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    try { if ((await fetch(url + '/health')).ok) { ready = true; break } } catch {}
    await delay(150)
  }
  assert(ready)
  session = await createFixturePanelSession(url, { username: 'fixture', password: 'fixture-password-123' })
  const prompts = process.argv.includes('--prompt') ? '/api/prompt/rules' : null
  if (prompts) assert(Array.isArray((await ok(prompts)).rules), 'conditional prompt management must expose ordered rules')
  let view = await ok(endpoint)
  assert(Array.isArray(view.config?.rules), 'management API must expose versioned title routing rules')
  const channels = []
  for (const [name, model] of [[source, 'wire-source'], [target, 'wire-title']]) {
    const channel = (await ok('/api/custom-providers', { name: `Title relay ${name}`, protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      keyGroups: [{ id: 'one', enabled: true, apiKeys: [`${name}-relay-fixture`], models: [model] }] })).provider.id
    channels.push(channel)
    const groups = await ok('/api/routing/groups')
    await ok('/api/routing/groups', { id: name, revision: groups.newRevision, group: { id: name, model: name, name, enabled: true, strategy: 'order', sticky: 'off',
      members: [{ id: 'fixture-member', provider: channel, model, included: true, accountScope: 'all', accounts: [] }] } }, 'PUT')
  }
  const key = async (name, allowedModels, allowedProviders = channels) => (await ok('/api/keys', { name, key: `${name}-fixture-key`, allowedProviders, allowedModels })).created.key
  const both = await key('both', [source, target]), sourceOnly = await key('source', [source]), targetOnly = await key('target', [target])
  const missingProvider = await key('no-target-provider', [source, target], [channels[0]])
  const config = { enabled: true, rules: [{ enabled: true, clients: ['codex', 'claude-code', 'zcode'], model: target, fallback: 'error' }] }
  const ruleId = 'fixture-source-client', marker = 'matched-prompt-360', privateWord = 'rule-private-360', legacy = 'legacy-gateway-360'
  if (prompts) {
    await ok('/api/prompt', { promptMode: 'append', promptText: legacy }, 'PUT')
    await ok('/api/privacy', { enabled: true, words: [privateWord] }, 'PUT')
    const previous = await ok(prompts)
    const rules = [{ id: ruleId, name: 'fixture', enabled: true, mode: 'append', text: `${marker} ${privateWord}`, logic: 'all', conditions: [
      { id: 'source-model', field: 'model', op: 'is', values: [source] }, { id: 'source-client', field: 'client', op: 'is', values: ['codex'] },
    ] }]
    const req = { revision: previous.revision, rules }
    for (const credential of [admin, both]) assert.ok([401, 403].includes((await call(prompts, req, 'PUT', credential))[0]))
    await ok(prompts, req, 'PUT'); assert.equal((await call(prompts, req, 'PUT'))[0], 409)
    const preview = sample => ok(prompts + '/preview', { rules, sample })
    assert.equal((await preview({ provider: channels[1], model: source, client: 'Codex' })).ruleId, ruleId)
    assert.equal((await preview({ provider: channels[1], model: 'wire-title', client: 'Codex' })).ruleId, null)
  }
  for (const credential of [both, admin]) assert.ok([401, 403].includes((await call(endpoint, { config, revision: view.revision }, 'PUT', credential))[0]))
  const stale = view.revision; view = await ok(endpoint, { revision: stale, config }, 'PUT')
  assert.equal((await call(endpoint, { config, revision: stale }, 'PUT'))[0], 409)
  const titleText = 'Please write a 5-10 word title for this fixture.'
  const tool = { type: 'function', function: { name: 'example', parameters: { type: 'object', properties: {} } } }
  const examples = [
    ['/v1/chat/completions', 'ZCode/1', { messages: [{ role: 'system', content: 'Generate a concise title for this coding session.' }, { role: 'user', content: 'fixture' }] }],
    ['/v1/responses', 'codex-tui/1', { input: 'fixture', client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_source: 'thread_title' }) } }],
    ['/v1/messages', 'claude-cli/1', { max_tokens: 32, messages: [{ role: 'user', content: titleText }] }],
  ]
  for (const [route, ua, payload] of examples) {
    const body = { ...payload, model: source, stream: false }; const before = calls.length
    for (const credential of [sourceOnly, targetOnly, missingProvider]) assert.equal((await call(route, body, 'POST', credential, ua))[0], 404)
    assert.equal(calls.length, before, 'neither denied source nor denied target may forward')
    await ok(route, body, 'POST', both, ua)
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).model, 'wire-title'); assert.ok(!('_wb_title_route' in calls.at(-1)))
    if (prompts) {
      const wire = JSON.stringify(calls.at(-1).messages.filter(message => message.role === 'system'))
      if (ua === 'codex-tui/1') { assert(wire.includes(marker), 'rule must match the original public model, not the title target or wire model'); assert(!wire.includes(privateWord), 'rule content must cross final privacy protection') }
      else { assert(wire.includes(legacy), 'a non-matching rule leaves the existing gateway prompt in force'); assert(!wire.includes(marker)) }
    }
  }
  const stats = await ok('/api/stats/requests?limit=100')
  const traces = stats.entries.map(entry => entry.route?.titleRoute).filter(Boolean)
  for (const client of ['codex', 'claude-code', 'zcode']) {
    const trace = traces.find(item => item.client === client); assert.ok(trace, `missing ${client} trace`)
    assert.equal(trace.source, source); assert.equal(trace.target, target); assert.ok(trace.ruleId)
    assert.ok(!JSON.stringify(trace).includes(titleText))
  }
  if (prompts) {
    const trace = stats.entries.find(entry => entry.route?.titleRoute?.client === 'codex')?.route
    assert.equal(trace?.promptRuleId, ruleId); assert(!JSON.stringify(trace).includes(marker)); assert(!JSON.stringify(trace).includes(privateWord))
    console.log('PASS conditional prompts: original public model + strict client, preview parity, legacy fallback, final privacy filter and rule-only telemetry')
  }
  const [chat, ua, payload] = examples[0]
  await ok(chat, { model: source, ...payload, tools: [tool] }, 'POST', sourceOnly, ua); assert.equal(calls.at(-1).model, 'wire-source')
  const normal = await ok(chat, { model: source, messages: [{ role: 'user', content: 'ping' }] }, 'POST', sourceOnly, 'codex-tui/1')
  assert.equal(calls.at(-1).model, 'wire-source'); assert.equal(normal.model, source)
  view = await ok(endpoint, { revision: view.revision, config: { ...config, enabled: false } }, 'PUT')
  await ok(chat, { ...payload, model: source }, 'POST', sourceOnly, ua); assert.equal(calls.at(-1).model, 'wire-source')
  if (process.argv.includes('--browser')) await browserCheck()
  view = await ok(endpoint); await ok(endpoint, { revision: view.revision, config }, 'PUT')
  const row = (await ok('/api/routing/groups')).groups.find(row => row.group.model === target)
  await ok('/api/routing/groups', { id: row.group.id, revision: row.revision, group: { ...row.group, enabled: false } }, 'PUT')
  const beforeUnavailable = calls.length; assert.equal((await call(chat, { ...payload, model: source }, 'POST', both, ua))[0], 404)
  assert.equal(calls.length, beforeUnavailable, 'an unavailable target must not retry the source')
  console.log('PASS title routing: three protocols, client recognition, public models, scope, no fallback, management and telemetry')
} finally {
  child.kill(); await exited; await new Promise(resolve => upstream.close(resolve)); await rm(home, { recursive: true, maxRetries: 4, force: true })
}
