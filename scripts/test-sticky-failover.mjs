// Live routing contract against an isolated gateway and local HTTP channels.
// Usage: node scripts/test-sticky-failover.mjs <agent2api-server>
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const executable = path.resolve(process.argv[2] || 'target/debug/agent2api-server.exe')
await access(executable)
const scenarioFilter = process.argv[3] || process.env.STICKY_SCENARIO
if (!scenarioFilter) {
  // The historical lifecycle suite and policy matrix have independent state.
  // Use fresh gateways for each, instead of accumulating their accounts, route
  // groups, cooldowns and catalog maintenance into an unrelated load scenario.
  let exitCode = 0
  for (const phase of ['__core__', 'policy candidate failover']) {
    const run = spawn(process.execPath, [path.resolve(process.argv[1]), executable, phase],
      { stdio: 'inherit', windowsHide: true })
    const [code] = await once(run, 'exit')
    if (code !== 0) exitCode = 1
  }
  process.exit(exitCode)
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-sticky-failover-'))
const adminKey = 'isolated-sticky-failover-admin'
const calls = [], passed = [], failed = [], modes = new Map(), releases = new Map()
const sockets = new Set()
let closedHolds = 0, child, exited, output = '', base
const frame = value => `data: ${JSON.stringify(value)}\n\n`
const contentFrame = source => frame({ id: 'sticky-test', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content: source }, finish_reason: null }] })
const doneFrame = frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + 'data: [DONE]\n\n'

const upstream = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  const key = String(request.headers.authorization || request.headers['x-api-key'] || '').replace('Bearer ', '')
  const channel = key.split('-')[0]
  const topic = body.messages?.at(-1)?.content || body.input?.at(-1)?.content || ''
  calls.push({ channel, key, model: body.model, topic })
  const mode = modes.get(channel)
  if (mode?.status) {
    response.writeHead(mode.status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'isolated channel rejection', ...(mode.code ? { code: mode.code } : {}) } }))
    return
  }
  if (mode === 'edge-timeout' || mode === 'limited') {
    response.writeHead(mode === 'edge-timeout' ? 524 : 429)
    response.end()
    return
  }
  if (mode === 'slow-headers' || mode === 'slow-start' || mode === 'slow-failure') {
    await delay(mode === 'slow-headers' ? 1500 : 4000)
    if (response.destroyed) return
  }
  if (mode === 'fail' || mode === 'slow-failure' || mode === 'bad-request' || (mode?.remaining > 0 && mode.remaining--)) {
    response.writeHead(mode === 'bad-request' ? 400 : 503, { 'Content-Type': 'application/json', ...(mode?.retryAfter ? { 'Retry-After': String(mode.retryAfter) } : {}) })
    response.end(JSON.stringify({ error: { message: mode === 'bad-request' ? 'invalid request field' : 'temporarily overloaded' } }))
    return
  }
  if (request.url.endsWith('/responses') || request.url.endsWith('/messages')) {
    const isResponses = request.url.endsWith('/responses')
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = value => response.write(frame(value))
    if (isResponses) send({ type: 'response.output_text.delta', delta: mode === 'large-truncated' ? channel + 'x'.repeat(300000) : channel })
    else {
      send({ type: 'message_start', message: { id: 'sticky-message', role: 'assistant', usage: { input_tokens: 1 } } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: channel } })
    }
    if (mode === 'truncated' || mode === 'large-truncated') { await delay(75); response.end(); return }
    if (isResponses) send({ type: 'response.completed', response: { id: 'sticky-response', status: 'completed',
      ...(mode === 'large-completed' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(300000) }] }] } : {}),
      usage: { input_tokens: 1, output_tokens: 1 } } })
    else { send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }); send({ type: 'message_stop' }) }
    response.end()
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  response.write(frame({ choices: [{ index: 0, delta: { role: 'assistant' } }] }))
  if (mode === 'hold-control') {
    response.once('close', () => { closedHolds++ })
    return
  }
  if (mode === 'delayed-success') await new Promise(resolve => releases.set(topic, resolve))
  if (response.destroyed) return
  response.write(contentFrame(channel))
  if (mode === 'delayed-error' || mode === 'delayed-terminal') {
    await new Promise(resolve => releases.set(topic, resolve))
    if (!response.destroyed) response.end(mode === 'delayed-error'
      ? `event: error\n${frame({ error: { message: 'old configuration stream failed' } })}` : doneFrame)
    return
  }
  if (mode === 'hold') {
    response.once('close', () => { closedHolds++ })
    return
  }
  if (mode === 'late-error' || mode === 'truncated') {
    await delay(75)
    response.end(mode === 'late-error' ? `event: error\n${frame({ error: { message: 'upstream stream failed after content' } })}` : '')
    return
  }
  response.end(doneFrame)
})
upstream.on('connection', socket => {
  sockets.add(socket)
  socket.on('error', () => {})
  socket.once('close', () => sockets.delete(socket))
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')

async function request(endpoint, body, { key = adminKey, method = body === undefined ? 'GET' : 'POST', session = '', signal } = {}) {
  const response = await fetch(base + endpoint, { method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(session ? { 'x-session-id': session } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal || AbortSignal.timeout(20000) })
  const text = await response.text()
  let value
  try { value = JSON.parse(text) } catch { value = text }
  return { status: response.status, body: value?.success === true && Object.hasOwn(value, 'data') ? value.data : value,
    retryAfter: response.headers.get('retry-after') }
}
async function ok(...args) {
  const response = await request(...args)
  assert.equal(response.status, 200, `${args[0]}: ${JSON.stringify(response.body)}`)
  return response.body
}
async function until(label, check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error(`Gateway exited ${child.exitCode}`)
    const result = await check()
    if (result) return result
    await delay(30)
  }
  throw Error(`Timed out: ${label}`)
}
async function scenario(name, action) {
  if (scenarioFilter === '__core__' ? name.startsWith('policy candidate failover') : !name.includes(scenarioFilter)) return
  modes.clear()
  try { await action(); passed.push(name); console.log(`PASS ${name}`) }
  catch (error) { failed.push({ name, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`) }
  finally { modes.clear(); for (const release of releases.values()) release(); releases.clear() }
}
const members = []
let overflowSources = []
function group(id, patch = {}) {
  return { id, name: id, model: `sticky/${id}`, enabled: true, strategy: 'order', sticky: 'auto',
    firstToken: 0, patience: -1, context: 0, members: structuredClone(members), ...patch }
}
async function save(value) {
  const state = await ok('/api/routing/groups')
  await ok('/api/routing/groups', { id: value.id, group: value,
    revision: state.groups.find(row => row.group.id === value.id)?.revision ?? state.newRevision }, { method: 'PUT' })
  return value
}
const chatBody = (model, topic = 'ping', stream = false) => ({ model, stream, messages: [{ role: 'user', content: topic }] })
async function chat(value, session = value.id, topic = 'ping', key = adminKey) {
  const result = await ok('/v1/chat/completions', chatBody(value.model, topic), { session, key })
  return result.choices[0].message.content
}
async function warm(id, patch = {}, key = adminKey) {
  const value = await save(group(id, patch))
  assert.equal(await chat(value, value.id, 'warm', key), key === adminKey ? 'a' : 'b')
  return value
}
const sequence = start => calls.slice(start).map(call => call.channel)

try {
  const reserve = http.createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  base = `http://127.0.0.1:${port}`
  const env = { ...process.env, AGENT2API_PROXY_HOME: directory, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
    AGENT2API_PROXY_API_KEY: adminKey, AGENT2API_ACCOUNT_KEY: '4'.repeat(64), AGENT2API_SELF_UPDATE: '0',
    AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  child = spawn(executable, [], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(child, 'exit')
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-160000) })
  await until('gateway readiness', async () => { try { return await ok('/api/routing/groups') } catch { return false } })
  await ok('/api/retry', { retryCount: 0, retryCrossProviderCount: 0, retryIntervalSeconds: 0, noRetryStatusCodes: [] }, { method: 'PUT' })
  await ok('/api/routing', { routingFailoverBackoff: false, routingSink: false, routingBreakerEnabled: false,
    routingBreakerTimeoutSeconds: 10 }, { method: 'PUT' })
  const providers = []
  for (const channel of ['a', 'b', 'c']) {
    const created = await ok('/api/custom-providers', { name: `Channel ${channel}`, protocol: 'chat_completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', name: 'Main',
        apiKeys: channel === 'a' ? ['a-one', 'a-two'] : [`${channel}-one`], models: ['wire-fixture'], enabled: true }] })
    providers.push(created.provider.id)
    members.push({ id: channel, provider: created.provider.id, model: 'wire-fixture',
      accountScope: 'all', accounts: [], included: true, weight: 1 })
  }

  for (const endpoint of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
    await scenario(`stream wait ${endpoint} sends keepalive before delayed upstream headers`, async () => {
      const value = await save(group(`stream-wait-${endpoint.split('/').at(-1)}`))
      modes.set('a', 'slow-start')
      const body = endpoint.endsWith('/responses') ? { model: value.model, stream: true, input: 'ping' }
        : { ...chatBody(value.model, 'ping', true), ...(endpoint.endsWith('/messages') ? { max_tokens: 32 } : {}) }
      const started = Date.now()
      const response = await fetch(base + endpoint, { method: 'POST', headers: { Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
      const reader = response.body.getReader()
      try {
        const first = await reader.read()
        assert.equal(response.status, 200)
        assert(Date.now() - started < 1500, 'routing must expose keepalive before a short downstream first-byte timeout')
        assert(Buffer.from(first.value).toString().startsWith(':'), 'keepalive is an SSE comment, not model output')
        let text = Buffer.from(first.value).toString()
        for (;;) { const item = await reader.read(); if (item.done) break; text += Buffer.from(item.value).toString() }
        assert(text.includes('a'), 'the original slow candidate must still finish normally')
        assert(text.includes(endpoint.endsWith('/responses') ? 'response.completed' : endpoint.endsWith('/messages') ? 'message_stop' : '[DONE]'))
      } finally { await reader.cancel() }
    })
  }

  await scenario('stream wait keeps the request connected while first-content deadlines traverse accounts', async () => {
    const value = await save(group('stream-wait-failover', { firstToken: 1 }))
    modes.set('a', 'slow-start')
    const start = calls.length
    const response = await ok('/v1/chat/completions', chatBody(value.model, 'ping', true))
    assert(response.startsWith(':'))
    assert(response.includes('"content":"b"'))
    assert.deepEqual(sequence(start), ['a', 'a', 'b'])
  })

  await scenario('stream wait cancel after heartbeat drops pending inference without trying the next candidate', async () => {
    const value = await save(group('stream-wait-cancel', { firstToken: 1 }))
    modes.set('a', 'slow-start')
    const start = calls.length
    const controller = new AbortController()
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody(value.model, 'cancel', true)), signal: controller.signal })
    const reader = response.body.getReader()
    await reader.read()
    controller.abort()
    await reader.cancel().catch(() => {})
    await delay(2200)
    assert.deepEqual(sequence(start), ['a'], 'a disconnected caller must not consume the remaining account pool')
  })

  await scenario('stream wait sends recurring comments while a candidate has no content', async () => {
    const value = await save(group('stream-wait-heartbeats'))
    modes.set('a', 'delayed-success')
    const response = await fetch(base + '/v1/responses', { method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: value.model, stream: true, input: 'heartbeat-pending' }), signal: AbortSignal.timeout(20000) })
    const reader = response.body.getReader()
    try {
      assert(Buffer.from((await reader.read()).value).toString().startsWith(':'))
      const next = await reader.read()
      assert(Buffer.from(next.value).toString().startsWith(':'), 'protocol conversion must not swallow recurring keepalive')
      releases.get('heartbeat-pending')()
      let text = ''
      for (;;) { const item = await reader.read(); if (item.done) break; text += Buffer.from(item.value).toString() }
      assert(text.includes('response.completed'))
    } finally { await reader.cancel(); releases.get('heartbeat-pending')?.() }
  })

  await scenario('stream wait final failure after headers remains a protocol error with no fabricated completion', async () => {
    const value = await save(group('stream-wait-final-error', { sticky: 'off', members: [members[1]] }))
    modes.set('b', 'slow-failure')
    const start = calls.length
    const result = await request('/v1/responses', { model: value.model, stream: true, input: 'slow-error' })
    assert.equal(result.status, 200, 'headers have already started the SSE response')
    assert(result.body.includes('temporarily overloaded'))
    assert(result.body.includes('response.failed'))
    assert(!result.body.includes('response.completed'))
    assert.deepEqual(sequence(start), ['b'])
  })

  await scenario('stream wait fast validation failures and non-streaming JSON retain their HTTP behavior', async () => {
    const missing = await request('/v1/chat/completions', { model: 'not-a-model', stream: true, messages: [] })
    assert.equal(missing.status, 404)
    const invalid = await save(group('stream-wait-bad-request'))
    modes.set('a', 'bad-request')
    const rejected = await request('/v1/chat/completions', chatBody(invalid.model, 'invalid', true))
    assert.equal(rejected.status, 400, 'a fast upstream rejection must remain an HTTP error')
    assert.equal(typeof rejected.body, 'object')
    modes.clear()
    const value = await save(group('stream-wait-json'))
    modes.set('a', 'slow-start')
    const result = await request('/v1/chat/completions', chatBody(value.model))
    assert.equal(result.status, 200)
    assert.equal(result.body.choices[0].message.content, 'a', 'JSON clients must not receive SSE comments')
  })

  await scenario('two failures freeze every Key in A and move the sticky session to B', async () => {
    const value = await warm('two-failures')
    modes.set('a', 'fail')
    const start = calls.length
    assert.equal(await chat(value), 'b')
    assert.deepEqual(sequence(start), ['a', 'a', 'b'])
    modes.clear()
    const next = calls.length
    assert.equal(await chat(value, 'another-session'), 'b')
    assert.deepEqual(sequence(next), ['b'], 'A second Key must not bypass the frozen member')
    const independent = await save(group('independent-entry'))
    assert.equal(await chat(independent), 'a', 'Cooling is scoped to the public routing entry')
  })

  await scenario('an empty HTTP 524 retries another account and freezes the failed channel before answering from B', async () => {
    const value = await warm('edge-524')
    modes.set('a', 'edge-timeout')
    const start = calls.length
    assert.equal(await chat(value), 'b')
    assert.deepEqual(sequence(start), ['a', 'a', 'b'])
    assert.notEqual(calls[start].key, calls[start + 1].key)
    modes.clear()
    assert.equal(await chat(value, 'edge-524-new-session'), 'b', '524 must freeze every Key of A')
  })

  await scenario('all account candidates are considered when one channel has eight quota failures', async () => {
    const created = await ok('/api/custom-providers', { name: 'Eight quota accounts', protocol: 'chat_completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', name: 'Main',
        apiKeys: Array.from({ length: 8 }, (_, index) => `quota-${index}`), models: ['wire-fixture'], enabled: true }] })
    const value = await save(group('account-budget', { members: [{ id: 'quota', provider: created.provider.id,
      model: 'wire-fixture', accountScope: 'all', accounts: [], included: true, weight: 1 }, members[1]] }))
    modes.set('quota', 'limited')
    const start = calls.length
    assert.equal(await chat(value), 'b')
    assert.deepEqual(sequence(start), ['quota', 'quota', 'quota', 'quota', 'quota', 'quota', 'quota', 'quota', 'b'])
    assert.equal(new Set(calls.slice(start, start + 8).map(call => call.key)).size, 8)
  })

  await scenario('B and C follow the same two-failure rule and all-frozen requests send nothing', async () => {
    const value = await warm('cascade')
    modes.set('a', 'fail')
    assert.equal(await chat(value), 'b')
    modes.set('b', 'fail')
    const start = calls.length
    assert.equal(await chat(value), 'c')
    assert.deepEqual(sequence(start), ['b', 'b', 'c'])
    modes.set('c', 'fail')
    const before = calls.length
    const exhausted = await request('/v1/chat/completions', chatBody(value.model), { session: value.id })
    assert.equal(exhausted.status, 503)
    assert.deepEqual(sequence(before), ['c', 'c'])
    assert(JSON.stringify(exhausted.body).includes('route_cooling_down'))
    assert(Number(exhausted.retryAfter) > 0 && Number(exhausted.retryAfter) <= 10)
    const frozen = calls.length
    const again = await request('/v1/chat/completions', chatBody(value.model), { session: 'new-frozen-session' })
    assert.equal(again.status, 503)
    assert.equal(calls.length, frozen, 'All-frozen must not send another upstream request')
  })

  await scenario('a completed success clears the failure chain before the next failure', async () => {
    const value = await warm('success-reset')
    modes.set('a', { remaining: 1 })
    const first = calls.length
    assert.equal(await chat(value), 'a')
    assert.deepEqual(sequence(first), ['a', 'a'])
    modes.set('a', 'fail')
    const second = calls.length
    assert.equal(await chat(value), 'b')
    assert.deepEqual(sequence(second), ['a', 'a', 'b'])
  })

  await scenario('strict affinity retries its member once and releases it after the second failure', async () => {
    const value = await warm('strict-failure', { sticky: 'strict' })
    modes.set('a', { remaining: 1 })
    const first = calls.length
    assert.equal(await chat(value), 'a')
    assert.deepEqual(sequence(first), ['a', 'a'])
    modes.set('a', 'fail')
    const second = calls.length
    assert.equal(await chat(value), 'b')
    assert.deepEqual(sequence(second), ['a', 'a', 'b'])
  })

  await scenario('the first sticky retry honors the upstream Retry-After header', async () => {
    const value = await warm('retry-after')
    modes.set('a', { remaining: 1, retryAfter: 1 })
    const start = calls.length, started = performance.now()
    assert.equal(await chat(value), 'a')
    assert.deepEqual(sequence(start), ['a', 'a'])
    assert(performance.now() - started >= 950, 'The retry cannot resend before the upstream cooldown')
  })

  await scenario('invalid request responses neither switch nor freeze the channel', async () => {
    const value = await warm('request-rejection')
    modes.set('a', 'bad-request')
    const start = calls.length
    for (let i = 0; i < 2; i++) {
      const rejected = await request('/v1/chat/completions', chatBody(value.model), { session: value.id })
      assert.equal(rejected.status, 400)
    }
    assert.deepEqual(sequence(start), ['a', 'a'])
    modes.clear()
    assert.equal(await chat(value), 'a')
  })

  await scenario('unsent local request construction errors never freeze a sticky channel', async () => {
    const created = await ok('/api/custom-providers', { name: 'Unsent authorization fixture', protocol: 'chat_completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      keyGroups: [{ id: 'main', name: 'Main', apiKeys: ['unsent\none'], models: ['wire-fixture'], enabled: true }] })
    const value = await save(group('unsent-construction', { members: [{ id: 'unsent', provider: created.provider.id,
      model: 'wire-fixture', accountScope: 'all', accounts: [], included: true, weight: 1 }] }))
    const before = calls.length
    for (let attempt = 0; attempt < 3; attempt++) {
      const failed = await request('/v1/chat/completions', chatBody(value.model), { session: value.id })
      assert.equal(failed.status, 502, 'A local build error must stay a build error rather than route_cooling_down')
      assert(!JSON.stringify(failed.body).includes('route_cooling_down'))
    }
    assert.equal(calls.length, before, 'Invalid headers must never reach the local upstream')
  })

  await scenario('restricted gateway Keys cannot fail over into forbidden channels', async () => {
    const value = await save(group('key-scope'))
    const key = 'only-b-and-c-sticky-test'
    await ok('/api/keys', { name: key, key, allowedProviders: providers.slice(1), allowedModels: [value.model] })
    assert.equal(await chat(value, value.id, 'warm', key), 'b')
    modes.set('b', 'fail')
    const start = calls.length
    assert.equal(await chat(value, value.id, 'next', key), 'c')
    assert.deepEqual(sequence(start), ['b', 'b', 'c'])
  })

  for (const mode of ['late-error', 'truncated']) {
    await scenario(`${mode} after content freezes A for subsequent requests without starting a second reply`, async () => {
      const value = await warm(mode)
      modes.set('a', mode)
      for (let i = 0; i < 2; i++) {
        const start = calls.length
        const result = await request('/v1/chat/completions', chatBody(value.model, `stream-${i}`, true), { session: value.id })
        assert.equal(result.status, 200)
        assert.equal(typeof result.body, 'string')
        assert(result.body.includes('"content":"a"'))
        assert.deepEqual(sequence(start), ['a'], 'Committed content cannot start a second upstream reply')
      }
      modes.clear()
      assert.equal(await chat(value), 'b')
    })
  }

  for (const sticky of ['auto', 'strict']) await scenario(`cross-request ${sticky} first incomplete reply prefers another account in the same channel`, async () => {
    const value = await warm('cross-request-account-' + sticky, { sticky })
    modes.set('a', 'truncated')
    const first = calls.length
    await request('/v1/chat/completions', chatBody(value.model, 'first-incomplete', true), { session: value.id })
    assert.deepEqual(sequence(first), ['a'])
    const second = calls.length
    await request('/v1/chat/completions', chatBody(value.model, 'second-incomplete', true), { session: value.id })
    assert.deepEqual(sequence(second), ['a'], 'Each partially delivered reply must submit only once')
    assert.notEqual(calls[second].key, calls[first].key, 'The next request must prefer another available account of A')
    modes.clear()
    assert.equal(await chat(value), 'b', 'Two incomplete requests must freeze every account of A')
  })

  await scenario('cross-request completed response on another account resets the channel failure chain', async () => {
    const value = await warm('cross-request-completed-reset')
    modes.set('a', 'truncated')
    const initial = calls.length
    await request('/v1/chat/completions', chatBody(value.model, 'first-incomplete', true), { session: value.id })
    modes.clear()
    assert.equal(await chat(value), 'a')
    assert.notEqual(calls[initial].key, calls[initial + 1].key)
    modes.set('a', 'truncated')
    await request('/v1/chat/completions', chatBody(value.model, 'new-first-incomplete', true), { session: value.id })
    modes.clear()
    assert.equal(await chat(value), 'a', 'One failure after a complete success must not freeze A')
  })

  await scenario('cross-request nested strict affinity rotates accounts before releasing its channel', async () => {
    const nested = await save(group('cross-request-nested-child', { sticky: 'strict', members: structuredClone(members.slice(0, 2)) }))
    const value = await save(group('cross-request-nested-parent', { members: [
      { id: 'nested', group: nested.id, provider: '', model: '', included: true, accounts: [] }, members[2],
    ] }))
    assert.equal(await chat(value), 'a')
    modes.set('a', 'truncated')
    const first = calls.length
    for (let index = 0; index < 2; index++) {
      const before = calls.length
      await request('/v1/chat/completions', chatBody(value.model, 'nested-incomplete-' + index, true), { session: value.id })
      assert.equal(calls.length, before + 1)
    }
    assert.notEqual(calls[first].key, calls[first + 1].key)
    modes.clear()
    assert.equal(await chat(value), 'b')
  })

  for (const stage of ['before-content', 'before-first-content', 'after-content']) {
    await scenario(`cross-request client disconnect ${stage} advances account then freezes the channel`, async () => {
      const value = await warm('cross-request-disconnect-' + stage)
      const start = calls.length
      modes.set('a', stage === 'before-content' ? 'slow-headers' : stage === 'before-first-content' ? 'hold-control' : 'hold')
      for (let index = 0; index < 2; index++) {
        const previous = calls.length
        const closed = closedHolds
        const controller = new AbortController()
        const pending = fetch(base + '/v1/chat/completions', { method: 'POST',
          headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json', 'x-session-id': value.id },
          body: JSON.stringify(chatBody(value.model, `disconnect-${index}`, true)), signal: controller.signal })
        // Attach a handler before aborting: the pre-header fetch intentionally rejects.
        pending.catch(() => {})
        await until('upstream received interrupted request', () => calls.length > previous)
        if (stage === 'after-content') {
          const response = await pending
          const reader = response.body.getReader()
          let text = ''
          while (!text.includes('"content":"a"')) {
            const chunk = await reader.read()
            assert(!chunk.done)
            text += new TextDecoder().decode(chunk.value)
          }
          controller.abort()
          await reader.cancel().catch(() => {})
          await until('interrupted stream closed upstream', () => closedHolds > closed)
        } else {
          controller.abort()
          await pending.catch(() => {})
          if (stage === 'before-first-content') await until('control-only stream closed upstream', () => closedHolds > closed)
          else await delay(250)
        }
        assert.equal(calls.length, previous + 1, 'An interrupted request must never replay to another upstream')
      }
      modes.clear()
      const next = await chat(value)
      assert.equal(next, 'b', 'Two interrupted requests must freeze all A accounts for subsequent requests')
      assert.notEqual(calls[start].key, calls[start + 1].key, 'The second request must prefer the other available account of A')
    })
  }

  for (const [protocol, channel] of [['responses', 'r'], ['anthropic', 'n']]) {
    await scenario(protocol + ' raw EOF without a terminal freezes the channel despite compatibility closing frames', async () => {
      const created = await ok('/api/custom-providers', { name: 'Raw ' + protocol, protocol,
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', name: 'Main', apiKeys: [channel + '-one'], models: ['wire-fixture'], enabled: true }] })
      const value = await save(group('raw-' + protocol, { members: [{ id: channel, provider: created.provider.id,
        model: 'wire-fixture', accountScope: 'all', accounts: [], included: true, weight: 1 }, members[1]] }))
      assert.equal(await chat(value), channel)
      modes.set(channel, 'truncated')
      for (let i = 0; i < 2; i++) {
        const start = calls.length
        const response = await request('/v1/chat/completions', chatBody(value.model, 'raw-' + i, true), { session: value.id })
        assert.equal(response.status, 200)
        assert(response.body.includes('"content":"' + channel + '"'))
        assert.deepEqual(sequence(start), [channel])
      }
      modes.clear()
      assert.equal(await chat(value), 'b')
    })
  }

  await scenario('large Responses completion events retain successful affinity without Chat DONE', async () => {
    const channel = 'large'
    const created = await ok('/api/custom-providers', { name: 'Large Responses completion', protocol: 'responses',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', apiKeys: [channel + '-one'], models: ['wire-fixture'], enabled: true }] })
    const value = await save(group('large-responses', { members: [{ id: channel, provider: created.provider.id,
      model: 'wire-fixture', accountScope: 'all', accounts: [], included: true, weight: 1 }, members[1]] }))
    modes.set(channel, 'large-completed')
    assert.equal(await chat(value), channel, 'A parsed 300 KB terminal must not turn an aggregated response into 502')
    for (let i = 0; i < 2; i++) {
      const response = await request('/v1/chat/completions', chatBody(value.model, 'large-' + i, true), { session: value.id })
      assert.equal(response.status, 200)
      assert(response.body.includes('"content":"' + channel + '"'))
      assert(!response.body.includes('"error":'), 'A legitimate completed event must not create an EOF error')
    }
    assert.equal(await chat(value), channel, 'The healthy channel must remain eligible after two large terminals')
  })

  await scenario('large Responses content without a real terminal still freezes the channel', async () => {
    const channel = 'largepartial'
    const created = await ok('/api/custom-providers', { name: 'Large Responses missing completion', protocol: 'responses',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', apiKeys: [channel + '-one'], models: ['wire-fixture'], enabled: true }] })
    const value = await save(group('large-partial-responses', { members: [{ id: channel, provider: created.provider.id,
      model: 'wire-fixture', accountScope: 'all', accounts: [], included: true, weight: 1 }, members[1]] }))
    assert.equal(await chat(value), channel)
    modes.set(channel, 'large-truncated')
    for (let i = 0; i < 2; i++) {
      const start = calls.length
      const response = await request('/v1/chat/completions', chatBody(value.model, 'large-partial-' + i, true), { session: value.id })
      assert.equal(response.status, 200)
      assert(response.body.includes('"content":"' + channel))
      assert(response.body.includes('"error":'), 'Real EOF must remain a failure even after oversized content')
      assert.deepEqual(sequence(start), [channel], 'Partial content cannot start another reply')
    }
    modes.clear()
    assert.equal(await chat(value), 'b')
  })

  await scenario('old configuration failures cannot freeze the replacement channel', async () => {
    const value = await save(group('configuration-failures', { members: [{ ...members[0], id: 'source' }, members[2]] }))
    assert.equal(await chat(value), 'a')
    modes.set('a', 'delayed-error')
    const pending = [0, 1].map(index => request('/v1/chat/completions', chatBody(value.model, 'old-config-' + index, true), { session: value.id }))
    await until('two old configuration streams have sent content', () => releases.has('old-config-0') && releases.has('old-config-1'))
    value.members[0] = { ...members[1], id: 'source' }
    await save(value)
    assert.equal(await chat(value), 'b')
    for (let index = 0; index < 2; index++) releases.get('old-config-' + index)()
    const finished = await Promise.all(pending)
    assert(finished.every(result => result.body.includes('"error":')))
    modes.clear()
    assert.equal(await chat(value), 'b', 'The new provider must not inherit late failures from the replaced provider')
  })

  await scenario('an old configuration success cannot clear the replacement failure chain', async () => {
    const value = await save(group('configuration-success', { members: [{ ...members[0], id: 'source' }, members[2]] }))
    assert.equal(await chat(value), 'a')
    modes.set('a', 'delayed-terminal')
    const pending = chat(value, value.id, 'old-config-success')
    await until('old configuration success has sent content', () => releases.has('old-config-success'))
    value.members[0] = { ...members[1], id: 'source' }
    await save(value)
    modes.set('b', 'late-error')
    const first = await request('/v1/chat/completions', chatBody(value.model, 'new-config-failure-1', true), { session: value.id })
    assert(first.body.includes('"error":'))
    releases.get('old-config-success')()
    assert.equal(await pending, 'a')
    const second = await request('/v1/chat/completions', chatBody(value.model, 'new-config-failure-2', true), { session: value.id })
    assert(second.body.includes('"error":'))
    modes.clear()
    assert.equal(await chat(value), 'c', 'Two new failures must still freeze B despite a late success from old A')
  })

  await scenario('explicit manual cancellation of an active stream does not count as channel failure', async () => {
    const value = await warm('manual-cancellation')
    modes.set('a', 'hold')
    for (let i = 0; i < 2; i++) {
      const closed = closedHolds
      const controller = new AbortController()
      const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
        headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json', 'x-session-id': value.id },
        body: JSON.stringify(chatBody(value.model, `cancel-${i}`, true)), signal: controller.signal })
      const reader = response.body.getReader()
      let text = ''
      while (!text.includes('"content":"a"')) {
        const next = await reader.read()
        assert(!next.done)
        text += new TextDecoder().decode(next.value)
      }
      const active = await until('manual cancellation request row', async () => {
        const rows = await ok('/api/stats/requests?model=' + encodeURIComponent(value.model))
        return rows.entries.find(row => row.status === 0 && row.model === value.model)
      })
      await ok('/api/stats/requests/terminate?id=' + encodeURIComponent(active.id), {}, { method: 'POST' })
      controller.abort()
      await reader.cancel().catch(() => {})
      await until('upstream cancellation', () => closedHolds > closed)
    }
    modes.clear()
    assert.equal(await chat(value), 'a')
  })

  await scenario('an earlier in-flight success cannot undo a newer freeze or restore A affinity', async () => {
    const value = await warm('late-success')
    modes.set('a', 'delayed-success')
    const pending = chat(value, value.id, 'held-success')
    await until('delayed success in flight', () => releases.has('held-success'))
    modes.set('a', 'late-error')
    for (let i = 0; i < 2; i++) await request('/v1/chat/completions', chatBody(value.model, `freeze-${i}`, true), { session: value.id })
    modes.clear()
    assert.equal(await chat(value), 'b')
    releases.get('held-success')()
    assert.equal(await pending, 'a')
    assert.equal(await chat(value), 'b')
    assert.equal(await chat(value, 'late-success-new-session'), 'b')
  })

  await scenario('a strict nested pool also releases the failed leaf and selects its next channel', async () => {
    const nested = await save(group('nested-child', { sticky: 'strict', members: structuredClone(members.slice(0, 2)) }))
    const parent = await save(group('nested-parent', { sticky: 'auto', members: [
      { id: 'nested', group: nested.id, provider: '', model: '', included: true, accounts: [] }, members[2],
    ] }))
    assert.equal(await chat(parent), 'a')
    modes.set('a', 'fail')
    const start = calls.length
    assert.equal(await chat(parent), 'b')
    assert.deepEqual(sequence(start), ['a', 'a', 'b'])
    modes.clear()
    assert.equal(await chat(parent), 'b')
  })

  await scenario('the successful channel binds correctly beyond the attempt detail capacity', async () => {
    const overflowMembers = []
    overflowSources = overflowMembers
    for (let index = 0; index < 13; index++) {
      const channel = `overflow${index}`
      const created = await ok('/api/custom-providers', { name: `Overflow channel ${index}`, protocol: 'chat_completions',
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', name: 'Main',
          apiKeys: [`${channel}-one`], models: ['wire-overflow'], enabled: true }] })
      overflowMembers.push({ id: channel, provider: created.provider.id, model: 'wire-overflow',
        accountScope: 'all', accounts: [], included: true, weight: 1 })
      if (index < 12) modes.set(channel, 'fail')
    }
    const value = await save(group('overflow-attempts', { members: overflowMembers }))
    const start = calls.length
    assert.equal(await chat(value), 'overflow12')
    assert.deepEqual(sequence(start), overflowMembers.flatMap((member, index) => index < 12 ? [member.id, member.id] : [member.id]))
    const bindings = await ok(`/api/routing/sticky?model=${encodeURIComponent(value.model)}`)
    assert.ok(bindings.entries.length > 0, 'The completed response must create affinity')
    assert.ok(bindings.entries.every(entry => entry.memberId === 'overflow12'),
      `Affinity must target the successful channel after 25 sends: ${JSON.stringify(bindings.entries.map(entry => entry.memberId))}`)
  })

  await scenario('first content deadlines still freeze a channel after the attempt detail capacity', async () => {
    const created = await ok('/api/custom-providers', { name: 'Overflow deadline fallback', protocol: 'chat_completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', apiKeys: ['overflowlast-one'],
        models: ['wire-overflow'], enabled: true }] })
    const final = { id: 'overflowlast', provider: created.provider.id, model: 'wire-overflow',
      accountScope: 'all', accounts: [], included: true, weight: 1 }
    const value = await save(group('overflow-deadline', { firstToken: 1, members: [...overflowSources, final] }))
    for (const member of overflowSources.slice(0, 12)) modes.set(member.id, 'fail')
    modes.set('overflow12', 'slow-headers')
    const start = calls.length
    assert.equal(await chat(value), 'overflowlast')
    assert.deepEqual(sequence(start), [...overflowSources.flatMap(member => [member.id, member.id]), 'overflowlast'])
  })

  await scenario('a frozen channel can participate again after the configured timeout', async () => {
    const value = await warm('cooldown-expiry')
    modes.set('a', 'fail')
    assert.equal(await chat(value), 'b')
    modes.clear()
    assert.equal(await chat(value, 'during-cooldown'), 'b')
    await delay(10100)
    assert.equal(await chat(value, 'after-cooldown'), 'a')
  })

  // These exercise the real gateway's policy/affinity boundary. Each case has
  // fresh accounts so authentication cooling and provider penalties stay local.
  for (const sticky of ['auto', 'strict', 'off']) {
    for (const test of [
      { status: 401, channels: ['a', 'a', 'b'] },
      { status: 402, channels: ['a', 'a', 'b'] },
      { status: 403, channels: ['a', 'a', 'b'] },
      { status: 404, code: 'model_not_found', channels: ['a', 'b'] },
      { status: 501, channels: ['a', 'b'] },
      { status: 400, channels: ['a', 'b'] },
      { status: 503, action: 'return_error', channels: ['a'] },
      { status: 501, protocol: 'responses', only: 'auto', channels: ['a', 'b'] },
      { status: 401, protocol: 'anthropic', only: 'auto', channels: ['a', 'a', 'b'] },
      { status: 401, nested: true, only: 'strict', channels: ['a', 'a', 'b'] },
      { status: 501, stream: true, only: 'auto', channels: ['a', 'b'] },
      { status: 503, code: 'plugin_response_started', only: 'auto', channels: ['a'] },
      { status: 401, switches: 0, only: 'auto', channels: ['a'] },
      { status: 503, action: 'switch_provider', health: true, only: 'auto', channels: ['a', 'b'] },
    ]) {
      if (test.only && test.only !== sticky) continue
      const suffix = `${test.protocol || ''}${test.nested ? 'nested' : ''}${test.stream ? 'stream' : ''}${test.code === 'plugin_response_started' ? 'hardstop' : ''}${test.switches === 0 ? 'zero' : ''}${test.health ? 'health' : ''}`
      await scenario(`policy candidate failover ${sticky} HTTP ${test.status}${suffix ? ' ' + suffix : ''}`, async () => {
        const tag = `policy${sticky}${test.status}${suffix}`
        const localMembers = []
        for (const channel of ['a', 'b']) {
          const source = `${tag}${channel}`
          const created = await ok('/api/custom-providers', { name: source, protocol: test.protocol || 'chat_completions',
            baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', name: 'Main',
              apiKeys: channel === 'a' ? [`${source}-one`, `${source}-two`] : [`${source}-one`],
              models: ['wire-fixture'], enabled: true }] })
          localMembers.push({ id: channel, provider: created.provider.id, model: 'wire-fixture',
            accountScope: 'all', accounts: [], included: true, weight: 1 })
        }
        const original = await ok('/api/routing/errors')
        try {
          const settings = { ...original.defaults, resends: 0, switches: test.switches ?? 5, intervalSeconds: 0,
            backoff: false, sink: false, breaker: false }
          if (test.action) settings.rules.find(rule => rule.kind === 'transient').action = test.action
          await ok('/api/routing/errors', { settings, revision: original.revision }, { method: 'PUT' })
          const nested = test.nested ? await save(group(`${tag}child`, { sticky: 'strict', members: localMembers })) : null
          const value = await save(group(tag, { sticky, members: nested
            ? [{ id: 'nested', group: nested.id, provider: '', model: '', included: true, accounts: [] }]
            : localMembers }))
          assert.equal(await chat(value), `${tag}a`, 'warm the selected channel before it fails')
          modes.set(`${tag}a`, { status: test.status, code: test.code })
          const start = calls.length
          const response = await request('/v1/chat/completions', chatBody(value.model, 'ping', Boolean(test.stream)), { session: value.id })
          assert.deepEqual(sequence(start), test.channels.map(channel => `${tag}${channel}`),
            'one client request must follow the selected error action through eligible candidates')
          if (test.channels.at(-1) === 'a') assert.equal(response.status, test.status)
          else {
            assert.equal(response.status, 200)
            if (test.stream) {
              assert(response.body.includes(`"content":"${tag}b"`))
              assert(response.body.includes('data: [DONE]'))
            } else assert.equal(response.body.choices[0].message.content, `${tag}b`)
          }
          if (test.health) {
            const second = calls.length
            assert.equal(await chat(value, `${tag}-second-session`), `${tag}b`)
            assert.deepEqual(sequence(second), [`${tag}a`, `${tag}b`])
            const frozen = calls.length
            assert.equal(await chat(value, `${tag}-frozen-session`), `${tag}b`)
            assert.deepEqual(sequence(frozen), [`${tag}b`], 'two actual transient failures must freeze A even when the policy skips its provider')
          }
        } finally {
          const current = await ok('/api/routing/errors')
          await ok('/api/routing/errors', { settings: original.settings, revision: current.revision }, { method: 'PUT' })
        }
      })
    }
  }
  if (failed.length) process.exitCode = 1
  console.log(`Sticky failover: ${passed.length} passed, ${failed.length} failed`)
} catch (error) { failed.push({ name: 'fixture', error: error.stack }); console.error(error); process.exitCode = 1 }
finally {
  for (const release of releases.values()) release()
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({ passed, failed, calls }, null, 2))
  await writeFile(path.join(directory, 'server.log'), output)
  if (child?.exitCode === null) child.kill()
  if (exited) await Promise.race([exited, delay(5000)])
  for (const socket of sockets) socket.destroy()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  console.log(`Evidence ${directory}`)
}
