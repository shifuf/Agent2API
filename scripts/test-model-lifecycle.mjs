// node scripts/test-model-lifecycle.mjs <freshly-built-agent2api-server>
// Runs only against a new temporary data directory and a local fake upstream.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const executable = path.resolve(process.argv[2] || 'target/debug/agent2api-server.exe')
await access(executable)
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-model-lifecycle-'))
const adminKey = 'model-lifecycle-isolated-admin'
let calls = 0
const upstream = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  calls += 1
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ id: 'chatcmpl-lifecycle', object: 'chat.completion', model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: body.model }, finish_reason: 'stop' }] }))
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
const reserved = http.createServer()
reserved.listen(0, '127.0.0.1')
await once(reserved, 'listening')
const port = reserved.address().port
await new Promise(resolve => reserved.close(resolve))
const base = `http://127.0.0.1:${port}`
let output = ''
const child = spawn(executable, [], { windowsHide: true, cwd: directory,
  env: { ...process.env, AGENT2API_PROXY_HOME: directory, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
    AGENT2API_PROXY_API_KEY: adminKey, AGENT2API_ACCOUNT_KEY: '3'.repeat(64), AGENT2API_SELF_UPDATE: '0',
    AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' },
  stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', chunk => { output = (output + chunk).slice(-24000) })
child.stderr.on('data', chunk => { output = (output + chunk).slice(-24000) })
const exited = once(child, 'exit')
async function request(endpoint, body) {
  const response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  return { status: response.status, body: result.success === true ? result.data : result }
}
async function ok(endpoint, body) {
  const result = await request(endpoint, body)
  assert.equal(result.status, 200, `${endpoint}: ${JSON.stringify(result.body)}`)
  return result.body
}
const endpoint = '/api/models/catalog'
let catalog
async function save(model, previousId = '') {
  catalog = await ok(endpoint, { model, previousId, revision: catalog.revision })
}
async function batch(action, values) {
  catalog = await ok(endpoint, { action, ...values, revision: catalog.revision })
}
async function reject(body) {
  const before = await ok(endpoint)
  const response = await request(endpoint, { revision: before.revision, ...body })
  assert.equal(response.status, 400, `Expected atomic rejection: ${JSON.stringify(response.body)}`)
  assert.deepEqual(await ok(endpoint), before, 'Rejected writes must leave the catalog unchanged')
}
async function publicIds() { return (await ok('/v1/models')).data.map(model => model.id).sort() }
async function denied(id) {
  const before = calls
  const result = await request('/v1/chat/completions', { model: id, messages: [{ role: 'user', content: 'ping' }] })
  assert.ok(result.status >= 400, `Unpublished model ${id} was accepted`)
  assert.equal(calls, before, 'Rejected model must never reach an upstream')
}

try {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Gateway exited ${child.exitCode}`)
    try { catalog = await ok(endpoint); break } catch {}
    await delay(250)
  }
  assert.ok(catalog, 'Gateway did not become ready')
  // Regression: creation previously required a channel binding.
  await save({ id: 'standalone', name: 'Before any channel', enabled: false, bindings: [] })
  assert.deepEqual(await publicIds(), [])
  await batch('enable', { ids: ['standalone'] })
  assert.deepEqual(await publicIds(), [], 'An enabled but unbound model stays private')
  await denied('standalone')
  const card = { reasoning: { supported: true, default: false }, reasoningEfforts: ['low', 'high'],
    toolCall: true, temperature: false, vision: true, modalities: { input: ['text', 'image'], output: ['text'] },
    cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }, limit: { context: 200000, output: 16000 },
    knowledge: '2026-01', releaseDate: '2026-03-01', lastUpdated: '2026-04-01' }
  const draft = { id: 'metadata', name: 'Model card', enabled: false, bindings: [], developer: 'openai',
    type: 'chat', icon: 'OpenAI', group: 'gpt', remark: 'Line one\nLine two', modelCard: card }
  await save(draft)
  const created = catalog.models.find(model => model.id === 'metadata')
  assert.deepEqual(created.modelCard, card)
  assert.ok(!Number.isNaN(Date.parse(created.createdAt)))
  assert.ok(!Number.isNaN(Date.parse(created.updatedAt)))
  await save({ id: 'metadata', name: 'Old client edit', enabled: false, bindings: [] }, 'metadata')
  const edited = catalog.models.find(model => model.id === 'metadata')
  for (const field of ['developer', 'type', 'icon', 'group', 'remark', 'modelCard', 'createdAt']) {
    assert.deepEqual(edited[field], created[field], `Legacy edit dropped ${field}`)
  }
  await batch('create', { models: [{ id: 'batch-a', name: 'A', bindings: [] }, { id: 'batch-b', name: 'B', bindings: [] }] })
  assert.equal(catalog.models.find(model => model.id === 'batch-a').enabled, false)
  await reject({ action: 'create', models: [{ id: 'atomic-new', bindings: [] }, { id: 'BATCH-A', bindings: [] }] })
  await reject({ action: 'create', models: [{ id: 'duplicate', bindings: [] }, { id: 'DUPLICATE', bindings: [] }] })
  await reject({ action: 'create', models: [{ id: 'atomic-new', bindings: [] }, { id: 'bad id', bindings: [] }] })
  await reject({ action: 'create', models: Array.from({ length: 101 }, (_, index) => ({ id: `too-many-${index}`, bindings: [] })) })
  await reject({ action: 'enable', ids: ['batch-a', 'missing'] })
  await reject({ action: 'delete', ids: ['batch-a', 'BATCH-A'] })
  await reject({ action: 'create', ids: ['batch-a'], models: [{ id: 'mixed', bindings: [] }] })
  await reject({ model: { ...draft, id: 'bad-card', modelCard: { toolCall: 'yes' } } })
  await reject({ model: { ...draft, id: 'bad-cost', modelCard: { cost: { input: -1 } } } })
  await reject({ model: { ...draft, id: 'bad-limit', modelCard: { limit: { output: 1.5 } } } })
  await reject({ model: { ...draft, id: 'long-remark', remark: 'x'.repeat(4001) } })
  const stale = catalog.revision
  await batch('disable', { ids: ['standalone'] })
  await reject({ action: 'delete', ids: ['batch-a'], revision: stale })

  const channel = await ok('/api/custom-providers', { name: 'Lifecycle channel', protocol: 'chat_completions',
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [
      { id: 'lifecycle', name: 'Primary', apiKeys: ['fake-lifecycle-key'], models: ['wire-model'], enabled: true },
    ] })
  const published = { id: 'published', name: 'Published', enabled: true, bindings: [{ provider: channel.provider.id, model: 'wire-model' }] }
  await save(published)
  assert.deepEqual(await publicIds(), ['published'])
  const originalCapabilities = (await ok('/v1/models')).data.find(model => model.id === 'published')
  await save({ ...published, modelCard: { toolCall: !originalCapabilities.supports_tool_call,
    vision: !originalCapabilities.supports_images, limit: { context: 777777 } } }, published.id)
  const describedCapabilities = (await ok('/v1/models')).data.find(model => model.id === 'published')
  for (const field of ['supports_tool_call', 'supports_images', 'max_input_tokens']) {
    assert.deepEqual(describedCapabilities[field], originalCapabilities[field], `Model card must not override upstream ${field}`)
  }
  await batch('archive', { ids: ['published', 'batch-a'] })
  assert.equal(catalog.models.find(model => model.id === 'published').archived, true)
  assert.deepEqual(await publicIds(), [])
  assert.ok(!Object.values((await ok('/api/keys')).modelsByProvider).flat().includes('published'))
  await denied('published')
  await save({ ...published, name: 'Legacy edit while archived' }, published.id)
  assert.equal(catalog.models.find(model => model.id === 'published').archived, true)
  assert.deepEqual(await publicIds(), [], 'An older client must not accidentally restore an archived model')
  await batch('restore', { ids: ['published'] })
  assert.equal(catalog.models.find(model => model.id === 'published').enabled, false, 'Restore requires an explicit later enable')
  await batch('enable', { ids: ['published'] })
  assert.deepEqual(await publicIds(), ['published'])
  assert.deepEqual(catalog.models.find(model => model.id === 'published').bindings, published.bindings)
  await batch('delete', { ids: ['published', 'batch-a', 'batch-b', 'metadata', 'standalone'] })
  assert.deepEqual(catalog.models, [])
  assert.deepEqual(await publicIds(), [])
  console.log('PASS: standalone models, metadata round-trip, legacy edits, default-disabled batches, atomic validation/conflicts, stale revisions, archive/restore/publication and gateway Key choices')
} catch (error) {
  console.error(output)
  throw error
} finally {
  child.kill()
  await exited
  await new Promise(resolve => upstream.close(resolve))
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
  await rm(directory, { recursive: true, force: true })
}
