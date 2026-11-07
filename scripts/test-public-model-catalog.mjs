import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// node scripts/test-public-model-catalog.mjs /path/to/server [--live]
// Default: deterministic disk/memory cache and failed-refresh HTTP acceptance.
// --live: additionally download from the real fixed PublicProviderConf source.
const binary = path.resolve(process.argv[2] || 'target/debug/agent2api-server.exe')
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceUrl = 'https://raw.githubusercontent.com/ThinkInAIXYZ/PublicProviderConf/refs/heads/dev/dist/all.json'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent2api-catalog-http-'))
const key = `catalog-smoke-${randomUUID()}`
const fixture = { providers: [{ id: 'test-vendor', name: 'Test Vendor', models: [{ id: 'Case/Model', name: 'Selected model', kind: 'chat' }] }],
  sourceUrl, fetchedAt: new Date().toISOString(), updatedAt: '2026-11-06T19:19:22.445Z', stale: false }
const proxySockets = new Set()
const failingProxy = net.createServer(socket => {
  proxySockets.add(socket)
  socket.on('close', () => proxySockets.delete(socket))
  socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
})
await new Promise(resolve => failingProxy.listen(0, '127.0.0.1', resolve))
let child
let base
let output = ''
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
  child = undefined
}

async function start(data, offline) {
  const reserved = net.createServer()
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve))
  const port = reserved.address().port
  await new Promise(resolve => reserved.close(resolve))
  const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
    AGENT2API_PROXY_HOME: data, AGENT2API_PROXY_API_KEY: key, AGENT2API_UI_DIR: path.join(repository, 'desktop-tauri/ui'),
    AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0' }
  for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH', 'AGENT2API_ALLOW_NO_KEY']) delete env[name]
  if (offline) {
    const proxy = `http://127.0.0.1:${failingProxy.address().port}`
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = proxy
    env.NO_PROXY = env.no_proxy = ''
  }
  base = `http://127.0.0.1:${port}`
  child = spawn(binary, [], { cwd: path.dirname(binary), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-24000) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-24000) })
  child.on('error', error => { output += String(error) })
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}: ${output}`)
    try { if ((await fetch(`${base}/health`)).ok) return } catch {}
    await pause(250)
  }
  throw new Error('Server did not start within 30 seconds')
}

async function api(endpoint, method = 'GET') {
  const response = await fetch(`${base}${endpoint}`, { method, headers: { 'x-api-key': key } })
  const result = await response.json()
  assert(response.ok && result.success, `${method} ${endpoint}: ${response.status} ${JSON.stringify(result)}`)
  return result.data
}

try {
  const data = path.join(directory, 'cached')
  await fs.mkdir(data)
  const cacheFile = path.join(data, 'public-model-catalog.json')
  const saved = JSON.stringify(fixture)
  await fs.writeFile(cacheFile, saved)
  await start(data, true)
  const loaded = await api('/api/models/public-catalog')
  assert.deepEqual(loaded.providers, fixture.providers)
  assert.equal(loaded.stale, false)
  assert.equal(loaded.fetchedAt, fixture.fetchedAt)
  const refreshed = await api('/api/models/public-catalog', 'POST')
  assert.deepEqual(refreshed.providers, fixture.providers)
  assert.equal(refreshed.stale, true)
  assert(refreshed.error)
  assert.equal(await fs.readFile(cacheFile, 'utf8'), saved, 'Failed fetch overwrote the last good disk cache')
  assert.deepEqual((await api('/api/models/catalog')).models, [], 'Public candidates were published automatically')
  assert.equal((await api('/api/models/public-catalog')).stale, true)
  await stop()
  await fs.writeFile(cacheFile, JSON.stringify({ ...fixture, fetchedAt: '2000-01-01T00:00:00Z' }))
  await start(data, true)
  const restored = await api('/api/models/public-catalog')
  assert.deepEqual(restored.providers, fixture.providers)
  assert.equal(restored.stale, true)
  await stop()
  console.log('PASS: actual HTTP routes, fresh disk cache, failed refresh with stale fallback, disk preservation, restart recovery and no automatic publication')

  if (process.argv.includes('--live')) {
    await start(path.join(directory, 'live'), false)
    const downloaded = await api('/api/models/public-catalog')
    assert.equal(downloaded.sourceUrl, sourceUrl)
    assert.equal(downloaded.stale, false)
    assert(downloaded.providers.length > 0)
    assert(downloaded.providers.some(provider => provider.id === 'openai' && provider.models.length > 0))
    const cached = await api('/api/models/public-catalog')
    assert.equal(cached.fetchedAt, downloaded.fetchedAt)
    assert.deepEqual((await api('/api/models/catalog')).models, [])
    console.log(`PASS: live fixed-source fetch, ${downloaded.providers.length} providers / ${downloaded.providers.reduce((sum, provider) => sum + provider.models.length, 0)} models; subsequent request reused cache`)
  }
} catch (error) {
  console.error(error)
  console.error(output)
  throw error
} finally {
  await stop()
  for (const socket of proxySockets) socket.destroy()
  await new Promise(resolve => failingProxy.close(resolve))
  await fs.rm(directory, { recursive: true, force: true })
}
