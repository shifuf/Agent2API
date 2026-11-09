// Isolated routing-group HTTP contract. All state and upstreams are temporary.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const executable = path.resolve(process.argv[2] || 'target/debug/agent2api-server.exe')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-group-engine-'))
const adminKey = 'isolated-group-engine-admin', calls = [], results = []
const imageProviders = ['engine-image-a', 'engine-image-b']
const imageModels = [{ id: 'Wire-Image', kind: 'image', supports_image_generation: true, supports_image_editing: true },
  { id: 'Generate-Only', kind: 'image', supports_image_generation: true, supports_image_editing: false },
  { id: 'Unavailable-Image', kind: 'image', supports_image_generation: false, supports_image_editing: false }]
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
let failureSource = ''
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  calls.push({ path: req.url, body, source: req.headers.authorization?.replace('Bearer ', '') })
  if (req.url.startsWith('/v1/images/')) {
    res.setHeader('Content-Type', 'application/json')
    if (calls.at(-1).source === failureSource) { res.statusCode = 429; res.end(JSON.stringify({ error: { message: 'quota exhausted' } })); return }
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: pixel, revised_prompt: `${calls.at(-1).source}:${body.model}` }] })); return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(`data: ${JSON.stringify({ id: 'isolated', choices: [{ index: 0, delta: { content: body.model }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const reserved = http.createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening')
const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve))
const base = `http://127.0.0.1:${port}`
// The fixture implements the real plugin RPC boundary; all image HTTP is still
// performed by the production gateway and its normal routing/retry machinery.
const pluginDir = path.join(directory, 'plugins', 'engine-fixture', '1.0.0')
await mkdir(pluginDir, { recursive: true })
await copyFile(process.execPath, path.join(pluginDir, 'fixture.exe'))
const fixturePath = path.join(pluginDir, 'fixture.cjs')
await writeFile(fixturePath, `
const readline = require('node:readline');
const providers = ${JSON.stringify(imageProviders)}, models = ${JSON.stringify(imageModels)};
readline.createInterface({ input: process.stdin }).on('line', line => {
  let frame; try { frame = JSON.parse(line) } catch { return }
  const p = frame.params || {}; let result;
  switch (frame.method) {
    case 'init': result = providers.map(id => ({ id, label: id, capabilities: { chat: true }, default_models: models })); break;
    case 'images.capabilities': result = { generation: true, editing: true }; break;
    case 'account.normalize': { const name = p.source?.payload?.name || 'image'; result = { identity: p.provider + '-' + name, secret: { token: name }, public: { name, hasCredentials: true }, desktop: false }; break; }
    case 'token.ensure': result = 'isolated-token'; break;
    case 'images.generate': case 'images.edit': result = { url: ${JSON.stringify(`http://127.0.0.1:${upstream.address().port}`)} + (frame.method === 'images.edit' ? '/v1/images/edits' : '/v1/images/generations'), headers: [['Content-Type','application/json'],['Authorization','Bearer ' + p.account]], body: p.body, response: 'openai' }; break;
    case 'models.list': result = models; break;
    case 'is_error_response': result = p.status >= 400; break;
    case 'classify': result = { kind: p.status === 429 ? 'quota_limited' : 'fatal', status: p.status, message: 'isolated upstream failure', reset_at: null, upstream_code: null }; break;
    case 'retry_advice': result = null; break;
    case 'retry.decision': result = { action: 'default' }; break;
    case 'error.policy': result = {}; break;
    case 'shutdown': process.exit(0); break;
    default: result = null;
  }
  process.stdout.write(JSON.stringify({ id: frame.id, result }) + '\\n');
}).on('close', () => process.exit(0));
`)
const declared = imageProviders.map(id => ({ id, label: id }))
await writeFile(path.join(pluginDir, 'pack.json'), JSON.stringify({ id: 'engine-fixture', name: 'Engine fixture', version: '1.0.0', protocol: 1,
  providers: declared, entry: { 'x86_64-pc-windows-msvc': 'fixture.exe' } }))
await writeFile(path.join(directory, 'plugins', 'plugins.json'), JSON.stringify({ packs: [{ id: 'engine-fixture', version: '1.0.0', enabled: true,
  providers: Object.fromEntries(imageProviders.map(id => [id, true])), entry: 'fixture.exe', manifest_providers: declared }] }))
const child = spawn(executable, [], { windowsHide: true, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENT2API_PROXY_HOME: directory, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
    AGENT2API_PROXY_API_KEY: adminKey, AGENT2API_ACCOUNT_KEY: '5'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0',
    AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '', NODE_OPTIONS: `--require=${JSON.stringify(fixturePath)}` } })
let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-100000) })
const exited = once(child, 'exit')
async function request(endpoint, body, key = adminKey, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) })
  const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, body: data?.success === true ? data.data : data }
}
async function ok(...args) { const result = await request(...args); assert.equal(result.status, 200, `${args[0]}: ${JSON.stringify(result.body)}`); return result.body }
async function save(group) { const state = await ok('/api/routing/groups'); return ok('/api/routing/groups', { id: group.id, group,
  revision: state.groups.find(row => row.group.id === group.id)?.revision ?? state.newRevision }, adminKey, 'PUT') }
async function step(name, action) { await action(); results.push(name); console.log(`PASS ${name}`) }
function group(id, model, members, patch = {}) { return { id, name: id, model, strategy: 'order', sticky: 'off', members, ...patch } }

try {
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`)
    try {
      const plugins = await ok('/api/plugins')
      if (plugins.packs.some(pack => pack.id === 'engine-fixture' && pack.providers.every(provider => provider.loaded))) {
        await ok('/api/routing/groups'); ready = true; break
      }
    } catch {}
    await delay(250)
  }
  assert(ready, 'Gateway did not start')
  const imageAccounts = []
  for (const provider of imageProviders) {
    const added = await ok('/api/accounts', { provider, name: 'selected' }); imageAccounts.push(added.account.id)
  }
  const extra = await ok('/api/accounts', { provider: imageProviders[0], name: 'excluded' })
  const imageMembers = imageProviders.map((provider, index) => ({ id: `image-${index}`, provider, model: 'Wire-Image', accounts: [imageAccounts[index]], included: true }))
  const imageGroup = group('image-group', 'Public/Image', imageMembers, { kind: 'image' })
  await step('image group generation and editing use selected accounts and exact upstream IDs', async () => {
    await save(imageGroup)
    const publicModel = (await ok('/v1/models')).data.find(model => model.id === imageGroup.model)
    assert.equal(publicModel.kind, 'image'); assert.equal(publicModel.supports_image_generation, true); assert.equal(publicModel.supports_image_editing, true)
    const choices = (await ok('/api/routing/groups')).catalog
    assert.equal(choices.find(item => item.provider === imageProviders[0] && item.model === 'Wire-Image').kind, 'image')
    for (const operation of ['generations', 'edits']) {
      const body = { model: imageGroup.model, prompt: 'one pixel', ...(operation === 'edits' ? { images: [{ image_url: `data:image/png;base64,${pixel}` }] } : {}) }
      const result = await ok(`/v1/images/${operation}`, body)
      assert.equal(result.data[0].b64_json, pixel)
      assert.equal(calls.at(-1).body.model, 'Wire-Image'); assert.equal(calls.at(-1).source, imageAccounts[0])
      assert.equal(calls.at(-1).path, `/v1/images/${operation}`)
    }
    assert(!calls.some(call => call.source === extra.account.id))
  })
  await step('gateway Key model choices require usable image operations on each provider', async () => {
    const mixed = group('image-capability-scope', 'Public/Capability-Scope',
      [imageMembers[0], { ...imageMembers[1], model: 'Unavailable-Image' }], { kind: 'image' })
    await save(mixed)
    const models = (await ok('/api/keys')).modelsByProvider
    assert(models[imageProviders[0]].includes(mixed.model))
    assert(!models[imageProviders[1]]?.includes(mixed.model), 'An unusable source must not advertise its group as available to a provider-restricted Key')
    await save({ ...mixed, enabled: false })
  })
  await step('disabling an upstream model removes its group candidates without publishing or deleting sources', async () => {
    const isolated = group('disabled-source', 'Public/Source-State', [imageMembers[0]], { kind: 'image' })
    await save(isolated)
    await ok('/api/models/state', { provider: imageProviders[0], id: 'Wire-Image', enabled: false })
    assert.equal((await ok('/api/models/manage')).models.find(model => model.provider === imageProviders[0] && model.id === 'Wire-Image').enabled, false)
    assert(!(await ok('/api/routing/groups')).catalog.some(model => model.provider === imageProviders[0] && model.model === 'Wire-Image'), 'Disabled upstream model must be absent from new group choices')
    assert(!(await ok('/v1/models')).data.some(model => model.id === isolated.model))
    assert(!(await ok('/api/keys')).modelsByProvider[imageProviders[0]]?.includes(isolated.model))
    const before = calls.length
    assert((await request('/v1/images/generations', { model: isolated.model, prompt: 'disabled source' })).status >= 400)
    assert.equal(calls.length, before, 'A disabled upstream model must not be contacted')
    await ok('/v1/images/generations', { model: imageGroup.model, prompt: 'remaining source' })
    assert.equal(calls.at(-1).source, imageAccounts[1])
    await ok('/api/models/state', { provider: imageProviders[0], id: 'Wire-Image', enabled: true })
    assert((await ok('/v1/models')).data.some(model => model.id === isolated.model))
    assert(!(await ok('/v1/models')).data.some(model => model.id === 'Wire-Image'), 'Reenabling upstream models must not publish raw IDs')
    await save({ ...isolated, enabled: false })
  })
  await step('image fallback preserves provider scope and filters editing support per candidate', async () => {
    const scopedKey = 'image-group-only-b'
    await ok('/api/keys', { name: scopedKey, key: scopedKey, allowedProviders: [imageProviders[1]], allowedModels: [imageGroup.model] })
    await ok('/v1/images/generations', { model: imageGroup.model, prompt: 'scoped pixel' }, scopedKey)
    assert.equal(calls.at(-1).source, imageAccounts[1])
    await ok('/v1/images/edits', { prompt: 'default scoped pixel', images: [{ image_url: `data:image/png;base64,${pixel}` }] }, scopedKey)
    assert.equal(calls.at(-1).source, imageAccounts[1]); assert.equal(calls.at(-1).body.model, 'Wire-Image')
    const filtered = group('edit-filter', 'Public/Edit', [{ ...imageMembers[0], model: 'Generate-Only' }, imageMembers[1]], { kind: 'image' })
    await save(filtered)
    const start = calls.length
    await ok('/v1/images/edits', { model: filtered.model, prompt: 'edit pixel', images: [{ image_url: `data:image/png;base64,${pixel}` }] })
    assert.equal(calls.length, start + 1); assert.equal(calls.at(-1).source, imageAccounts[1]); assert.equal(calls.at(-1).body.model, 'Wire-Image')
    failureSource = imageAccounts[0]
    const before = calls.length
    await ok('/v1/images/generations', { model: imageGroup.model, prompt: 'retry pixel' })
    failureSource = ''
    assert.deepEqual(calls.slice(before).map(call => call.source), imageAccounts)
  })
  await step('image nesting and rotation retain each selected source', async () => {
    // Fresh accounts keep this strategy assertion independent of the prior
    // failover's account sink/circuit-breaker state.
    const rotatingMembers = []
    for (const [index, provider] of imageProviders.entries()) {
      const added = await ok('/api/accounts', { provider, name: 'rotate' })
      rotatingMembers.push({ ...imageMembers[index], accounts: [added.account.id], model: 'Generate-Only' })
    }
    const rotating = group('image-rotate', 'Public/Image-Rotate', rotatingMembers, { kind: 'image', strategy: 'rotate' })
    await save(rotating)
    const parent = group('image-parent', 'Public/Image-Parent', [{ id: 'child', group: rotating.id, included: true }], { kind: 'image' })
    await save(parent)
    const start = calls.length
    for (let i = 0; i < 2; i++) await ok('/v1/images/generations', { model: parent.model, prompt: 'rotate pixel' })
    assert.equal(new Set(calls.slice(start).map(call => call.source)).size, 2)
    assert(calls.slice(start).every(call => call.body.model === 'Generate-Only'))
  })
  const channel = await ok('/api/custom-providers', { name: 'Chat source', protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    keyGroups: [{ id: 'main', apiKeys: ['chat-source'], models: ['deepseek-v4.1-flash'], enabled: true }] })
  const member = { id: 'chat', provider: channel.provider.id, model: 'deepseek-v4.1-flash', accountScope: 'all', accounts: [], included: true }
  await step('a public group may reuse its raw upstream model ID', async () => {
    await save(group('raw-name', 'deepseek-v4.1-flash', [member], { unlists: true }))
    assert((await ok('/v1/models')).data.some(item => item.id === 'deepseek-v4.1-flash'), 'Hiding source models must not hide the owning group when its public ID matches its source')
    const reply = await ok('/v1/chat/completions', { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }] })
    assert.equal(reply.choices[0].message.content, 'deepseek-v4.1-flash')
    assert.equal(calls.at(-1).body.model, 'deepseek-v4.1-flash')
  })
  await step('public IDs preserve case and reject case-insensitive duplicates', async () => {
    await save(group('case', 'Public/Chat-X', [member]))
    assert((await ok('/v1/models')).data.some(model => model.id === 'Public/Chat-X'))
    assert.equal((await ok('/v1/chat/completions', { model: 'public/chat-x', messages: [{ role: 'user', content: 'ping' }] })).choices[0].message.content, 'deepseek-v4.1-flash')
    const state = await ok('/api/routing/groups')
    assert.equal((await request('/api/routing/groups', { id: 'duplicate', group: group('duplicate', 'PUBLIC/CHAT-X', [member]), revision: state.newRevision }, adminKey, 'PUT')).status, 400)
  })
  await step('all-account group ordering follows account priority instead of insertion order', async () => {
    const ordered = await ok('/api/custom-providers', { name: 'Priority source', protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      keyGroups: [{ id: 'priority', apiKeys: ['first-created', 'second-created'], models: ['priority-wire'], enabled: true }] })
    await ok(`/api/accounts/${ordered.accounts[0].id}`, { priority: 20 }, adminKey, 'PATCH')
    await ok(`/api/accounts/${ordered.accounts[1].id}`, { priority: 10 }, adminKey, 'PATCH')
    await save(group('priority-group', 'Public/Priority', [{ id: 'priority', provider: ordered.provider.id, model: 'priority-wire', accountScope: 'all', accounts: [], included: true }]))
    await ok('/v1/chat/completions', { model: 'Public/Priority', messages: [{ role: 'user', content: 'ping' }] })
    assert.equal(calls.at(-1).source, 'second-created')
  })
  await step('image groups reject chat members', async () => {
    const state = await ok('/api/routing/groups')
    const result = await request('/api/routing/groups', { id: 'mixed', group: group('mixed', 'image-mixed', [member], { kind: 'image' }), revision: state.newRevision }, adminKey, 'PUT')
    assert.equal(result.status, 400)
  })
  await step('endpoints reject opposite group kinds without contacting upstream', async () => {
    const before = calls.length
    assert.equal((await request('/v1/chat/completions', { model: imageGroup.model, messages: [{ role: 'user', content: 'wrong endpoint' }] })).status, 400)
    for (const operation of ['generations', 'edits']) {
      assert.equal((await request(`/v1/images/${operation}`, { model: 'deepseek-v4.1-flash', prompt: 'wrong endpoint',
        ...(operation === 'edits' ? { images: [{ image_url: `data:image/png;base64,${pixel}` }] } : {}) })).status, 400)
    }
    assert.equal(calls.length, before)
    const state = await ok('/api/routing/groups')
    assert.equal((await request('/api/routing/groups', { id: 'mixed-nesting', revision: state.newRevision,
      group: group('mixed-nesting', 'mixed-nesting', [{ id: 'nested', group: imageGroup.id, included: true }]) }, adminKey, 'PUT')).status, 400)
    assert.equal((await request('/v1/images/generations', { model: 'Wire-Image', prompt: 'raw hidden' })).status, 404)
  })
  await step('disabled image groups and accounts cannot fall back outside their scope', async () => {
    const scoped = group('disabled-image-account', 'Public/Disabled-Account', [imageMembers[1]], { kind: 'image' })
    await save(scoped)
    await ok(`/api/accounts/${imageAccounts[1]}`, { enabled: false }, adminKey, 'PATCH')
    const before = calls.length
    assert((await request('/v1/images/generations', { model: scoped.model, prompt: 'disabled account' })).status >= 400)
    assert.equal(calls.length, before)
    assert(!(await ok('/v1/models')).data.some(item => item.id === scoped.model))
    await ok(`/api/accounts/${imageAccounts[1]}`, { enabled: true }, adminKey, 'PATCH')
    await save({ ...scoped, enabled: false })
    assert.equal((await request('/v1/images/generations', { model: scoped.model, prompt: 'disabled group' })).status, 404)
    assert.equal(calls.length, before)
  })
} finally {
  child.kill(); await Promise.race([exited, delay(5000)])
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  await writeFile(path.join(directory, 'gateway.log'), output)
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({ results, calls }, null, 2))
  console.log(`Artifacts: ${directory}`)
}
