// Real mobile bridge/client/shared direct fetch over loopback HTTP. No personal storage or accounts.
// Missing renewal, recapturing server identity on retry, or replaying model-Key failures must fail these tests.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const typescript = createRequire(new URL('../mobile/package.json', import.meta.url))('typescript')
const root = new URL('../', import.meta.url)
const sources = new Map()
for (const relative of ['mobile/src/core/servers.ts', 'mobile/src/core/client.ts', 'mobile/src/core/desktop-bridge.ts', 'ui-islands/src/islands/assistant-api.ts']) {
  const filename = path.resolve(new URL(relative, root).pathname.replace(/^\/([A-Z]:\/)/i, '$1'))
  sources.set(filename, typescript.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } }).outputText)
}

export function mobileHarness(base, auth = {}) {
  const storage = new Map(), modules = new Map()
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) }
  const window = { Capacitor: { isNativePlatform: () => true }, dispatchEvent() {} }
  const context = vm.createContext({ window, location: { origin: 'http://localhost' }, localStorage, fetch, DOMException, Event, AbortController, URL, console, setTimeout, clearTimeout })
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const require = name => {
      if (name === '@capacitor/core') return { Capacitor: { isPluginAvailable: () => false }, registerPlugin: () => ({}) }
      if (name === './store') return { store: { getState: () => ({}), refresh: async () => {}, toast() {}, setTab() {} } }
      if (name === '../i18n') return { t: value => value }
      return load(path.resolve(path.dirname(filename), name + '.ts'))
    }
    assert.ok(sources.has(filename), 'Real source required: ' + filename)
    vm.runInContext('(function(require,module,exports){' + sources.get(filename) + '\n})', context, { filename })(require, module, module.exports)
    return module.exports
  }
  const filename = relative => path.resolve(new URL(relative, root).pathname.replace(/^\/([A-Z]:\/)/i, '$1'))
  const servers = load(filename('mobile/src/core/servers.ts'))
  const original = servers.saveServer({ name: 'disposable original', base })
  servers.setActiveServer(original.id)
  servers.storeServerAuth(original.id, auth.access || 'expired-access', auth.refresh || 'valid-refresh', 3600)
  if (auth.expiresAt !== undefined) localStorage.setItem(`agent2api.panelAuth.${original.id}`, JSON.stringify({ access: auth.access || 'expired-access', refresh: auth.refresh || 'valid-refresh', expiresAt: auth.expiresAt }))
  load(filename('mobile/src/core/desktop-bridge.ts')).installDesktopBridge()
  return { api: load(filename('ui-islands/src/islands/assistant-api.ts')), servers, original,
    auth: () => servers.readServerAuth(original.id),
    switchTo(base) { const next = servers.saveServer({ name: 'disposable next', base }); servers.setActiveServer(next.id); servers.storeServerAuth(next.id, 'next-access', 'next-refresh', 3600); return next },
    replaceBase(base) { servers.saveServer({ id: original.id, base }) },
  }
}

async function panel() {
  const calls = []; let refreshGate, responseGate, commits = 0
  const server = http.createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part)
    const body = Buffer.concat(parts).toString()
    calls.push({ method: request.method, path: request.url, headers: request.headers, body })
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (request.url === '/api/panel/refresh') {
      if (refreshGate) await refreshGate()
      if (request.headers['x-panel-refresh'] !== 'valid-refresh') return json(401, { success: false, error: { type: 'panel_login_required' } })
      return json(200, { success: true, data: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresIn: 7200 } })
    }
    if (responseGate) await responseGate()
    if (request.url.startsWith('/model/')) return json(401, { success: false, error: { type: request.url.endsWith('panel') ? 'panel_login_required' : 'invalid_api_key' } })
    if (request.headers['x-panel-token'] !== 'fresh-access') return json(401, { success: false, error: { type: 'panel_login_required' } })
    if (request.method === 'PUT') commits++
    return json(200, { success: true, data: request.method === 'PUT' ? JSON.parse(body) : { name: 'original config' } })
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { base: `http://127.0.0.1:${server.address().port}`, calls, get commits() { return commits },
    gateRefresh(callback) { refreshGate = callback }, gateResponse(callback) { responseGate = callback },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}
function gate() { let enter, release; return { entered: new Promise(resolve => { enter = resolve }), released: new Promise(resolve => { release = resolve }), enter: () => enter(), release: () => release() } }
async function withPanels(action) { const a = await panel(), b = await panel(); try { await action(a, b) } finally { await a.close(); await b.close() } }

test('shared mobile management GET renews expiring access before sending', () => withPanels(async a => {
  const mobile = mobileHarness(a.base, { expiresAt: Date.now() - 1 })
  assert.equal((await mobile.api.callJson('GET', '/config')).name, 'original config')
  assert.deepEqual(a.calls.map(call => call.path), ['/api/panel/refresh', '/config'])
  assert.equal(a.calls[1].headers['x-panel-token'], 'fresh-access')
}))
test('shared mobile management GET recovers explicit session 401 once', () => withPanels(async a => {
  const mobile = mobileHarness(a.base)
  assert.equal((await mobile.api.callJson('GET', '/config')).name, 'original config')
  assert.deepEqual(a.calls.map(call => call.path), ['/config', '/api/panel/refresh', '/config'])
}))
test('shared mobile management PUT renews and saves the unchanged body once', () => withPanels(async a => {
  const mobile = mobileHarness(a.base)
  const config = { instructions: 'keep config', maxTokens: 1031 }
  const value = await mobile.api.callJson('PUT', '/config', config)
  assert.equal(JSON.stringify(value), JSON.stringify(config))
  assert.deepEqual(a.calls.map(call => call.path), ['/config', '/api/panel/refresh', '/config'])
  assert.equal(a.calls[0].body, a.calls[2].body)
  assert.equal(a.commits, 1)
}))
test('switching server during proactive credential renewal sends no stale request', () => withPanels(async (a, b) => {
  const pending = gate(); a.gateRefresh(async () => { pending.enter(); await pending.released })
  const mobile = mobileHarness(a.base, { expiresAt: Date.now() - 1 })
  const action = mobile.api.callJson('PUT', '/config', { old: true })
  // Without renewal the buggy implementation fails before the refresh gate; report that behavior directly.
  const outcome = await Promise.race([pending.entered.then(() => 'refresh'), action.then(() => 'success', () => 'failed')])
  assert.equal(outcome, 'refresh', 'must enter real session renewal before dispatch')
  mobile.switchTo(b.base); pending.release()
  await assert.rejects(action, { name: 'AbortError' })
  assert.deepEqual(a.calls.map(call => call.path), ['/api/panel/refresh'])
  assert.equal(b.calls.length, 0)
}))
test('switching after a rejected management response cannot replay at the new server', () => withPanels(async (a, b) => {
  const pending = gate(); a.gateResponse(async () => { pending.enter(); await pending.released })
  const mobile = mobileHarness(a.base)
  const action = mobile.api.callJson('PUT', '/config', { originalOnly: true })
  await pending.entered; mobile.switchTo(b.base); pending.release()
  await assert.rejects(action, { name: 'AbortError' })
  assert.equal(a.calls.length, 1)
  assert.equal(b.calls.length, 0, 'no replay or old payload/headers may reach the new server')
}))
test('switching during 401 renewal keeps retry pinned to the initial server', () => withPanels(async (a, b) => {
  const pending = gate(); a.gateRefresh(async () => { pending.enter(); await pending.released })
  const mobile = mobileHarness(a.base)
  const action = mobile.api.callJson('GET', '/config')
  const outcome = await Promise.race([pending.entered.then(() => 'refresh'), action.then(() => 'success', () => 'failed')])
  assert.equal(outcome, 'refresh', '401 must initiate real refresh')
  mobile.switchTo(b.base); pending.release()
  await assert.rejects(action, { name: 'AbortError' })
  assert.deepEqual(a.calls.map(call => call.path), ['/config', '/api/panel/refresh'])
  assert.equal(b.calls.length, 0)
}))
for (const kind of ['invalid', 'panel']) test(`explicit mobile model Key ${kind} rejection is never replayed`, () => withPanels(async a => {
  const mobile = mobileHarness(a.base)
  const response = await mobile.api.requestDirect(`/model/${kind}`, { method: 'POST', apiKey: 'selected-model-key', body: { prompt: 'one billable action' } })
  assert.equal(response.status, 401)
  assert.equal(a.calls.length, 1)
  assert.equal(a.calls[0].headers.authorization, 'Bearer selected-model-key')
  assert.equal(a.calls[0].headers['x-api-key'], 'selected-model-key')
}))
test('mobile management invalid_api_key does not trigger session renewal or replay', () => withPanels(async a => {
  const mobile = mobileHarness(a.base)
  const response = await mobile.api.requestDirect('/model/invalid', { method: 'PUT', body: { old: true } })
  assert.equal(response.status, 401)
  assert.equal(a.calls.length, 1)
}))

for (const method of ['GET', 'PUT']) test(`actual panel ${method} works with server-expired access and valid refresh`, { skip: !process.env.MOBILE_AUTH_SERVER_BIN }, async () => {
  const { pluginGateway } = await import('../../scripts/fixtures/plugin-gateway.mjs')
  const gateway = await pluginGateway(process.env.MOBILE_AUTH_SERVER_BIN, 'mobile-panel-auth')
  try {
    const session = { ...gateway.session }
    const hash = createHash('sha256').update(session.accessToken).digest('hex')
    await gateway.stop()
    // Only this disposable DB is touched, with the exact issued access hash. The valid refresh chain remains intact.
    await promisify(execFile)('python', ['-c', [
      'import json,sqlite3,sys',
      'con=sqlite3.connect(sys.argv[1])',
      'records=json.loads(con.execute("SELECT value FROM kv WHERE key=\'panelAccessSessions\'").fetchone()[0])',
      'matches=[r for r in records if r["hash"]==sys.argv[2]]',
      'assert len(matches)==1',
      'matches[0]["expires_at"]=1',
      'con.execute("UPDATE kv SET value=? WHERE key=\'panelAccessSessions\'",(json.dumps(records),))',
      'con.commit()',
    ].join('\n'), path.join(gateway.home, 'agent2api.db'), hash])
    await gateway.restart()
    const rejected = await fetch(gateway.base + '/api/assistant/config', { headers: { 'x-panel-token': session.accessToken } })
    assert.equal(rejected.status, 401, 'The actual server must reject the expired access before testing recovery')
    assert.equal((await rejected.json()).error.type, 'panel_login_required')
    const mobile = mobileHarness(gateway.base, { access: session.accessToken, refresh: session.refreshToken })
    const body = method === 'PUT' ? { config: { systemPrompt: 'disposable renewed mobile config', model: null } } : undefined
    const value = await mobile.api.callJson(method, '/api/assistant/config', body)
    assert.ok(value.config)
    assert.notEqual(mobile.auth().access, session.accessToken, 'Actual refresh must store a newly issued access token')
    if (method === 'PUT') {
      assert.equal(value.config.systemPrompt, body.config.systemPrompt)
      assert.equal((await gateway.call('/api/assistant/config')).config.systemPrompt, body.config.systemPrompt)
    }
  } finally { await gateway.stop() }
})
