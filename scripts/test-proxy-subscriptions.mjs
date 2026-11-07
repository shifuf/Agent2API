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
let child, childExit, spawnError, base, logs = '', originCalls = 0, subscriptionCalls = 0
const proxyCalls = []
let remoteNodes = []

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
    if (req.url === '/subscription.yaml') {
      subscriptionCalls++
      res.writeHead(200, { 'Content-Type': 'application/yaml', 'Cache-Control': 'no-store' })
      res.end(yaml(remoteNodes))
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
  const localNodes = [node('local-imported-node')]
  const reserve = await listen((_req, res) => res.end())
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  base = `http://127.0.0.1:${port}`
  const env = { ...process.env, AGENT2API_PROXY_HOME: temp, AGENT2API_HOST: '127.0.0.1',
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
  const localInput = { name: 'Imported YAML', fileName: 'local.yaml', contentBase64: encoded(localNodes) }
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
    let catalog = await ok('/api/models/catalog')
    await ok('/api/models/catalog', { revision: catalog.revision, model: { id: 'subscription-smoke', name: 'Subscription smoke',
      enabled: true, bindings: [{ provider: provider.id, model: 'wire-local' }] } })
    const readyNode = () => until('referenced node listener', async () => {
      const current = await poolNode(remote.id, 'stable-node')
      return current?.enabled && current.port && (await ok('/api/subscriptions/kernel')).running ? current : false
    })
    const chatBody = { model: 'subscription-smoke', stream: false, messages: [{ role: 'user', content: 'ping' }] }
    async function chatThrough(expectedPassword) {
      const previous = proxyCalls.length
      await ok('/v1/chat/completions', chatBody)
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

    remoteNodes = [node('stable-node', 'localhost', 'new-password'), node('unused-node')]
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
    await chatThrough('new-password')
    await ok('/api/subscriptions/remove', { id: remote.id })
    await until('deleted subscription pool cleanup', async () => !(await pool()).some(item => item.providerId === remote.id))
    const retained = (await account(accountId)).proxy
    assert.equal(retained.config.proxyId, selected.id, 'Deletion retains a diagnosable account reference')
    assert.ok(retained.error, 'Deleted-node reference must show an error')
    await rejectChat()
    await ok(`/api/accounts/${accountId}`, { proxy: { source: 'direct' } }, 'PATCH')
    assert.equal((await account(accountId)).proxy.source, 'direct', 'The stale reference must be editable')
    console.log('PASS: local HTTP pull, YAML node import, lazy listener, pause/resume identity and account reference, same-name server/password refresh, proxy traffic, delete cleanup and fail-closed stale reference')
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
