// Local HTTP acceptance test; Node 22+. This script never downloads a kernel.
// node scripts/test-proxy-subscriptions.mjs <agent2api-server> [local-mihomo-file-or-directory]
// Without the optional kernel: management/validation tests run; runtime tests report SKIP.
// With it: kernel/import verifies the repository's pinned version/hash, then all tests run.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [executable, kernelSource] = process.argv.slice(2)
assert.ok(executable, 'Usage: node scripts/test-proxy-subscriptions.mjs <agent2api-server> [local-mihomo-file-or-directory]')
await access(path.resolve(executable))
if (kernelSource) await access(path.resolve(kernelSource))

const temp = await mkdtemp(path.join(os.tmpdir(), 'agent2api-subscriptions-test-'))
const adminKey = 'subscription-test-admin-local-only'
const sockets = new Set()
const servers = []
let child, childExit, spawnError, base, logs = '', originCalls = 0, subscriptionCalls = 0, chainCalls = 0
const frontAuth = []
const proxyCalls = []
let remoteNodes = []
let remoteGroups = []

function track(socket) {
  sockets.add(socket)
  socket.on('error', () => {})
  socket.once('close', () => sockets.delete(socket))
  return socket
}
async function listen(handler) {
  const server = http.createServer(handler)
  servers.push(server)
  server.on('connection', track)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}
function yaml(nodes) { return JSON.stringify({ proxies: nodes }) } // JSON is valid YAML.
function encoded(nodes) { return Buffer.from(yaml(nodes)).toString('base64') }
function alive() {
  if (spawnError) throw spawnError
  assert.equal(child.exitCode, null, `Gateway exited: ${child.exitCode}`)
  assert.equal(child.signalCode, null, `Gateway stopped: ${child.signalCode}`)
}
async function request(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + endpoint, { method,
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) })
  const value = await response.json()
  return { status: response.status,
    body: value.success === true && Object.hasOwn(value, 'data') ? value.data : value }
}
async function ok(endpoint, body, method) {
  const result = await request(endpoint, body, method)
  assert.equal(result.status, 200, `${endpoint}: ${JSON.stringify(result.body)}`)
  return result.body
}
async function rejected(endpoint, body, status = 400) {
  const result = await request(endpoint, body)
  assert.equal(result.status, status, `${endpoint}: ${JSON.stringify(result.body)}`)
}
async function until(label, check, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    alive()
    const result = await check()
    if (result) return result
    await delay(300)
  }
  const state = await request('/api/subscriptions/kernel').catch(() => null)
  throw new Error(`Timed out: ${label}; kernel=${JSON.stringify(state?.body)}`)
}
async function pool() { return (await ok('/api/proxies/pool')).items }
async function poolNode(providerId, node) {
  return (await pool()).find(item => item.source === 'subscription' && item.providerId === providerId && item.node === node)
}
async function account(id) {
  const found = (await ok('/api/proxies')).accounts.find(item => item.id === id)
  assert.ok(found, `Account ${id} disappeared`)
  return found
}
async function subscription(id) {
  const found = (await ok('/api/subscriptions')).items.find(item => item.id === id)
  assert.ok(found, `Subscription ${id} disappeared`)
  return found
}
async function toggle(id, enabled) {
  const current = await subscription(id)
  await ok('/api/subscriptions/save', { ...current, enabled })
}

try {
  const origin = await listen(async (req, res) => {
    if (req.url === '/speed') { res.end(Buffer.alloc(6 * 1024 * 1024, 65)); return }
    if (req.url === '/slow-speed') { res.writeHead(200); res.write('x'); return }
    if (req.url === '/subscription.yaml') {
      subscriptionCalls++
      res.writeHead(200, { 'Content-Type': 'application/yaml', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ proxies: remoteNodes, 'proxy-groups': remoteGroups }))
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET') {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'wire-local', object: 'model' }] }))
      return
    }
    originCalls++
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.end(`data: ${JSON.stringify({ id: 'chatcmpl-local', choices: [{ index: 0, delta: { content: 'local-only' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
      return
    }
    res.end(JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'local-only' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const originPort = origin.address().port
  const originUrl = `http://127.0.0.1:${originPort}`
  // Only this one local origin is forwarded. Mihomo's automatic HTTPS health
  // checks are rejected here, so they cannot contact their public destination.
  const proxy = await listen((req, res) => {
    let target
    try { target = new URL(req.url) } catch { res.writeHead(400).end(); return }
    if (target.origin !== originUrl) { res.writeHead(403).end(); return }
    proxyCalls.push(String(req.headers['proxy-authorization'] || ''))
    const forward = http.request({ host: '127.0.0.1', port: originPort, path: target.pathname + target.search,
      method: req.method, headers: req.headers }, upstream => {
      res.writeHead(upstream.statusCode, upstream.headers)
      upstream.pipe(res)
    })
    forward.on('error', () => res.destroy())
    req.pipe(forward)
  })
  proxy.on('connect', (req, socket, head) => {
    if (req.url !== `127.0.0.1:${originPort}`) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    proxyCalls.push(String(req.headers['proxy-authorization'] || ''))
    const upstream = track(net.connect({ host: '127.0.0.1', port: originPort }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    }))
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
  })
  const node = (name, server = '127.0.0.1', password = 'old-password') => ({
    name, type: 'http', server, port: proxy.address().port, username: 'local-user', password,
  })
  remoteNodes = [node('stable-node'), node('unused-node')]
  const front = await listen((_req, res) => res.writeHead(403).end())
  front.on('connect', (req, socket, head) => {
    if (![ `127.0.0.1:${proxy.address().port}`, `localhost:${proxy.address().port}` ].includes(req.url)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    chainCalls++
    frontAuth.push(String(req.headers['proxy-authorization'] || ''))
    const upstream = track(net.connect({ host: '127.0.0.1', port: proxy.address().port }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    }))
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
  })
  const localContent = Buffer.from(JSON.stringify({
    proxies: [
      { ...node('local-imported-node'), 'dialer-proxy': 'front-group' },
      { ...node('second-exit', '127.0.0.1', 'second-password'), 'dialer-proxy': 'front-group' },
      { name: 'front-node', type: 'http', server: '127.0.0.1', port: front.address().port },
      { name: 'second-front', type: 'http', server: '127.0.0.1', port: front.address().port, username: 'second-front', password: 'front-password' },
    ],
    'proxy-groups': [
      { name: 'front-group', type: 'select', proxies: ['front-node', 'second-front'] },
      { name: 'exit-group', type: 'select', proxies: ['local-imported-node', 'second-exit'] },
    ],
  })).toString('base64')
  const reserve = await listen((_req, res) => res.end())
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  base = `http://127.0.0.1:${port}`
  const env = { ...process.env, AGENT2API_PROXY_HOME: temp, AGENT2API_HOST: '127.0.0.1',
    AGENT2API_UI_DIR: path.resolve('desktop-tauri/ui'),
    AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: adminKey,
    AGENT2API_ACCOUNT_KEY: '3'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_PANEL_PORT: '',
    AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  child = spawn(path.resolve(executable), [], { windowsHide: true, cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.once('error', error => { spawnError = error })
  childExit = new Promise(resolve => child.once('close', resolve))
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-40000) })
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-40000) })
  await until('gateway startup', async () => {
    try { return (await request('/api/subscriptions')).status === 200 } catch { return false }
  }, 60000)
  assert.deepEqual((await ok('/api/subscriptions')).items, [])
  assert.equal((await ok('/api/subscriptions/kernel')).installed, false)
  assert.deepEqual((await ok('/api/subscriptions/groups')).groups, [])

  for (const url of ['', 'ftp://127.0.0.1/sub', 'http://', 'http://exa mple.com/sub']) {
    await rejected('/api/subscriptions/add', { name: 'invalid', url })
  }
  for (const nodes of [[], [{ type: 'http' }], [node('same'), node('same')]]) {
    await rejected('/api/subscriptions/add', { name: 'invalid YAML', fileName: 'invalid.yaml', contentBase64: encoded(nodes) })
  }
  await rejected('/api/subscriptions/add', { name: 'bad base64', contentBase64: 'not@base64' })
  await rejected('/api/subscriptions/refresh', { id: 'missing-subscription' }, 404)

  if (kernelSource) {
    await ok('/api/subscriptions/kernel/import', { path: path.resolve(kernelSource), dir: path.join(temp, 'test-kernel') })
    await until('local kernel import', async () => {
      const state = await ok('/api/subscriptions/kernel')
      assert.ok(!state.import?.error, `Kernel import failed: ${state.import?.error}`)
      return state.installed && !state.installBusy && !state.import?.active
    })
  }

  const remoteInput = { name: 'Local HTTP subscription', url: `${originUrl}/subscription.yaml` }
  const remote = (await ok('/api/subscriptions/add', remoteInput)).items.find(item => item.url === remoteInput.url)
  assert.ok(remote)
  await rejected('/api/subscriptions/add', { ...remoteInput, name: 'Duplicate URL' })
  const localInput = { name: 'Imported YAML', fileName: 'local.yaml', contentBase64: localContent }
  const local = (await ok('/api/subscriptions/add', localInput)).items.find(item => item.kind === 'local')
  assert.ok(local)
  assert.equal(local.fileName, 'local.yaml')
  assert.ok(!Object.hasOwn(local, 'content'), 'Lists must not expose raw subscription content')
  await rejected('/api/subscriptions/add', { ...localInput, name: 'Duplicate YAML' })
  await rejected('/api/subscriptions/refresh', { id: local.id })
  await toggle(local.id, false)
  await toggle(local.id, true)
  assert.equal((await subscription(local.id)).kind, 'local', 'Editing without re-upload must preserve local content/kind')

  if (!kernelSource) {
    await toggle(remote.id, false)
    await rejected('/api/subscriptions/refresh', { id: remote.id })
    await toggle(remote.id, true)
    assert.equal((await subscription(remote.id)).id, remote.id)
    assert.equal(subscriptionCalls, 0, 'Management-only mode must not pretend to fetch through a missing kernel')
    assert.equal((await pool()).filter(item => item.source === 'subscription').length, 0)
    console.log('SKIP: runtime pull/import, account reference resume, same-name parameter refresh and pool cleanup require the optional local Mihomo argument')
  } else {
    await until('HTTP subscription nodes', async () => (await poolNode(remote.id, 'stable-node')) && (await poolNode(remote.id, 'unused-node')))
    await until('local YAML node', () => poolNode(local.id, 'local-imported-node'))
    assert.ok(subscriptionCalls > 0, 'The gateway kernel must fetch the local HTTP subscription')
    const selected = await poolNode(remote.id, 'stable-node')
    const channel = await ok('/api/custom-providers', { name: 'Subscription account', baseUrl: `${originUrl}/v1`,
      protocol: 'chat_completions', keyGroups: [{ id: 'group-local', name: 'Local key', apiKeys: ['local-upstream-key'],
        models: ['wire-local'], enabled: true }] })
    const provider = (await ok('/api/custom-providers')).providers.find(item => item.id === channel.provider.id)
    const accountId = provider.keyGroups[0].accountIds[0]
    await ok(`/api/accounts/${accountId}`, { proxy: { source: 'pool', proxyId: selected.id } }, 'PATCH')
    const catalog = await ok('/api/routing/groups')
    await ok('/api/routing/groups', { revision: catalog.newRevision, id: 'subscription-smoke',
      group: { id: 'subscription-smoke', model: 'subscription-smoke', name: 'Subscription smoke', enabled: true,
        strategy: 'order', sticky: 'off', members: [{ id: 'subscription-source', provider: provider.id,
          model: 'wire-local', included: true, accountScope: 'selected', accounts: [accountId] }] } }, 'PUT')
    const readyNode = () => until('referenced node listener', async () => {
      const current = await poolNode(remote.id, 'stable-node')
      return current?.enabled && current.port && (await ok('/api/subscriptions/kernel')).running ? current : false
    })
    const chatBody = { model: 'subscription-smoke', stream: false, messages: [{ role: 'user', content: 'ping' }] }
    async function chatThrough(expectedPassword) {
      const previous = proxyCalls.length
      const response = await ok('/v1/chat/completions', chatBody)
      assert.equal(response.choices[0].message.content, 'local-only')
      assert.ok(proxyCalls.length > previous, 'Chat must traverse the selected subscription proxy')
      assert.equal(proxyCalls.at(-1), `Basic ${Buffer.from(`local-user:${expectedPassword}`).toString('base64')}`)
    }
    async function rejectChat() {
      const previous = originCalls
      const result = await request('/v1/chat/completions', chatBody)
      assert.ok(result.status >= 400, 'Unavailable proxy must fail closed')
      assert.equal(originCalls, previous, 'Unavailable proxy must not fall back to direct access')
    }
    await readyNode()
    await chatThrough('old-password')
    const chainNode = await poolNode(local.id, 'local-imported-node')
    await ok(`/api/accounts/${accountId}`, { proxy: { source: 'pool', proxyId: chainNode.id } }, 'PATCH')
    await until('chain listener', async () => (await poolNode(local.id, 'local-imported-node'))?.port
      && (await ok('/api/subscriptions/kernel')).running)
    const chainBefore = chainCalls
    await chatThrough('old-password')
    assert.ok(chainCalls > chainBefore, 'Full YAML dialer group must actually tunnel through the front proxy')
    const groupInput = { providerId: local.id, group: 'exit-group' }
    await ok('/api/subscriptions/groups/select', { providerId: local.id, group: 'front-group', node: 'second-front' })
    const groupNode = await poolNode(local.id, 'exit-group')
    assert.ok(groupNode, 'Exit group is a stable pool target')
    await ok(`/api/accounts/${accountId}`, { proxy: { source: 'pool', proxyId: groupNode.id } }, 'PATCH')
    await until('group listener', async () => (await poolNode(local.id, 'exit-group'))?.port
      && (await ok('/api/subscriptions/kernel')).running)
    const choose = (node) => ok('/api/subscriptions/groups/select', { ...groupInput, node })
    await choose('second-exit')
    await chatThrough('second-password')
    assert.equal(frontAuth.at(-1), `Basic ${Buffer.from('second-front:front-password').toString('base64')}`)
    const beforeSelection = (await ok('/api/subscriptions/groups/members', groupInput)).groups[0]
    assert.equal(beforeSelection.selected, 'second-exit')
    assert.equal(beforeSelection.members.length, 2)
    assert.ok(!JSON.stringify(beforeSelection).includes('password'))
    await rejected('/api/subscriptions/groups/select', { ...groupInput, node: 'front-node' })
    const speed = await ok('/api/subscriptions/groups/test', { ...groupInput, node: 'local-imported-node', kind: 'speed', id: 'speed-test', url: `${originUrl}/speed` })
    assert.equal(speed.success, true)
    assert.equal(speed.bytes, 5 * 1024 * 1024)
    assert.ok(speed.bytesPerSecond > 0)
    const latency = await ok('/api/subscriptions/groups/test', { ...groupInput, node: 'local-imported-node', kind: 'delay', id: 'latency-test', url: `${originUrl}/` })
    assert.equal(latency.success, true)
    assert.equal(typeof latency.delay, 'number')
    assert.equal((await ok('/api/subscriptions/groups/members', groupInput)).groups[0].selected, 'second-exit')
    const slow = ok('/api/subscriptions/groups/test', { ...groupInput, node: 'local-imported-node', kind: 'speed', id: 'cancel-test', url: `${originUrl}/slow-speed` })
    await until('active cancellable test', async () => (await ok('/api/subscriptions/groups/cancel', { id: 'cancel-test' })).canceled, 5000)
    assert.equal((await slow).success, false)
    const runtimeBeforeRestart = JSON.parse(await readFile(path.join((await ok('/api/subscriptions/kernel')).kernelDir, 'kernel-state.json'), 'utf8')).pid
    await ok('/api/subscriptions/kernel/restart', {})
    await until('restored group selection', async () => {
      const group = (await ok('/api/subscriptions/groups/members', groupInput)).groups[0]
      const state = await ok('/api/subscriptions/kernel')
      const pid = JSON.parse(await readFile(path.join(state.kernelDir, 'kernel-state.json'), 'utf8')).pid
      return group.available && group.selected === 'second-exit' && pid !== runtimeBeforeRestart && state.running
    })
    await chatThrough('second-password')
    assert.equal((await ok('/api/subscriptions/groups/members', { providerId: local.id, group: 'front-group' })).groups[0].selected, 'second-front')
    if (process.env.PLAYWRIGHT_MODULE) {
      const { checkGroupBrowser } = await import('./test-proxy-groups-browser.mjs')
      await checkGroupBrowser(base, adminKey, process.env.GROUP_SCREENSHOT_DIR || temp)
    }
    await ok(`/api/accounts/${accountId}`, { proxy: { source: 'pool', proxyId: selected.id } }, 'PATCH')
    await readyNode()
    await toggle(remote.id, false)
    await rejected('/api/subscriptions/refresh', { id: remote.id })
    await until('paused node without listener', async () => {
      const current = await poolNode(remote.id, 'stable-node')
      return current?.id === selected.id && !current.enabled && current.port === null
    })
    assert.equal((await account(accountId)).proxy.config.proxyId, selected.id)
    await rejectChat()
    await toggle(remote.id, true)
    assert.equal((await readyNode()).id, selected.id, 'Resume must reuse the original pool ID')
    assert.equal((await account(accountId)).proxy.config.proxyId, selected.id)
    await chatThrough('old-password')

    remoteNodes = [
      { ...node('stable-node', 'localhost', 'new-password'), 'dialer-proxy': 'front-group' },
      node('unused-node'),
      { name: 'front-node', type: 'http', server: '127.0.0.1', port: front.address().port },
    ]
    remoteGroups = [{ name: 'front-group', type: 'select', proxies: ['front-node'] }]
    const fetchedBefore = subscriptionCalls
    const kernelBefore = await ok('/api/subscriptions/kernel')
    const pidBefore = JSON.parse(await readFile(path.join(kernelBefore.kernelDir, 'kernel-state.json'), 'utf8')).pid
    await ok('/api/subscriptions/refresh', { id: remote.id })
    await until('same-name server/password refresh', async () => {
      const state = await ok('/api/subscriptions/kernel')
      const config = await readFile(path.join(state.kernelDir, 'config.yaml'), 'utf8').catch(() => '')
      const runtime = await readFile(path.join(state.kernelDir, 'kernel-state.json'), 'utf8').then(JSON.parse).catch(() => ({}))
      return subscriptionCalls > fetchedBefore && state.running && runtime.pid && runtime.pid !== pidBefore
        && config.includes('server: localhost') && config.includes('password: new-password')
    })
    assert.equal((await readyNode()).id, selected.id)
    const refreshedChainBefore = chainCalls
    await chatThrough('new-password')
    assert.ok(chainCalls > refreshedChainBefore, 'Remote full YAML refresh must preserve its chain group')
    await ok('/api/subscriptions/remove', { id: remote.id })
    await until('deleted subscription pool cleanup', async () => !(await pool()).some(item => item.providerId === remote.id))
    const retained = (await account(accountId)).proxy
    assert.equal(retained.config.proxyId, selected.id, 'Deletion retains a diagnosable account reference')
    assert.ok(retained.error, 'Deleted-node reference must show an error')
    await rejectChat()
    await ok(`/api/accounts/${accountId}`, { proxy: { source: 'direct' } }, 'PATCH')
    assert.equal((await account(accountId)).proxy.source, 'direct', 'The stale reference must be editable')
    console.log('PASS: local HTTP pull, full YAML chain group import and two-hop traffic, lazy listener, pause/resume identity and account reference, same-name server/password refresh, proxy traffic, delete cleanup and fail-closed stale reference')
  }

  for (const item of (await ok('/api/subscriptions')).items) await ok('/api/subscriptions/remove', { id: item.id })
  assert.deepEqual((await ok('/api/subscriptions')).items, [])
  await rejected('/api/subscriptions/refresh', { id: remote.id }, 404)
  if (kernelSource) {
    await until('kernel stopped after final subscription deletion', async () => !(await ok('/api/subscriptions/kernel')).running)
    assert.equal((await pool()).filter(item => item.source === 'subscription').length, 0)
  }
  console.log('PASS: subscription URL/YAML validation, duplicate rejection, local-content edit preservation, disabled/local/missing refresh errors and subscription CRUD')
} catch (error) {
  console.error(logs)
  console.error(error)
  throw error
} finally {
  if (child && child.exitCode === null && child.signalCode === null && !spawnError) {
    // Let the managed worker stop its child before terminating the gateway.
    await request('/api/subscriptions/kernel/stop', {}).catch(() => {})
    for (let attempt = 0; attempt < 180; attempt++) {
      const status = await request('/api/subscriptions/kernel').catch(() => null)
      if (!status || (!status.body.running && status.body.halted)) break
      await delay(300)
    }
    child.kill()
  }
  if (childExit) await childExit
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))))
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep))
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
