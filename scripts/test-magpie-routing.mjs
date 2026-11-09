// Isolated live gateway routing contract. No user data or external upstreams.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const executable = path.resolve(process.argv[2] || 'target/debug/agent2api-server.exe')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-magpie-routing-'))
const adminKey = 'isolated-routing-admin'
const calls = [], results = []
let failure = '', slow = '', classifierBad = false, errorAfterContent = false, recoverableFailures = 0
const upstream = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  const source = request.headers.authorization?.replace('Bearer ', '') || ''
  const classify = body.messages?.[0]?.content?.includes("Classify the user's task")
  calls.push({ source, model: body.model, classify: !!classify, effort: body.reasoning_effort, tier: body.service_tier })
  if (recoverableFailures > 0) {
    recoverableFailures--
    response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' })
    response.end(JSON.stringify({ error: { message: 'temporarily overloaded' } })); return
  }
  if (source === failure) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'temporarily overloaded' } })); return }
  const content = classify ? classifierBad ? 'not JSON' : JSON.stringify({ intent: 'hard task', effort: 'high' }) : `${source}:${body.model}`
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`)
    if (source === slow) { response.on('close', () => {}); return }
    response.write(`data: ${JSON.stringify({ id: 'test-routing', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
    if (errorAfterContent && source === 'north') {
      await delay(100)
      response.end(`event: error\ndata: ${JSON.stringify({ error: { message: 'late stream error' } })}\n\n`)
      return
    }
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`)
  } else {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ id: 'test-routing', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }))
  }
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const reserved = http.createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening')
const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve))
const base = `http://127.0.0.1:${port}`
const child = spawn(executable, [], { windowsHide: true, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENT2API_PROXY_HOME: directory, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
    AGENT2API_PROXY_API_KEY: adminKey, AGENT2API_ACCOUNT_KEY: '4'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0',
    AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' } })
let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-120000) })
const exited = once(child, 'exit')
async function request(endpoint, body, key = adminKey, method = body === undefined ? 'GET' : 'POST', headers = {}) {
  const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) })
  const text = await response.text(); let result; try { result = JSON.parse(text) } catch { result = text }
  return { status: response.status, body: result?.success === true ? result.data : result }
}
async function ok(...args) { const result = await request(...args); assert.equal(result.status, 200, `${args[0]}: ${JSON.stringify(result.body)}`); return result.body }
async function step(name, action) { await action(); results.push(name); console.log(`PASS ${name}`) }
async function groups() { return ok('/api/routing/groups') }
async function save(group) { const state = await groups(); return ok('/api/routing/groups', { id: group.id, group, revision: state.groups.find(row => row.group.id === group.id)?.revision ?? state.newRevision }, adminKey, 'PUT') }
async function action(action, extra = {}) { const state = await groups(); return ok('/api/routing/groups/actions', { action, revision: state.collectionRevision, ...extra }) }
async function publicIds(key = adminKey) { return (await ok('/v1/models', undefined, key)).data.map(model => model.id) }
const members = []
function group(id, patch = {}) { return { id, name: id, model: `group/${id}`, strategy: 'order', sticky: 'off', members: structuredClone(members), patience: -1, context: 0, ...patch } }
async function chat(model, options = {}, key = adminKey, headers = {}) { return ok('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'ping' }], ...options }, key, 'POST', headers) }
const content = response => response.choices[0].message.content

try {
  let ready = false
  for (let i = 0; i < 120; i++) { if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`); try { await groups(); ready = true; break } catch {} await delay(250) }
  assert(ready, 'Gateway failed to start')
  await step('new routing catalogs are empty before accounts and models are configured', async () => {
    assert.deepEqual((await groups()).catalog, [], 'Unconfigured built-in providers must not populate routing choices')
    assert.deepEqual((await ok('/api/routing/workspace')).models, [])
  })
  const providers = []
  for (const source of ['north', 'south']) {
    const created = await ok('/api/custom-providers', { name: source, protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      keyGroups: [{ id: 'main', name: 'Main', apiKeys: [source], models: ['gpt-4.1', 'gpt-4.1-mini'], enabled: true }] })
    providers.push(created.provider.id)
    members.push({ id: source, provider: created.provider.id, model: 'gpt-4.1', accounts: [], accountScope: 'all', included: true, weight: 1 })
  }
  await step('new routing choices require enabled credentials and per-Key model permissions', async () => {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`
    const create = (name, keyGroups) => ok('/api/custom-providers', { name, protocol: 'chat_completions', baseUrl, ...(keyGroups ? { keyGroups } : {}) })
    const missingCredentials = await create('No credentials')
    await ok('/api/custom-providers/models', { providerId: missingCredentials.provider.id, models: [{ id: 'unavailable' }], mappings: [] })
    const noAccount = await create('Removed account', [{ id: 'gone', apiKeys: ['gone'], models: ['unavailable'] }])
    await ok(`/api/accounts/${noAccount.accounts[0].id}`, undefined, adminKey, 'DELETE')
    const disabledAccount = await create('Disabled account', [{ id: 'off', apiKeys: ['off'], models: ['unavailable'] }])
    await ok(`/api/accounts/${disabledAccount.accounts[0].id}`, { enabled: false }, adminKey, 'PATCH')
    const disabledProvider = await create('Disabled provider', [{ id: 'off', apiKeys: ['off'], models: ['unavailable'] }])
    await ok('/api/custom-providers/update', { id: disabledProvider.provider.id, enabled: false })
    const disabledGroup = await create('Disabled group', [{ id: 'off', enabled: false, apiKeys: ['off'], models: ['unavailable'] }])
    const empty = await create('No models', [{ id: 'empty', apiKeys: ['empty'], models: [] }])
    const scoped = await create('Scoped models', [
      { id: 'first', apiKeys: ['first'], models: ['wire-first'] },
      { id: 'second', apiKeys: ['second', 'second-two'], models: ['wire-second'] },
    ])
    const selected = (await groups()).catalog
    assert.deepEqual([...new Set(selected.map(item => item.provider))].sort(), [...providers, scoped.provider.id].sort())
    assert(selected.every(item => item.accountCount > 0))
    assert.equal(selected.find(item => item.provider === scoped.provider.id && item.model === 'wire-first').accountCount, 1)
    assert.equal(selected.find(item => item.provider === scoped.provider.id && item.model === 'wire-second').accountCount, 2)
    const scopedAccounts = (await ok('/api/custom-providers')).providers.find(item => item.id === scoped.provider.id).keyGroups
    const firstAccount = scopedAccounts.find(item => item.id === 'first').accountIds[0]
    await save(group('custom-route-alias', { model: 'custom-route-alias', members: [
      { id: 'source', provider: scoped.provider.id, model: 'wire-first', included: true, accountScope: 'all', accounts: [] },
    ] }))
    const workspace = await ok('/api/routing/workspace')
    assert.deepEqual(workspace.modelsByProvider?.[scoped.provider.id], ['custom-route-alias'], 'Public aliases must retain their actual source provider')
    const persisted = group('kept-unavailable', { members: [{ id: 'first', provider: scoped.provider.id, model: 'wire-first', accounts: [], included: true }] })
    await save(persisted)
    await ok(`/api/accounts/${firstAccount}`, { enabled: false }, adminKey, 'PATCH')
    const after = await groups()
    assert(!(await ok('/api/routing/workspace')).modelsByProvider?.[scoped.provider.id]?.includes('custom-route-alias'), 'Disabled accounts must stop offering their aliases')
    assert.deepEqual(after.catalog.filter(item => item.provider === scoped.provider.id).map(item => item.model), ['wire-second'])
    assert.equal(after.groups.find(row => row.group.id === persisted.id).group.members[0].model, 'wire-first', 'Saved unavailable members must remain editable')
    await save({ ...after.groups.find(row => row.group.id === persisted.id).group, name: 'Still editable' })
    // Remove fixture providers so discovery and runtime scenarios keep their original sources.
    for (const channel of [missingCredentials, noAccount, disabledAccount, disabledProvider, disabledGroup, empty, scoped]) {
      await ok('/api/custom-providers/remove', { id: channel.provider.id })
    }
  })
  await step('automatic same-model groups are suggestions until explicitly enabled', async () => {
    const state = await groups(); assert.equal(state.autoGroupsEnabled, false); assert.equal(state.foundGroups.length, 2)
    assert.deepEqual(await publicIds(), []); assert(state.catalog.every(row => row.developerName === 'OpenAI'))
    await action('discovery', { enabled: true }); assert((await publicIds()).some(id => id === 'auto/gpt-4.1'))
    assert(content(await chat('auto/gpt-4.1')).endsWith(':gpt-4.1'))
    await action('discovery', { enabled: false }); assert.deepEqual(await publicIds(), [])
  })
  await step('explicit empty accounts do not silently select every account', async () => {
    const empty = group('empty', { members: [{ ...members[0], accountScope: 'selected' }] }); await save(empty)
    assert(!(await publicIds()).includes(empty.model)); const before = calls.length
    assert((await request('/v1/chat/completions', { model: empty.model, messages: [{ role: 'user', content: 'ping' }] })).status >= 400)
    assert.equal(calls.length, before)
  })
  await step('manual strategy sends exclusively to the selected member and applies effort and fast mode', async () => {
    const manual = group('manual', { strategy: 'manual', pick: 'south', members: [members[0], { ...members[1], effort: 'high', fast: true }] }); await save(manual)
    assert.equal(content(await chat(manual.model)), 'south:gpt-4.1'); assert.equal(calls.at(-1).effort, 'high'); assert.equal(calls.at(-1).tier, 'priority')
  })
  await step('weighted member routing follows 3:1 shares without preview consuming rounds', async () => {
    const weighted = group('weighted', { strategy: 'weight', members: [{ ...members[0], weight: 3 }, members[1]] }); await save(weighted)
    const heads = []
    for (let i = 0; i < 4; i++) { await ok('/api/routing/preview', { model: weighted.model, group: weighted }); heads.push(content(await chat(weighted.model))) }
    assert.equal(heads.filter(value => value.startsWith('north:')).length, 3); assert.equal(heads.filter(value => value.startsWith('south:')).length, 1)
  })
  await step('nested groups respect gateway Key provider limits and group-only model permission', async () => {
    const childGroup = group('child'); await save(childGroup)
    const parent = group('parent', { members: [{ id: 'nested', group: childGroup.id, provider: '', model: '', included: true, accounts: [] }] }); await save(parent)
    const key = (await ok('/api/keys', { name: 'nested-south', key: 'nested-only-south', allowedProviders: [providers[1]], allowedModels: [parent.model] })).created
    assert(key); assert.deepEqual(await publicIds('nested-only-south'), [parent.model]); assert.equal(content(await chat(parent.model, {}, 'nested-only-south')), 'south:gpt-4.1')
    const state = await groups(); childGroup.members = [{ id: 'cycle', group: parent.id, provider: '', model: '', accounts: [], included: true }]
    assert.equal((await request('/api/routing/groups', { id: childGroup.id, group: childGroup, revision: state.groups.find(row => row.group.id === childGroup.id).revision }, adminKey, 'PUT')).status, 400)
  })
  await step('dynamic patterns select configured source models without publishing raw IDs', async () => {
    const dynamic = group('dynamic', { members: [], match: [`${providers[1]}/*-mini`] }); await save(dynamic)
    assert.equal(content(await chat(dynamic.model)), 'south:gpt-4.1-mini'); assert(!(await publicIds()).includes('gpt-4.1-mini'))
  })
  await step('conditional rules prefer a target and pause removes it even from fallback', async () => {
    const ruled = group('ruled', { rules: [{ use: 'south', tokens: 1 }] }); await save(ruled)
    assert.equal(content(await chat(ruled.model)), 'south:gpt-4.1')
    ruled.rules.push({ use: 'south', pause: true, agents: ['codex'] }); await save(ruled)
    assert.equal(content(await chat(ruled.model, {}, adminKey, { 'x-agent-name': 'codex' })), 'north:gpt-4.1')
    const count = calls.length
    const preview = await ok('/api/routing/preview', { model: ruled.model, group: ruled, facts: { tokens: 2, agent: 'codex' } })
    assert.equal(preview.queue.ordered[0].provider, providers[0])
    assert(preview.queue.blocked.some(row => row.state === 'paused'))
    assert(preview.rules.some(row => row.decision.matched.length === 2)); assert.equal(calls.length, count)
  })
  await step('intent classifier is cached through tool continuation and failure opens normal routing', async () => {
    const ruled = group('intent', { classifier: `${providers[0]}/gpt-4.1`, rules: [{ use: 'south', intent: 'hard task' }] }); await save(ruled)
    const history = [{ role: 'user', content: 'write a hard test' }], headers = { 'x-session-id': 'intent-session' }
    const before = calls.filter(call => call.classify).length
    assert.equal(content(await chat(ruled.model, { messages: history }, adminKey, headers)), 'south:gpt-4.1')
    const continued = [...history, { role: 'assistant', tool_calls: [{ id: 'tool1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'tool1', content: 'done' }]
    assert.equal(content(await chat(ruled.model, { messages: continued }, adminKey, headers)), 'south:gpt-4.1')
    assert.equal(calls.filter(call => call.classify).length, before + 1)
    classifierBad = true; assert.equal(content(await chat(ruled.model, { messages: [{ role: 'user', content: 'new uncached request' }] }, adminKey, { 'x-session-id': 'other' })), 'north:gpt-4.1'); classifierBad = false
  })
  await step('turn affinity survives tool results and permits next user turn rotation', async () => {
    const turn = group('turn', { strategy: 'rotate', sticky: 'turn' }); await save(turn)
    const first = [{ role: 'user', content: 'turn one' }], headers = { 'x-session-id': 'turn-session' }
    const answer = content(await chat(turn.model, { messages: first }, adminKey, headers))
    const more = [...first, { role: 'assistant', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: 'done' }]
    assert.equal(content(await chat(turn.model, { messages: more }, adminKey, headers)), answer)
    assert.notEqual(content(await chat(turn.model, { messages: [...more, { role: 'user', content: 'turn two' }] }, adminKey, headers)), answer)
  })
  await step('first-content timeout drops old control frames and switches to a valid alternative', async () => {
    const timed = group('timed', { firstToken: 1 }); await save(timed)
    slow = 'north'; const before = Date.now(); const answer = await chat(timed.model); slow = ''
    assert.equal(content(answer), 'south:gpt-4.1'); assert(Date.now() - before < 10000)
  })
  await step('ordered failover visits successive stalled members before returning content', async () => {
    const ordered = group('ordered-stalls', { firstToken: 1, members: [members[0],
      { ...members[0], id: 'north-mini', model: 'gpt-4.1-mini' }, members[1]] }); await save(ordered)
    slow = 'north'; const before = calls.length
    try {
      assert.equal(content(await chat(ordered.model)), 'south:gpt-4.1')
      assert.deepEqual(calls.slice(before).map(call => [call.source, call.model]),
        [['north', 'gpt-4.1'], ['north', 'gpt-4.1-mini'], ['south', 'gpt-4.1']])
    } finally { slow = '' }
  })
  await step('zero first-content timeout does not rotate a healthy HTTP 200 stream', async () => {
    const disabled = group('no-content-deadline', { firstToken: 0, patience: 0 }); await save(disabled)
    slow = 'north'; const before = calls.length
    try {
      await assert.rejects(async () => {
        const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
          headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: disabled.model, stream: true, messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(1800) })
        await response.text()
      }, error => error.name === 'TimeoutError' || error.name === 'AbortError')
      assert.deepEqual(calls.slice(before).map(call => call.source), ['north'])
    } finally { slow = '' }
  })
  await step('a failure after content is committed never starts a second upstream reply', async () => {
    const committed = group('committed', { firstToken: 1 }); await save(committed)
    errorAfterContent = true; const before = calls.length
    const response = await request('/v1/chat/completions', { model: committed.model, stream: true, messages: [{ role: 'user', content: 'stream please' }] })
    errorAfterContent = false
    assert.equal(response.status, 200); assert.equal(typeof response.body, 'string')
    assert(response.body.includes('north:gpt-4.1')); assert(!response.body.includes('south:gpt-4.1'))
    assert(calls.slice(before).every(call => call.source === 'north'))
  })
  await step('disabled groups disappear from public and gateway Key lists and cannot forward', async () => {
    const disabled = group('disabled', { enabled: false }); await save(disabled)
    assert(!(await publicIds()).includes(disabled.model)); assert(!Object.values((await ok('/api/keys')).modelsByProvider).flat().includes(disabled.model))
    assert.equal((await request('/v1/chat/completions', { model: disabled.model, messages: [] })).status, 404)
  })
  await step('copy/import remain disabled and collection actions reject stale revisions atomically', async () => {
    const before = await groups(); const copied = await action('copy', { id: 'manual' })
    assert.equal(copied.groups.find(row => row.group.id === copied.selectedId).group.enabled, false)
    assert.equal((await request('/api/routing/groups/actions', { action: 'discovery', enabled: true, revision: before.collectionRevision })).status, 409)
    await action('import', { version: 1, groups: [group('imported')] }); assert(!(await publicIds()).includes('group/imported'))
  })
  await step('patience retries a temporary 503 and returns the recovered upstream answer', async () => {
    const patient = group('patient', { members: [members[1]], patience: 3 }); await save(patient)
    recoverableFailures = 1; const before = calls.length
    assert.equal(content(await chat(patient.model)), 'south:gpt-4.1')
    assert.equal(calls.length - before, 2); assert.equal(recoverableFailures, 0)
  })
  await step('nested rotations advance only when their branch is selected', async () => {
    const children = []
    for (const [index, source] of ['north', 'south'].entries()) {
      const child = group(`round-${source}`, { strategy: 'rotate', members: [members[index], { ...members[index], id: `${source}-mini`, model: 'gpt-4.1-mini' }] })
      await save(child); children.push({ id: source, group: child.id, included: true, accounts: [] })
    }
    const parent = group('nested-round', { strategy: 'rotate', members: children }); await save(parent)
    const answers = []; for (let i = 0; i < 4; i++) answers.push(content(await chat(parent.model)))
    assert.equal(new Set(answers).size, 4, `Nested rotation starved a leaf: ${answers.join(', ')}`)
    const affinity = group('parent-affinity', { sticky: 'auto', members: [children[0]] }); await save(affinity)
    const headers = { 'x-session-id': 'nested-affinity-session' }
    const first = content(await chat(affinity.model, { messages: [{ role: 'user', content: 'first turn' }] }, adminKey, headers))
    const next = content(await chat(affinity.model, { messages: [{ role: 'user', content: 'second turn' }] }, adminKey, headers))
    assert.notEqual(first, next, 'Parent affinity must not override child sticky off')
  })
  await step('global routing rejects strategies that require group members', async () => {
    for (const strategy of ['manual', 'weight']) {
      assert.equal((await request('/api/routing', { routingStrategy: strategy }, adminKey, 'PUT')).status, 400)
    }
  })
  await step('legacy edits preserve advanced fields while explicit resets remain possible', async () => {
    const advanced = group('legacy', { firstToken: 7, patience: 9, sink: true, context: 12345, rules: [{ use: 'south', tokens: 200 }] }); await save(advanced)
    const legacy = group('legacy'); for (const key of ['patience', 'context']) delete legacy[key]
    legacy.name = 'Legacy editor'; const state = await save(legacy); const stored = state.groups.find(row => row.group.id === legacy.id).group
    assert.equal(stored.firstToken, 7); assert.equal(stored.context, 12345); assert.equal(stored.rules.length, 1)
    const reset = await save({ ...stored, firstToken: 0, rules: [] }); const cleared = reset.groups.find(row => row.group.id === legacy.id).group
    assert.equal(cleared.firstToken, 0); assert.deepEqual(cleared.rules, [])
  })
  await step('strict affinity reports a bound-account failure without sending to another account', async () => {
    const strict = group('strict', { sticky: 'strict' }); await save(strict)
    const headers = { 'x-session-id': 'strict-session' }
    const answer = content(await chat(strict.model, {}, adminKey, headers)); const selected = answer.split(':')[0]
    failure = selected; const before = calls.length
    const failed = await request('/v1/chat/completions', { model: strict.model, messages: [{ role: 'user', content: 'next' }] }, adminKey, 'POST', headers)
    failure = ''; assert(failed.status >= 400); assert(calls.slice(before).length > 0)
    assert(calls.slice(before).every(call => call.source === selected))
  })
  console.log(`PASS ${results.length} routing integration scenarios`)
} catch (error) { console.error(error); process.exitCode = 1 }
finally {
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({ passed: results, calls, error: process.exitCode ?? 0 }, null, 2))
  await writeFile(path.join(directory, 'server.log'), output)
  child.kill(); await Promise.race([exited, delay(5000)]); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  console.log(`Evidence ${directory}`)
}
