// Local-only regression for Grok relays requiring explicit tool `required` arrays.
// node scripts/test-grok-tool-schema.mjs <agent2api-server executable>
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const executable = path.resolve(process.argv[2] || 'target/debug/agent2api-server.exe')
const temp = await mkdtemp(path.join(os.tmpdir(), 'agent2api-grok-schema-'))
const key = 'grok-schema-local-fixture'
const calls = []
const upstream = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  calls.push(body)
  const schema = body.tools?.[0]?.function?.parameters ?? body.tools?.[0]?.parameters ?? body.tools?.[0]?.input_schema
  if (body.model === 'grok-4.7' && schema && !Array.isArray(schema.required)) {
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Schema validation failed: /required: null is not of type "array"' } }))
    return
  }
  response.setHeader('Content-Type', 'text/event-stream')
  const send = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
  if (request.url.endsWith('/responses')) {
    send({ type: 'response.output_text.delta', delta: 'OK' })
    send({ type: 'response.completed', response: { id: 'resp-test', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } })
  } else if (request.url.endsWith('/messages')) {
    send({ type: 'message_start', message: { id: 'msg-test', role: 'assistant', usage: { input_tokens: 1 } } })
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } })
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    send({ type: 'message_stop' })
  } else {
    send({ id: 'chat-test', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })
    send({ id: 'chat-test', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
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
const child = spawn(executable, [], { cwd: temp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, AGENT2API_PROXY_HOME: temp, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
  AGENT2API_PROXY_API_KEY: key, AGENT2API_ACCOUNT_KEY: '7'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0',
  AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '',
} })
const exited = once(child, 'exit')
let logs = ''
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { logs = (logs + chunk).slice(-16000) })
const base = `http://127.0.0.1:${port}`
async function api(endpoint, body) {
  const response = await fetch(base + endpoint, { method: body ? 'POST' : 'GET', headers: {
    Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
  }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result.success === true ? result.data : result
}
let passed = 0
try {
  let ready = false
  for (let n = 0; n < 120; n++) {
    if (child.exitCode !== null) throw new Error('Fixture server exited')
    try { if ((await fetch(base + '/health')).ok) { ready = true; break } } catch {}
    await delay(250)
  }
  assert(ready, 'Fixture server did not start')
  for (const protocol of ['chat_completions', 'responses', 'anthropic']) {
    const channel = await api('/api/custom-providers', { name: protocol, protocol,
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      keyGroups: [{ id: 'main', enabled: true, apiKeys: ['local-upstream-key'], models: ['grok-4.7', 'other-model'] }],
    })
    for (const wire of ['grok-4.7', 'other-model']) {
      const model = `${protocol}-${wire === 'grok-4.7' ? 'public-alias' : 'control'}`
      const catalog = await api('/api/models/catalog')
      await api('/api/models/catalog', { revision: catalog.revision, model: { id: model, enabled: true,
        bindings: [{ provider: channel.provider.id, model: wire }],
      } })
      for (const variant of ['absent', 'null', 'array']) {
        const schema = { type: 'object', properties: { name: { type: 'string' }, nested: { type: 'object', properties: {} },
          required: { type: 'string', default: 'literal property name' }, list: { type: 'array', items: { type: 'object', required: null } } },
          anyOf: [{ type: 'object', required: null }, { type: 'object', required: ['name'] }],
          default: { required: null }, examples: [{ required: null }], additionalProperties: false }
        if (variant !== 'absent') schema.required = variant === 'null' ? null : ['name']
        const response = await api('/v1/chat/completions', { model, stream: false,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          tools: [{ type: 'function', function: { name: 'get_status', parameters: schema } }],
        })
        assert.equal(response.choices[0].message.content, 'OK')
        const sent = calls.at(-1)
        const actual = sent.tools[0].function?.parameters ?? sent.tools[0].parameters ?? sent.tools[0].input_schema
        if (wire === 'grok-4.7') {
          assert.deepEqual(actual.required, variant === 'array' ? ['name'] : [])
          assert.deepEqual(actual.properties.nested.required, [])
          assert.deepEqual(actual.properties.list.items.required, [])
          assert.deepEqual(actual.anyOf.map(s => s.required), [[], ['name']])
          assert.deepEqual(actual.default, schema.default)
          assert.deepEqual(actual.examples, schema.examples)
          assert.deepEqual(actual.properties.required, schema.properties.required)
          assert.equal(actual.additionalProperties, false)
        } else assert.deepEqual(actual, schema, 'Other models keep their original schema')
        passed++
        console.log(`PASS ${protocol} ${wire} ${variant}`)
      }
    }
  }
  console.log(`PASS ${passed} Grok schema forwarding cases`)
} finally {
  child.kill()
  await exited
  await new Promise(resolve => upstream.close(resolve))
  await writeFile(path.join(temp, 'server.log'), logs)
  console.log(`Evidence: ${temp}`)
}
