// Upgrade a real legacy database, using isolated credentials and mock upstreams.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'

const executable = path.resolve(process.argv[2] || 'target/debug/agent2api-server.exe')
const legacy = path.resolve(process.argv[3] || '.verify/local-runtime/routing-available.exe')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-group-upgrade-'))
const admin = 'upgrade-test-admin', restricted = 'upgrade-test-client'
const calls = []
const imageProvider = 'upgrade-image-source'
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
const upstream = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  const credential = request.headers.authorization?.replace('Bearer ', '')
  calls.push({ credential, model: body.model })
  if (request.url.startsWith('/v1/images/')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ created: 1, data: [{ b64_json: pixel }] })); return }
  const content = `${credential}:${body.model}`
  response.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json')
  response.end(body.stream ? `data: ${JSON.stringify({ id: 'upgrade', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` : JSON.stringify({ id: 'upgrade', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const pluginDir = path.join(directory, 'plugins', 'upgrade-fixture', '1.0.0')
await mkdir(pluginDir, { recursive: true }); await copyFile(process.execPath, path.join(pluginDir, 'fixture.exe'))
const fixturePath = path.join(pluginDir, 'fixture.cjs')
await writeFile(fixturePath, `const readline = require('node:readline'); const models = [{id:'Wire-Image',kind:'image',supports_image_generation:true,supports_image_editing:true}];
readline.createInterface({input:process.stdin}).on('line',line=>{let f;try{f=JSON.parse(line)}catch{return}const p=f.params||{};let result;
switch(f.method){case 'init':result=[{id:'${imageProvider}',label:'Upgrade image',capabilities:{chat:true},default_models:models}];break;
case 'images.capabilities':result={generation:true,editing:true};break;
case 'account.normalize':result={identity:'image-account',secret:{token:'fixture'},public:{name:'image-account',hasCredentials:true},desktop:false};break;
case 'token.ensure':result='fixture';break;
case 'models.list':result=models;break;
case 'images.generate':case 'images.edit':result={url:'http://127.0.0.1:${upstream.address().port}/v1/images/'+(f.method==='images.edit'?'edits':'generations'),headers:[['Content-Type','application/json']],body:p.body,response:'openai'};break;
case 'shutdown':process.exit(0);break;default:result=null;}process.stdout.write(JSON.stringify({id:f.id,result})+'\\n');}).on('close',()=>process.exit(0));`)
const declared = [{ id: imageProvider, label: 'Upgrade image' }]
await writeFile(path.join(pluginDir, 'pack.json'), JSON.stringify({ id: 'upgrade-fixture', name: 'Upgrade fixture', version: '1.0.0', protocol: 1, providers: declared, entry: { 'x86_64-pc-windows-msvc': 'fixture.exe' } }))
await writeFile(path.join(directory, 'plugins', 'plugins.json'), JSON.stringify({ packs: [{ id: 'upgrade-fixture', version: '1.0.0', enabled: true, providers: { [imageProvider]: true }, entry: 'fixture.exe', manifest_providers: declared }] }))
const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
const base = `http://127.0.0.1:${port}`
let child, exited, log = ''
async function request(endpoint, body, key = admin, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) })
  const payload = await response.json()
  return { status: response.status, body: payload.success === true ? payload.data : payload }
}
async function ok(...args) { const result = await request(...args); assert.equal(result.status, 200, `${args[0]}: ${JSON.stringify(result.body)}`); return result.body }
async function start(binary, expectedStatus = 200) {
  child = spawn(binary, [], { windowsHide: true, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AGENT2API_PROXY_HOME: directory, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: admin, AGENT2API_ACCOUNT_KEY: '8'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '', NODE_OPTIONS: `--require=${JSON.stringify(fixturePath)}` } })
  exited = once(child, 'exit')
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-100000) })
  for (let i = 0; i < 160; i++) { if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`); try { const response = await request('/api/routing/groups'); if (response.status === expectedStatus && log.includes('upgrade-fixture」v1.0.0 已加载')) return } catch {} await delay(250) }
  throw new Error('Startup timed out')
}
async function stop() { if (child?.exitCode === null) { child.kill(); await exited } }
const publicIds = async (key = admin) => (await ok('/v1/models', undefined, key)).data.map(model => model.id).sort()
const chat = model => ok('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'ping' }] }, restricted)
async function saveLegacy(model) { const catalog = await ok('/api/models/catalog'); await ok('/api/models/catalog', { previousId: '', model, revision: catalog.revision }) }
try {
  await start(legacy)
  await ok('/api/accounts', { provider: imageProvider, name: 'image-account' })
  await saveLegacy({ id: 'Public/Image', enabled: true, bindings: [{ provider: imageProvider, model: 'Wire-Image' }] })
  const provider = await ok('/api/custom-providers', { name: 'Upgrade provider', protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', apiKeys: ['allowed', 'excluded'], models: ['wire-chat', 'orphan-wire'] }] })
  const providerId = provider.provider.id
  const accountIds = provider.accounts.map(account => account.id)
  assert.equal(accountIds.length, 2)
  const binding = { provider: providerId, model: 'wire-chat' }
  await saveLegacy({ id: 'CaseSensitiveAlias', name: 'Existing model', enabled: true, bindings: [binding] })
  await saveLegacy({ id: 'disabled-alias', enabled: false, bindings: [binding] })
  await saveLegacy({ id: 'archived-alias', enabled: true, archived: true, bindings: [binding] })
  const profile = { providerScope: 'selected', providers: [providerId], disabledProviders: [], accountOrder: { [providerId]: accountIds }, excludedAccounts: [accountIds[1]], strategy: 'order', sticky: 'off' }
  await ok('/api/routing/profile', { model: 'CaseSensitiveAlias', profile }, admin, 'PUT')
  await ok('/api/routing/profile', { model: 'orphan-wire', profile }, admin, 'PUT')
  await ok('/api/keys', { name: 'Retained restriction', key: restricted, allowedProviders: [providerId], allowedModels: ['CaseSensitiveAlias', 'disabled-alias'] })
  const beforeIds = await publicIds(), beforeKeys = (await ok('/api/keys')).keys
  assert.deepEqual(beforeIds, ['CaseSensitiveAlias', 'Public/Image'])
  await stop(); log = ''; await start(executable)
  const groups = (await ok('/api/routing/groups')).groups.map(row => row.group)
  assert.equal(groups.length, 5, 'Legacy models and standalone profile must become routing groups')
  assert.equal(groups.find(group => group.model === 'Public/Image').kind, 'image', 'Plugin image models without optional type metadata must retain their image kind after restart')
  for (const operation of ['generations', 'edits']) {
    const image = await ok(`/v1/images/${operation}`, { model: 'Public/Image', prompt: 'upgrade image', ...(operation === 'edits' ? { images: [{ image_url: `data:image/png;base64,${pixel}` }] } : {}) })
    assert.equal(image.data[0].b64_json, pixel); assert.equal(calls.at(-1).model, 'Wire-Image')
  }
  assert.deepEqual(await publicIds(), beforeIds)
  assert.deepEqual(await publicIds(restricted), ['CaseSensitiveAlias'])
  assert.deepEqual((await ok('/api/keys')).keys, beforeKeys, 'Upgrade must not change Key scopes or key material')
  const migrated = groups.find(group => group.model === 'CaseSensitiveAlias')
  assert.equal(migrated.kind, 'chat'); assert.equal(migrated.strategy, 'order'); assert.equal(migrated.sticky, 'off')
  assert.equal(migrated.members[0].accountScope, 'selected')
  assert.deepEqual(migrated.members[0].accounts, [accountIds[0]])
  for (const name of ['disabled-alias', 'archived-alias', 'orphan-wire']) assert.equal(groups.find(group => group.model === name).enabled, false)
  assert.deepEqual((await ok('/api/routing/workspace')).configuredModels, [])
  assert.equal((await request('/api/models/catalog', { model: { id: 'obsolete' } })).status, 410)
  assert.equal((await request('/api/routing/profile', { model: 'CaseSensitiveAlias', profile }, admin, 'PUT')).status, 410)
  for (let i = 0; i < 3; i++) { const answer = await chat('CaseSensitiveAlias'); assert.equal(answer.choices[0].message.content, 'allowed:wire-chat') }
  const count = calls.length
  assert.equal((await request('/v1/chat/completions', { model: 'disabled-alias', messages: [] }, restricted)).status, 404)
  assert.equal(calls.length, count)
  await stop(); await start(executable)
  assert.deepEqual((await ok('/api/routing/groups')).groups.map(row => row.group), groups, 'Second startup must not duplicate or change migrated groups')
  assert.deepEqual(await publicIds(), beforeIds)
  assert.equal((await chat('CaseSensitiveAlias')).choices[0].message.content, 'allowed:wire-chat')
  const state = await ok('/api/routing/groups')
  await ok('/api/routing/groups', { id: 'same-source', revision: state.newRevision, group: { id: 'same-source', name: 'Same source', model: 'wire-chat', kind: 'chat', enabled: true, strategy: 'order', sticky: 'off', members: [{ id: 'main', provider: providerId, model: 'wire-chat', included: true, accountScope: 'all', accounts: [] }] } }, admin, 'PUT')
  await ok('/api/custom-providers/models', { providerId, models: [{ id: 'wire-chat', enabled: true }, { id: 'orphan-wire', enabled: true }], mappings: [] })
  assert((await publicIds()).includes('wire-chat'), 'Refreshing a source catalog must work when a group uses the same ID')
  assert.deepEqual(await publicIds(restricted), ['CaseSensitiveAlias'], 'A new same-source group must not widen existing Key scopes')
  console.log('PASS legacy model/profile migration, IDs, scopes, retired endpoints, forwarding and restart idempotence')
  await stop()
  for (const [label, invalid] of [['corrupt', 'invalid legacy catalog'], ['conflicting', [{ id: 'CaseSensitiveAlias', enabled: true, bindings: [binding] }]]]) {
    const db = new DatabaseSync(path.join(directory, 'agent2api.db'))
    const read = key => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value
    const originalRoutes = read('routingProfiles'), originalKeys = read('apiKeys')
    db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('managedModels', JSON.stringify(invalid))
    db.prepare('DELETE FROM kv WHERE key = ?').run('routingGroupsMigrationV1')
    db.close()
    log = ''; await start(executable, 500)
    const response = await request('/api/routing/groups')
    assert.equal(response.status, 500); assert.match(JSON.stringify(response.body), /原数据已保留/)
    await stop()
    const after = new DatabaseSync(path.join(directory, 'agent2api.db'), { readOnly: true })
    const persisted = key => after.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value
    assert.equal(persisted('managedModels'), JSON.stringify(invalid))
    assert.equal(persisted('routingProfiles'), originalRoutes)
    assert.equal(persisted('apiKeys'), originalKeys)
    assert.equal(persisted('routingGroupsMigrationV1'), undefined)
    after.close()
    console.log(`PASS ${label} migration fails atomically without changing legacy models, groups or Keys`)
  }
} finally {
  await stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  await writeFile(path.join(directory, 'server.log'), log)
  console.log(`Isolated upgrade data: ${directory}`)
}
