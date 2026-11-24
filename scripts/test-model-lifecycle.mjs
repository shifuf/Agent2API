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
  if (body.stream) {
    response.setHeader('Content-Type', 'text/event-stream')
    const frame = { id: 'chatcmpl-lifecycle', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: { content: body.model }, finish_reason: null }] }
    response.end(`data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    return
  }
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
async function request(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + endpoint, { method,
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  return { status: response.status, body: result.success === true ? result.data : result }
}
async function ok(endpoint, body, method) {
  const result = await request(endpoint, body, method)
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

async function currentGroupLifecycle() {
  const groupsEndpoint = '/api/routing/groups'
  const state = () => ok(groupsEndpoint)
  const initial = await state()
  await ok('/api/routing/groups/actions', { action: 'discovery', enabled: false, revision: initial.collectionRevision })
  const saveGroup = async group => {
    const current = await state()
    return ok(groupsEndpoint, { id: group.id, group,
      revision: current.groups.find(row => row.group.id === group.id)?.revision ?? current.newRevision }, 'PUT')
  }
  const rejectGroup = async (payload, status) => {
    const before = await state()
    const response = await request(groupsEndpoint, payload, 'PUT')
    assert.equal(response.status, status, `Expected atomic group rejection: ${JSON.stringify(response.body)}`)
    const after = await state()
    assert.deepEqual(after.groups, before.groups, 'Rejected writes must leave all routing groups unchanged')
    assert.equal(after.collectionRevision, before.collectionRevision)
  }
  const draft = { id: 'lifecycle', model: 'Public/Lifecycle', name: 'Before any channel', enabled: false,
    kind: 'chat', strategy: 'order', sticky: 'off', members: [] }
  await saveGroup(draft)
  assert.deepEqual(await publicIds(), [])
  await saveGroup({ ...draft, enabled: true })
  assert.deepEqual(await publicIds(), [], 'An enabled but unbound group stays private')
  await denied(draft.model)
  const channel = await ok('/api/custom-providers', { name: 'Lifecycle channel', protocol: 'chat_completions',
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [
      { id: 'lifecycle', name: 'Primary', apiKeys: ['fake-lifecycle-key'], models: ['wire-model'], enabled: true },
    ] })
  const member = { id: 'source', provider: channel.provider.id, model: 'wire-model', included: true,
    accountScope: 'selected', accounts: channel.accounts.map(account => account.id) }
  const published = { ...draft, enabled: true, members: [member] }
  await saveGroup(published)
  assert.deepEqual(await publicIds(), [published.model])
  const reply = await ok('/v1/chat/completions', { model: published.model, messages: [{ role: 'user', content: 'ping' }] })
  assert.equal(reply.model, published.model)
  assert.equal(reply.choices[0].message.content, 'wire-model', 'Only the explicitly selected upstream model is sent')
  const stored = (await state()).groups.find(row => row.group.id === draft.id)
  const stale = stored.revision
  await saveGroup({ ...published, name: 'Edited route' })
  const edited = (await state()).groups.find(row => row.group.id === draft.id).group
  assert.equal(edited.name, 'Edited route')
  assert.deepEqual(edited.members, stored.group.members, 'An ordinary edit must preserve the selected source and account scope')
  await rejectGroup({ id: draft.id, group: { ...published, enabled: false }, revision: stale }, 409)
  await rejectGroup({ id: 'duplicate', group: { ...published, id: 'duplicate', model: published.model.toUpperCase() },
    revision: (await state()).newRevision }, 400)
  await rejectGroup({ id: 'invalid', group: { ...published, id: 'invalid', model: '' },
    revision: (await state()).newRevision }, 400)
  await ok('/api/keys', { name: 'Lifecycle selection', key: 'fake-lifecycle-client',
    allowedProviders: [channel.provider.id], allowedModels: [published.model] })
  const keysBefore = (await ok('/api/keys')).keys
  await saveGroup({ ...published, enabled: false })
  assert.deepEqual(await publicIds(), [])
  assert.ok(!Object.values((await ok('/api/keys')).modelsByProvider).flat().includes(published.model))
  await denied(published.model)
  assert.deepEqual((await ok('/api/keys')).keys, keysBefore, 'Publication must preserve existing Key material')
  await saveGroup(published)
  assert.deepEqual(await publicIds(), [published.model])
  const renamed = { ...published, model: 'Renamed/Lifecycle' }
  await saveGroup(renamed)
  assert.deepEqual(await publicIds(), [renamed.model])
  await denied(published.model)
  const renamedReply = await ok('/v1/chat/completions', { model: renamed.model, messages: [{ role: 'user', content: 'ping' }] })
  assert.equal(renamedReply.model, renamed.model)
  assert.equal(renamedReply.choices[0].message.content, 'wire-model')
  const current = await state()
  await ok(groupsEndpoint, { id: draft.id, group: null,
    revision: current.groups.find(row => row.group.id === draft.id).revision }, 'PUT')
  assert.deepEqual((await state()).groups, [])
  assert.deepEqual(await publicIds(), [])
  await denied(renamed.model)
  assert.equal((await request(endpoint, { model: { id: 'retired-write', bindings: [] } })).status, 410,
    'The retired model catalog must not recreate a second public model manager')
  assert.deepEqual((await state()).groups, [])
  console.log('PASS: current routing-group model lifecycle, private unbound drafts, selected source, public IDs, edits, atomic validation, stale revisions, disable/enable, rename/delete, Key choices and retired catalog isolation')
}

try {
  let currentGroups = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Gateway exited ${child.exitCode}`)
    try {
      const response = await request(endpoint)
      if (response.status === 410 || response.status === 200 && response.body.retired === true) {
        if (response.status === 200) assert.equal(response.body.replacement, '/api/routing/groups')
        await ok('/api/routing/groups'); currentGroups = true; break
      }
      if (response.status === 200) { catalog = response.body; break }
    } catch {}
    await delay(250)
  }
  assert.ok(currentGroups || catalog, 'Gateway did not become ready')
  if (currentGroups) {
    await currentGroupLifecycle()
  } else {
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
  }
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
