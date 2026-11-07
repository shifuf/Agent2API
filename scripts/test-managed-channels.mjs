// Run against a freshly built headless binary. All data and upstreams are local.
// node scripts/test-managed-channels.mjs <path-to-agent2api-server>
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const executable = process.argv[2]
assert.ok(executable, 'Pass the built agent2api-server binary path')
await access(path.resolve(executable))
const temp = await mkdtemp(path.join(os.tmpdir(), 'agent2api-channels-test-'))
const adminKey = 'integration-admin-key-local-only'
const calls = []
const upstream = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  const key = String(request.headers.authorization || '').replace(/^Bearer /, '')
  if (request.method === 'GET') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ object: 'list', data: [{ id: key === 'key-a-one' ? 'wire-a' : 'wire-b', object: 'model' }] }))
    return
  }
  calls.push({ key, model: body.model, path: request.url, reasoning: body.reasoning_effort })
  if (body.stream) {
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: `${key}/${body.model}` }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({
      id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\ndata: [DONE]\n\n`)
    return
  }
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: `${key}/${body.model}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`
const reserve = http.createServer()
reserve.listen(0, '127.0.0.1')
await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
let logs = ''
const child = spawn(path.resolve(executable), [], { windowsHide: true, cwd: temp,
  env: { ...process.env, AGENT2API_PROXY_HOME: temp, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
    AGENT2API_PROXY_API_KEY: adminKey, AGENT2API_ACCOUNT_KEY: '2'.repeat(64), AGENT2API_SELF_UPDATE: '0',
    AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' },
  stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-30000) })
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-30000) })
const childExit = once(child, 'exit')
const base = `http://127.0.0.1:${port}`
async function request(endpoint, body, key = adminKey, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) })
  const json = await response.json()
  return { status: response.status, body: json.success === true && Object.hasOwn(json, 'data') ? json.data : json }
}
async function ok(endpoint, body, key, method) {
  const result = await request(endpoint, body, key, method)
  assert.equal(result.status, 200, `${endpoint}: ${JSON.stringify(result.body)}`)
  return result.body
}
async function models(key) { return (await ok('/v1/models', undefined, key)).data.map(item => item.id).sort() }
async function chat(model, key, expectedKey, expectedModel) {
  const before = calls.length
  const result = await ok('/v1/chat/completions', { ...(model ? { model } : {}), stream: false, messages: [{ role: 'user', content: 'ping' }] }, key)
  assert.equal(result.choices[0].message.content, `${expectedKey}/${expectedModel}`)
  if (model) assert.equal(result.model, model, 'Responses keep the public model ID')
  assert.equal(calls.length, before + 1)
  assert.equal(calls.at(-1).key, expectedKey)
  assert.equal(calls.at(-1).model, expectedModel)
}
async function denied(model, key) {
  const before = calls.length
  const result = await request('/v1/chat/completions', { ...(model ? { model } : {}), messages: [{ role: 'user', content: 'ping' }] }, key)
  assert.ok(result.status >= 400, `Expected rejection for ${model}: ${JSON.stringify(result.body)}`)
  assert.equal(calls.length, before, 'Rejected requests must not reach any upstream')
}

try {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Gateway exited: ${child.exitCode}`)
    try { await ok('/api/models/catalog'); ready = true; break } catch {}
    await delay(500)
  }
  assert.ok(ready, 'Gateway did not become ready')
  assert.deepEqual(await models(), [])
  await denied('', adminKey)
  await denied('wire-a', adminKey)

  const makeChannel = (name, keyGroups) => ok('/api/custom-providers', { name, baseUrl: upstreamUrl, protocol: 'chat_completions', keyGroups })
  const a = await makeChannel('Channel A', [
    { id: 'a1', name: 'First group', apiKeys: ['key-a-one'], models: ['wire-a'], enabled: true },
    { id: 'a2', name: 'Second group', apiKeys: ['key-a-two'], models: ['wire-b'], enabled: true },
  ])
  const b = await makeChannel('Channel B', [{ id: 'b1', name: 'Other channel', apiKeys: ['key-b-one'], models: ['wire-z'], enabled: true }])
  const aid = a.provider.id, bid = b.provider.id
  assert.deepEqual(await models(), [], 'Discovering channel models must not publish them')
  const discovered = await ok('/api/custom-providers/fetch-models', { protocol: 'chat_completions', baseUrl: upstreamUrl, apiKey: 'key-a-one' })
  assert.ok(JSON.stringify(discovered).includes('wire-a'))
  assert.deepEqual(await models(), [])
  let catalog = await ok('/api/models/catalog')
  async function save(model, previousId = '') {
    catalog = await ok('/api/models/catalog', { previousId, model, revision: catalog.revision })
  }
  const shared = { id: 'shared-public', name: 'Shared', enabled: true, bindings: [{ provider: aid, model: 'wire-a' }, { provider: bid, model: 'wire-z' }] }
  const staleRevision = catalog.revision
  await save(shared)
  // A public name may equal another upstream ID; associations must resolve once.
  await save({ id: 'wire-a', name: 'One-hop collision', enabled: true, bindings: [{ provider: aid, model: 'wire-b' }] })
  assert.equal((await request('/api/models/catalog', { model: shared, revision: staleRevision })).status, 400)
  assert.deepEqual(await models(), ['shared-public', 'wire-a'])
  async function makeKey(name, allowedProviders, allowedModels) {
    return (await ok('/api/keys', { name, key: `integration-${name}-key`, allowedProviders, allowedModels })).created
  }
  const aKey = await makeKey('channel-a', [aid], ['shared-public'])
  const bKey = await makeKey('channel-b', [bid], ['shared-public'])
  const otherKey = await makeKey('second-model', [aid], ['wire-a'])
  assert.deepEqual(await models(aKey.key), ['shared-public'])
  assert.deepEqual(await models(bKey.key), ['shared-public'])
  assert.deepEqual(await models(otherKey.key), ['wire-a'])
  await chat('shared-public', aKey.key, 'key-a-one', 'wire-a')
  await chat('shared-public', bKey.key, 'key-b-one', 'wire-z')
  await chat('wire-a', otherKey.key, 'key-a-two', 'wire-b')
  await chat('', otherKey.key, 'key-a-two', 'wire-b')
  const sourceChannel = (await ok('/api/custom-providers')).providers.find(provider => provider.id === aid)
  const sourceAccount = sourceChannel.keyGroups.find(group => group.id === 'a1').accountIds[0]
  const beforeSourceTest = calls.length
  const sourceTest = await ok('/api/models/test', { provider: aid, model: 'wire-a',
    account_id: sourceAccount, stream: false, prompt: 'ping' }, adminKey)
  assert.equal(sourceTest.success, true, `Source model test failed: ${JSON.stringify(sourceTest)}`)
  assert.equal(sourceTest.upstream_model, 'wire-a', 'Source tests must bypass same-named public model bindings')
  assert.equal(calls.length, beforeSourceTest + 1)
  assert.equal(calls.at(-1).key, 'key-a-one')
  assert.equal(calls.at(-1).model, 'wire-a')
  const sourceDenied = await request('/api/models/test', { provider: aid, model: 'wire-a',
    account_id: sourceAccount, stream: false, prompt: 'ping' }, otherKey.key)
  assert.equal(sourceDenied.status, 404, 'A public name cannot grant a same-named upstream outside its binding')
  assert.equal(calls.length, beforeSourceTest + 1)
  const permittedSource = await ok('/api/models/test', { provider: aid, model: 'wire-b',
    account_id: sourceChannel.keyGroups.find(group => group.id === 'a2').accountIds[0], stream: false, prompt: 'ping' }, otherKey.key)
  assert.equal(permittedSource.success, true, JSON.stringify(permittedSource))
  assert.equal(calls.at(-1).model, 'wire-b')
  assert.equal(calls.at(-1).key, 'key-a-two')
  // Source mappings retain their target and reasoning even if a public model has that same alias.
  await ok('/api/custom-providers/models', { providerId: aid, models: sourceChannel.models,
    mappings: [{ alias: 'legacy-source-alias', target: 'wire-a', enabled: true, reasoning: 'high' }] })
  await save({ id: 'legacy-source-alias', name: '', enabled: true, bindings: [{ provider: aid, model: 'wire-b' }] })
  const mappedSource = await ok('/api/models/test', { provider: aid, model: 'legacy-source-alias',
    account_id: sourceAccount, stream: false, prompt: 'ping' }, aKey.key)
  assert.equal(mappedSource.success, true, JSON.stringify(mappedSource))
  assert.equal(calls.at(-1).model, 'wire-a')
  assert.equal(calls.at(-1).key, 'key-a-one')
  assert.equal(calls.at(-1).reasoning, 'high', 'Original source binding reasoning must survive source testing')
  await save(null, 'legacy-source-alias')
  await ok('/api/custom-providers/update', { id: aid, enabled: false })
  assert.deepEqual(await models(aKey.key), [])
  await denied('shared-public', aKey.key)
  await chat('shared-public', adminKey, 'key-b-one', 'wire-z')
  await ok('/api/custom-providers/update', { id: aid, enabled: true })
  await denied('wire-b', adminKey)
  await denied('wire-a', aKey.key)
  await denied('shared-public', otherKey.key)
  await save({ ...shared, enabled: false }, shared.id)
  await denied('shared-public', aKey.key)
  await save(shared, shared.id)

  const providers = (await ok('/api/custom-providers')).providers
  const groups = providers.find(provider => provider.id === aid).keyGroups
  assert.ok(!JSON.stringify(providers).includes('key-a-one'), 'Channel list must not leak raw upstream keys')
  const routing = await ok('/api/routing/groups')
  await ok('/api/routing/groups', { id: 'smoke-route', revision: routing.newRevision,
    group: { id: 'smoke-route', name: 'Smoke route', model: 'route-smoke', strategy: 'order', sticky: 'off',
      members: [{ id: 'member-a', provider: aid, model: 'wire-a', included: true, accounts: groups.find(group => group.id === 'a1').accountIds }] } }, adminKey, 'PUT')
  const routeKey = await makeKey('route', [aid], ['route-smoke'])
  assert.deepEqual(await models(routeKey.key), ['route-smoke'])
  assert.ok((await ok('/api/keys')).modelsByProvider[aid].includes('route-smoke'))
  await chat('route-smoke', routeKey.key, 'key-a-one', 'wire-a')
  const retained = groups.map(group => ({ id: group.id, name: group.name, enabled: group.id !== 'a1',
    apiKeys: [], accountIds: group.accountIds, models: group.models }))
  await ok('/api/custom-providers/update', { id: aid, keyGroups: retained })
  assert.deepEqual(await models(aKey.key), [], 'Disabled groups must disappear from the scoped catalog')
  assert.deepEqual(await models(routeKey.key), [])
  assert.ok(!(await ok('/api/keys')).modelsByProvider[aid].includes('route-smoke'))
  await denied('route-smoke', routeKey.key)
  await denied('shared-public', aKey.key)
  await chat('wire-a', otherKey.key, 'key-a-two', 'wire-b')
  await chat('shared-public', bKey.key, 'key-b-one', 'wire-z')
  retained[0].enabled = true
  retained[0].models = []
  await ok('/api/custom-providers/update', { id: aid, keyGroups: retained })
  await denied('shared-public', aKey.key)

  await ok('/api/custom-providers/remove', { id: bid })
  const keys = await ok('/api/keys')
  assert.deepEqual(keys.keys.find(key => key.id === bKey.id).allowedProviders, [bid])
  await ok(`/api/keys/${bKey.id}`, { name: 'Still restricted', allowedProviders: [bid] }, adminKey, 'PATCH')
  assert.equal((await request('/api/keys', { name: 'unknown', allowedProviders: [bid] })).status, 400)
  assert.deepEqual(await models(bKey.key), [])
  await denied('shared-public', bKey.key)
  await denied('wire-a', bKey.key)
  // A stale association may be disabled or deleted even after its channel is gone.
  await save({ ...shared, enabled: false }, shared.id)
  await save(null, shared.id)
  assert.deepEqual(await models(), ['wire-a'])
  await ok(`/api/accounts/${groups.find(group => group.id === 'a2').accountIds[0]}`,
    { proxy: { source: 'pool', proxyId: 'deleted-subscription-node' } }, adminKey, 'PATCH')
  await denied('wire-a', otherKey.key)
  console.log('PASS: empty catalog, discovery, one-hop aliases, channel/model scopes, source-test authorization and reasoning, per-Key groups, disabled channels, routing groups, disabled/empty groups, stale revisions, deleted-channel restrictions, stale model edits and unavailable proxy rejection')
} catch (error) {
  console.error(logs)
  throw error
} finally {
  child.kill()
  await childExit
  await new Promise(resolve => upstream.close(resolve))
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep))
  await rm(temp, { recursive: true, force: true })
}
