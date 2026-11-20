// Local-only HTTP acceptance for the beta.4 canonical model-ID fix.
// node scripts/test-beta4-compatibility.mjs <agent2api-server>
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const executable = path.resolve(process.argv[2] || 'target/debug/agent2api-server.exe')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-beta4-'))
const key = ['beta4', 'test', 'admin', 'local', 'only'].join('-')
const calls = [], failures = []
let passed = 0, logs = ''
const upstream = http.createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  calls.push(body)
  if (body.model !== 'Model-Exact') {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'This upstream requires the exact ID Model-Exact' } }))
    return
  }
  response.setHeader('Content-Type', 'text/event-stream')
  const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`)
  if (request.url.endsWith('/responses')) {
    send({ type: 'response.output_text.delta', delta: 'canonical-ok' })
    send({ type: 'response.completed', response: { id: 'resp-case', status: 'completed',
      usage: { input_tokens: 1, output_tokens: 1 } } })
  } else if (request.url.endsWith('/messages')) {
    send({ type: 'message_start', message: { id: 'msg-case', role: 'assistant', usage: { input_tokens: 1 } } })
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'canonical-ok' } })
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    send({ type: 'message_stop' })
  } else {
    send({ id: 'chat-case', model: body.model,
      choices: [{ index: 0, delta: { content: 'canonical-ok' }, finish_reason: null }] })
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 } })
    response.write('data: [DONE]\n\n')
  }
  response.end()
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
const reserve = http.createServer()
reserve.listen(0, '127.0.0.1')
await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const child = spawn(executable, [], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENT2API_PROXY_HOME: directory, AGENT2API_HOST: '127.0.0.1',
    AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: key, AGENT2API_ACCOUNT_KEY: '6'.repeat(64),
    AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_PANEL_PORT: '',
    AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' } })
const exited = once(child, 'close')
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', value => { logs = (logs + value).slice(-64000) })
const base = `http://127.0.0.1:${port}`
async function api(endpoint, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + endpoint, { method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) })
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  return value.success === true && Object.hasOwn(value, 'data') ? value.data : value
}
async function check(label, action) {
  try { await action(); passed++; console.log(`PASS ${label}`) }
  catch (error) { failures.push(`${label}: ${error.message}`); console.error(`FAIL ${failures.at(-1)}`) }
}
try {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('Fixture server exited')
    try { if ((await fetch(base + '/health')).ok) { ready = true; break } } catch {}
    await delay(250)
  }
  assert.ok(ready, 'Fixture server did not start')
  await check('new installations check for updates every four hours', async () => {
    const task = (await api('/api/scheduled-tasks')).tasks.find(task => task.id === 'updateCheck')
    assert.equal(task.interval, 240)
    assert.equal(task.defaultInterval, 240)
  })
  await check('saved update intervals retain their value', async () => {
    await api('/api/scheduled-tasks/updateCheck', { enabled: false, interval: 77 }, 'PATCH')
    const task = (await api('/api/scheduled-tasks')).tasks.find(task => task.id === 'updateCheck')
    assert.equal(task.interval, 77)
    assert.equal(task.enabled, false)
  })
  for (const protocol of ['chat_completions', 'responses', 'anthropic']) {
    const { provider } = await api('/api/custom-providers', { name: protocol, protocol,
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      keyGroups: [{ id: 'case', enabled: true, apiKeys: ['local-case-key'], models: ['Model-Exact'] }] })
    for (const stream of [false, true]) {
      await check(`${protocol} source test canonical ID stream=${stream}`, async () => {
        const result = await api('/api/models/test', { provider: provider.id, model: 'model-exact', stream })
        assert.equal(result.status, 200, result.error)
        assert.equal(result.reply, 'canonical-ok')
        assert.equal(calls.at(-1).model, 'Model-Exact')
      })
    }
    for (const member of ['Model-Exact', 'model-exact']) {
      const model = `${protocol}-Public-${member === 'Model-Exact' ? 'catalog' : 'folded'}`
      const catalog = await api('/api/routing/groups')
      await api('/api/routing/groups', { revision: catalog.newRevision, id: model, group: {
        id: model, model, name: model, enabled: true, strategy: 'order', sticky: 'off',
        members: [{ id: 'case-source', provider: provider.id, model: member, included: true,
          accountScope: 'all', accounts: [] }],
      } }, 'PUT')
      for (const stream of [false, true]) {
        await check(`${protocol} public route member=${member} stream=${stream}`, async () => {
        const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(15000) })
        const text = await response.text()
        assert.equal(response.status, 200, text)
        assert.ok(text.includes('canonical-ok'), text)
        assert.equal(calls.at(-1).model, 'Model-Exact')
        if (stream) {
          assert.ok(text.includes('[DONE]'), text)
          assert.ok(text.includes(`"model":"${model}"`), text)
        } else assert.equal(JSON.parse(text).model, model)
        })
      }
    }
  }
  assert.deepEqual(failures, [], `${failures.length} beta.4 compatibility failures`)
  console.log(`PASS ${passed} beta.4 HTTP compatibility cases`)
} finally {
  child.kill()
  await exited
  await new Promise(resolve => upstream.close(resolve))
  await writeFile(path.join(directory, 'server.log'), logs)
  console.log(`Evidence: ${directory}`)
}
