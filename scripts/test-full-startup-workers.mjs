import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as wait } from 'node:timers/promises'
import { createFixturePanelSession } from './fixtures/panel-session.mjs'

// Catches startup sync exporting pre-migration data and duplicate scheduler
// recovery/dispatch. All requests, accounts, credentials and databases are fixtures.
const binary = resolve(process.argv[2])
const mode = process.argv.includes('--cloud-only') ? 'cloud'
  : process.argv.includes('--scheduler-only') ? 'scheduler' : 'all'
async function gateway(label) {
  const home = await mkdtemp(join(tmpdir(), 'full-startup-' + label + '-'))
  await writeFile(join(home, 'config.json'), JSON.stringify({
    scheduledTasks: { modelRefresh: { enabled: false }, credentialMaintenance: { enabled: false },
      updateCheck: { enabled: false }, magpiePluginCheck: { enabled: false } },
    pluginUpdates: { checkMode: 'custom', autoCheck: false, autoUpdate: false },
  }))
  const reservation = http.createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const key = randomUUID()
  const credentials = { username: 'startup-admin', password: randomUUID() + 'Aa!' }
  const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: home,
    AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: key,
    AGENT2API_ACCOUNT_KEY: '6'.repeat(64), AGENT2API_CAPTCHA_ENABLED: '0',
    AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_SYSTEMD_UPDATE: '0' }
  for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
  let child, ended, session, logs = ''
  async function start(login = false) {
    child = spawn(binary, [], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    ended = once(child, 'exit')
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', bytes => { logs += bytes })
    let ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      assert.equal(child.exitCode, null, 'startup fixture process exited')
      if ((await fetch(base + '/health').catch(() => null))?.ok) { ready = true; break }
      await wait(100)
    }
    assert.ok(ready, 'startup fixture must listen')
    session = await createFixturePanelSession(base, credentials, login ? 'login' : 'setup')
  }
  async function stop() {
    if (child?.exitCode === null) child.kill()
    if (ended) await ended
    child = null; ended = null
  }
  async function call(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + path, { method,
      headers: { 'x-panel-token': session.accessToken, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) })
    const value = await response.json()
    assert.equal(response.status, 200, path + ' must succeed')
    return value.data ?? value
  }
  function withDb(action) {
    const db = new DatabaseSync(join(home, 'agent2api.db'))
    try { return action(db) } finally { db.close() }
  }
  async function close() {
    await stop()
    if (process.env.KEEP_STARTUP_FIXTURE) {
      await writeFile(join(home, 'server.log'), logs)
      console.log('Startup fixture retained: ' + home)
    } else await rm(home, { recursive: true, force: true, maxRetries: 4 })
  }
  try { await start(); assert.equal((await call('/api/upgrade/run', {})).pending, false) }
  catch (error) { await close(); throw error }
  return { home, start, stop, close, call, withDb }
}

async function cloudMigration() {
  const files = new Map(), operations = []
  const dav = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const path = new URL(request.url, 'http://fixture').pathname
    operations.push({ method: request.method, path })
    if (request.method === 'PUT') {
      files.set(path, Buffer.concat(chunks)); response.writeHead(201).end()
    } else if (request.method === 'GET') {
      const file = files.get(path)
      if (file) response.writeHead(200).end(file)
      else response.writeHead(404).end()
    } else if (request.method === 'PROPFIND') {
      response.writeHead(207, { 'content-type': 'application/xml' })
      response.end('<d:multistatus xmlns:d="DAV:"/>')
    } else if (request.method === 'MKCOL') response.writeHead(201).end()
    else if (request.method === 'HEAD') response.writeHead(200).end()
    else if (request.method === 'DELETE') { files.delete(path); response.writeHead(204).end() }
    else response.writeHead(405).end()
  }).listen(0, '127.0.0.1')
  await once(dav, 'listening')
  let fixture
  try {
    fixture = await gateway('migration')
    await fixture.call('/api/cloud-sync', { provider: 'webdav', enabled: true, autoSync: false,
      webdavBaseUrl: `http://127.0.0.1:${dav.address().port}`, webdavUsername: 'fixture',
      webdavPassword: 'fixture', syncPassword: randomUUID(), autoSyncIntervalMinutes: 1,
      remoteRoot: 'startup-fixture', profile: 'default' }, 'PUT')
    await fixture.stop()
    fixture.withDb(db => {
      const saved = JSON.parse(db.prepare("SELECT value FROM kv WHERE key='cloudSync'").get().value)
      saved.autoSync = true
      db.prepare("UPDATE kv SET value=? WHERE key='cloudSync'").run(JSON.stringify(saved))
    })
    const legacyId = 'startup-legacy-' + randomUUID()
    await writeFile(join(fixture.home, 'accounts.json'), JSON.stringify({ accounts: [
      { id: legacyId, provider: 'workbuddy', name: 'Legacy fixture', enabled: false },
    ] }))
    operations.length = 0
    await fixture.start(true)
    assert.equal((await fixture.call('/api/upgrade')).pending, true)
    assert.equal(fixture.withDb(db => db.prepare('SELECT count(*) AS n FROM accounts').get().n), 0,
      'legacy account must remain outside SQLite until migration')
    // The worker's real debounce is one second. Observe past that deadline;
    // checking only immediately after health would miss the regression.
    await wait(6000)
    const writes = operations.filter(operation => operation.method === 'PUT')
    assert.equal(writes.length, 0, 'pending legacy migration must prevent automatic remote uploads')
    const waiting = await fixture.call('/api/cloud-sync')
    assert.equal(waiting.status.lastAttemptAt ?? null, null, 'pending migration must not start sync attempts')
    const upgraded = await fixture.call('/api/upgrade/run', {})
    assert.equal(upgraded.pending, false)
    assert.equal(upgraded.outcomes.find(item => item.label === '账号')?.imported, 1)
    let snapshot
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = files.get('/startup-fixture/v1/default/snapshot.json')
      if (snapshot && JSON.stringify(JSON.parse(snapshot)).includes(legacyId)) break
      await wait(100)
    }
    assert.ok(snapshot, 'migration completion must start automatic upload in the same process')
    assert.ok(JSON.stringify(JSON.parse(snapshot)).includes(legacyId), 'first automatic snapshot must include migrated legacy account')
    assert.ok(files.has('/startup-fixture/v1/default/manifest.json'), 'automatic upload must commit its manifest')
    console.log('PASS pending migration prevents automatic uploads; completing migration starts sync with retained legacy account')
  } finally {
    if (fixture) await fixture.close()
    await new Promise(resolve => dav.close(resolve))
  }
}

async function schedulerStartup() {
  const fixture = await gateway('scheduler')
  try {
    const plugin = (await fixture.call('/api/task-plugins', { id: 'startup-count', name: 'Startup count', enabled: true,
      scriptBody: 'async function onSchedule() { return { message: "scheduled once" }; }' })).plugin
    const job = (await fixture.call('/api/task-jobs', { pluginId: plugin.id, name: 'Startup count', enabled: true,
      cronExpression: '0 0 1 1 *', timezone: 'UTC', timeoutSeconds: 5 })).job
    await fixture.stop()
    fixture.withDb(db => {
      db.exec('CREATE TABLE startup_schedule_recovery (job_id TEXT NOT NULL)')
      // Recovery recomputes each enabled job once per startup. A future cron
      // makes timer dispatch impossible during this observation window.
      db.exec('CREATE TRIGGER startup_schedule_recovery_probe AFTER UPDATE OF next_run_at ON task_jobs '
        + 'BEGIN INSERT INTO startup_schedule_recovery(job_id) VALUES (NEW.id); END')
    })
    await fixture.start(true)
    const recovered = fixture.withDb(db => db.prepare('SELECT count(*) AS n FROM startup_schedule_recovery WHERE job_id=?').get(job.id).n)
    assert.equal(recovered, 1, 'one process startup must recover an enabled schedule exactly once')
    fixture.withDb(db => db.prepare('UPDATE task_jobs SET next_run_at=? WHERE id=?').run(Date.now(), job.id))
    let runs = []
    for (let attempt = 0; attempt < 100; attempt++) {
      runs = (await fixture.call(`/api/task-jobs/${job.id}/runs`)).runs
      if (runs.some(run => run.triggerType === 'schedule' && run.status === 'success')) break
      await wait(100)
    }
    assert.equal(runs.length, 1, 'a due job must dispatch once')
    assert.equal(runs[0].triggerType, 'schedule')
    assert.equal(runs[0].status, 'success')
    await wait(5300)
    assert.equal((await fixture.call(`/api/task-jobs/${job.id}/runs`)).runs.length, 1, 'next tick must not repeat the already scheduled job')
    console.log('PASS startup recovers each schedule once and dispatches one durable run without replay on next tick')
  } finally { await fixture.close() }
}

if (mode === 'all' || mode === 'cloud') await cloudMigration()
if (mode === 'all' || mode === 'scheduler') await schedulerStartup()
