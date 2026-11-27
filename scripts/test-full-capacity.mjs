// Real admission, queue, cancellation and release on the normal route-group gateway.
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { pluginGateway } from './fixtures/plugin-gateway.mjs'

const calls = []
const upstream = http.createServer(async (request, response) => {
  const parts = []
  for await (const chunk of request) parts.push(chunk)
  const body = JSON.parse(Buffer.concat(parts).toString())
  const text = body.messages.at(-1).content
  calls.push(text)
  const reply = () => response.end(body.stream
    ? `data: ${JSON.stringify({ id: text, model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    : JSON.stringify({ id: text, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }))
  response.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json')
  if (text === 'held') upstream.release = reply
  else reply()
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
let gateway
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) { if (await check()) return; await delay(50) }
  assert.fail('expected actual capacity state was not reached')
}
try {
  gateway = await pluginGateway(process.argv[2], 'capacity-acceptance')
  const { call, base, adminKey } = gateway
  const channel = await call('/api/custom-providers', 'POST', { name: 'Capacity source', protocol: 'chat_completions',
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', apiKeys: ['capacity-source'], models: ['wire-capacity'], enabled: true }] })
  const groups = await call('/api/routing/groups')
  await call('/api/routing/groups', 'PUT', { id: 'capacity', revision: groups.newRevision,
    group: { id: 'capacity', name: 'Capacity', model: 'Public-Capacity', kind: 'chat', enabled: true, strategy: 'order', sticky: 'off',
      members: [{ id: 'main', provider: channel.provider.id, model: 'wire-capacity', included: true, accountScope: 'all', accounts: [] }] } })
  const original = await call('/api/plugins/capacity')
  const settings = { ...original.settings, mode: 'manual', maxConversations: 1, queueWaitSeconds: 1, queueRequests: 4 }
  const saved = await call('/api/plugins/capacity', 'PATCH', { settings, revision: original.revision })
  assert.equal(saved.effective.conversations, 1)
  await call('/api/plugins/capacity', 'PATCH', { settings, revision: original.revision }, 409)
  const send = (text, signal) => fetch(base + '/v1/chat/completions', { method: 'POST', signal,
    headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'Public-Capacity', stream: false, messages: [{ role: 'user', content: text }] }) })
  const held = send('held')
  await until(() => calls.includes('held'))
  assert.equal((await call('/api/plugins/capacity')).usage.requests, 1)
  const rejected = await send('queued-timeout')
  assert.equal(rejected.status, 503)
  assert.equal((await rejected.json()).error.code, 'gateway_busy')
  assert.deepEqual(calls, ['held'], 'queued timeout must not submit upstream')
  console.log('PASS normal group request holds admission through aggregation and queued timeout submits nothing')
  const cancel = new AbortController()
  const cancelled = send('queued-cancel', cancel.signal).then(() => null, error => error)
  await until(async () => (await call('/api/plugins/capacity')).usage.queued > 0)
  cancel.abort()
  assert.equal((await cancelled).name, 'AbortError')
  await until(async () => (await call('/api/plugins/capacity')).usage.queued === 0)
  assert.deepEqual(calls, ['held'])
  upstream.release()
  assert.equal((await held).status, 200)
  await until(async () => (await call('/api/plugins/capacity')).usage.requests === 0)
  const next = await send('next')
  assert.equal(next.status, 200)
  assert.equal((await next.json()).choices[0].message.content, 'next')
  assert.deepEqual(calls, ['held', 'next'])
  console.log('PASS cancelled queued request releases queue and completed response releases admission for the next request')
  await gateway.restart()
  assert.equal((await call('/api/plugins/capacity')).settings.maxConversations, 1)
  console.log('PASS capacity configuration persists across actual server restart')
} finally {
  upstream.release?.()
  await gateway?.stop()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
}
