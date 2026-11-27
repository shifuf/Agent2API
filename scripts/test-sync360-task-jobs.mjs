import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pluginGateway } from './fixtures/plugin-gateway.mjs'

const gateway = await pluginGateway(process.argv[2], 'full-task-jobs')
const { call, home } = gateway
const plugins = '/api/task-plugins', jobs = '/api/task-jobs'
const marker = 'private-task-' + randomUUID()
const signals = []
const sink = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  signals.push(JSON.parse(Buffer.concat(chunks).toString()))
  response.writeHead(200).end()
}).listen(0, '127.0.0.1')
await once(sink, 'listening')
try {
  const initial = await call(plugins)
  assert.deepEqual(initial.plugins, [])
  assert.ok(Array.isArray(initial.store))
  const key = (await call('/api/keys', 'POST', { name: 'task fixture' })).created.key
  await call(plugins, 'GET', undefined, 403, { 'x-api-key': key })
  const scriptBody = `async function onSchedule(ctx) {
    if (typeof fetch !== 'function' || [typeof process, typeof require, typeof Bun].some(kind => kind !== 'undefined')) throw Error('sandbox globals');
    if (ctx.crypto.sha256('abc') !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') throw Error('crypto');
    const previous = await ctx.storage.get('private');
    if (previous && previous !== ctx.form.fixture) throw Error('storage isolation');
    if (ctx.form.fixture) await ctx.storage.set('private', ctx.form.fixture);
    if (ctx.form.sleep) await ctx.sleep(8000);
    return { message: 'task complete', status: { count: '21' } };
  }
  async function onAction(action, ctx) {
    if (action !== 'verify' || !await ctx.storage.get('private')) throw Error('action context');
    return { message: 'action complete', qrText: 'https://example.org/fixture', status: { count: '22' } };
  }`
  const plugin = { id: 'local-count', name: 'Local count', enabled: false, notifyAllowed: false,
    declaresNotify: true, fields: [{ key: 'fixture', label: 'Fixture', type: 'password' }, { key: 'sleep', label: 'Sleep', type: 'switch' }],
    actions: [{ id: 'verify', label: 'Verify' }], statusFields: [{ key: 'count', label: 'Count' }], scriptBody }
  const installed = (await call(plugins, 'POST', plugin)).plugin
  assert.equal(installed.enabled, false); assert.equal(installed.notifyAllowed, false); assert.equal(installed.signed, false)
  const preview = (await call(plugins + '/preview', 'POST', { plugin })).outcome
  assert.equal(preview.success, true); assert.equal(preview.statusPatch.count, '21')
  for (const body of ['async function onSchedule(ctx) { await ctx.sleep(4000) }', 'function onSchedule() { while (true) {} }', 'function onSchedule() { new Uint8Array(48 * 1024 * 1024) }']) {
    const limited = (await call(plugins + '/preview', 'POST', { plugin: { ...plugin, defaultTimeout: 1, scriptBody: body } })).outcome
    assert.equal(limited.success, false); assert.ok(limited.durationMs < 3000)
  }
  for (const domains of [[], ['*'], ['*.example.org'], ['example.org']]) {
    const blocked = (await call(plugins + '/preview', 'POST', { plugin: { ...plugin, domains,
      scriptBody: 'async function onSchedule(ctx) { await fetch("http://127.0.0.1/forbidden") }' } })).outcome
    assert.equal(blocked.success, false, 'declarations never authorize private addresses')
  }
  const times = (await call(jobs + '/cron-preview', 'POST', { cronExpression: '15 2 * * *', timezone: 'Asia/Shanghai' })).nextRuns
  assert.equal(times.length, 3); assert.equal(new Date(times[0]).getUTCHours(), 18); assert.equal(new Date(times[0]).getUTCMinutes(), 15)
  const form = { pluginId: plugin.id, name: 'Count 1', enabled: false, cronExpression: '15 2 * * *', timezone: 'Asia/Shanghai', timeoutSeconds: 20 }
  const first = (await call(jobs, 'POST', { ...form, values: { fixture: marker } })).job
  const second = (await call(jobs, 'POST', { ...form, name: 'Count 2' })).job
  assert.notEqual(first.id, second.id)
  assert.ok(!JSON.stringify(first).includes(marker)); assert.equal(first.savedSecrets.fixture, true)
  await call(`${jobs}/${first.id}/run`, 'POST', {}, 400)
  await call(`${plugins}/${plugin.id}/permissions`, 'POST', { enabled: true })
  assert.equal((await call(`${jobs}/${first.id}/run`, 'POST', {})).outcome.success, true)
  assert.equal((await call(`${jobs}/${second.id}/run`, 'POST', {})).outcome.success, true)
  const action = (await call(`${jobs}/${first.id}/action`, 'POST', { actionId: 'verify' })).outcome
  assert.equal(action.success, true); assert.equal(action.statusPatch.count, '22'); assert.match(action.qrImageDataUrl, /^data:image\/svg\+xml/)
  const exported = await call(`${plugins}/${plugin.id}/export`)
  assert.ok(exported.content.includes('@agent2api-task-plugin')); assert.ok(!exported.content.includes(marker))
  const notifyScript = 'async function onSchedule(ctx) { const result = await ctx.notify.send("Fixture", "Public task notification"); return { message: result.sent ? "sent" : result.reason }; }'
  await call(`${plugins}/${plugin.id}`, 'PUT', { ...plugin, enabled: true, scriptBody: notifyScript })
  await call('/api/notifications', 'PUT', { enabled: true, channels: { webhook: { enabled: true, url: `http://127.0.0.1:${sink.address().port}/signal` } } })
  const run = () => call(`${jobs}/${first.id}/run`, 'POST', {})
  assert.equal((await run()).outcome.message, 'disabled_by_user')
  await call(`${plugins}/${plugin.id}/permissions`, 'POST', { notifyAllowed: true })
  assert.equal((await run()).outcome.message, 'sent')
  assert.equal(signals.length, 1); assert.equal(signals[0].event, 'task_plugin')
  await call(`${plugins}/${plugin.id}`, 'PUT', { ...plugin, enabled: true })
  await call(`${jobs}/${second.id}`, 'PUT', { ...form, name: 'Count 2', enabled: true })
  const entries = await readdir(home, { recursive: true, withFileTypes: true })
  const database = entries.find(entry => entry.isFile() && entry.name === 'agent2api.db')
  assert.ok(database)
  const db = new DatabaseSync(path.join(database.parentPath, database.name))
  try { db.prepare('UPDATE task_jobs SET next_run_at=? WHERE id=?').run(Date.now(), second.id) } finally { db.close() }
  let scheduled
  for (let attempt = 0; attempt < 70; attempt++) {
    scheduled = (await call(`${jobs}/${second.id}/runs`)).runs
    if (scheduled[0]?.triggerType === 'schedule' && scheduled[0].status === 'success') break
    await delay(150)
  }
  assert.equal(scheduled[0]?.triggerType, 'schedule'); assert.equal(scheduled[0].status, 'success')
  await call(`${jobs}/${second.id}`, 'PUT', { ...form, name: 'Count 2', enabled: false })
  await call(`${jobs}/${first.id}`, 'PUT', { ...form, values: { sleep: true } })
  const running = async () => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await call(jobs)).jobs.find(job => job.id === first.id).lastStatus === 'running') return
      await delay(40)
    }
    assert.fail('task did not enter running state')
  }
  const backup = { filePath: path.join(home, 'fixture.a2ab'), password: randomUUID() + '!Aa', includeLogs: true }
  const pending = run(); await running()
  await call('/api/backup/export', 'POST', backup)
  await call(`${jobs}/${first.id}/run`, 'POST', {}, 400)
  await call('/api/backup/import', 'POST', backup, 500)
  await call(`${jobs}/${first.id}/stop`, 'POST', {})
  assert.equal((await pending).outcome.success, false)
  const interrupted = run().catch(() => null); await running(); await gateway.restart(); await interrupted
  assert.equal((await call(`${jobs}/${first.id}/runs`)).runs[0].status, 'failed')
  await call('/api/backup/import', 'POST', backup)
  await gateway.restart()
  const restored = (await call(plugins)).plugins.find(item => item.id === plugin.id)
  assert.equal(restored.enabled, false); assert.equal(restored.notifyAllowed, false)
  const restoredJob = (await call(jobs)).jobs.find(job => job.id === first.id)
  assert.equal(restoredJob.enabled, false); assert.equal(restoredJob.nextRunAt, null)
  assert.equal(restoredJob.lastStatus, 'failed')
  await call(`${jobs}/${first.id}`, 'PUT', { ...form, values: { sleep: false } })
  await call(`${plugins}/${plugin.id}/permissions`, 'POST', { enabled: true })
  assert.equal((await run()).outcome.success, true, 'restored form and storage decrypt under the active key')
  for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assert.ok(!(await readFile(path.join(entry.parentPath, entry.name))).includes(marker), 'no plaintext secret in stored files')
  }
  console.log('PASS full QuickJS async helpers, resource bounds, domain/private-address guard, instance isolation, actions/QR, notifications, cron, encrypted restore, mutex, stop and restart')
} finally {
  await gateway.stop()
  await new Promise(resolve => { sink.close(resolve); sink.closeAllConnections() })
}
