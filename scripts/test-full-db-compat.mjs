import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as wait } from 'node:timers/promises'
import { createFixturePanelSession } from './fixtures/panel-session.mjs'

// Uses the real deployed fork binary to create schema29, source-owned upstream
// DDL to create schema36, and the candidate's real HTTP restore/upgrade paths.
// node scripts/test-full-db-compat.mjs <candidate> [<c500 binary>]
const candidate = resolve(process.argv[2])
const previous = resolve(process.argv[3] || 'F:/tmp/agent2api-delivery-verification-20261127/agent2api-server.exe')
const upstreamRef = '0bb8d3f35ccf785473db0ef246064b5b6b844ae0'
const sourcePrefix = 'desktop-tauri/src-tauri/server/src/server/db/'
const root = await mkdtemp(join(tmpdir(), 'full-db-compat-'))
const fixtures = []
const accountKey = Buffer.alloc(32, 0x88), destinationKey = Buffer.alloc(32, 0x99)
const sensitive = 'backup-private-' + randomUUID()
const gatewayKey = 'backup-gateway-' + randomUUID()
const publicModel = 'Backup-Preserved-Model'
const legacyId = 'backup-legacy-account'
let providerId, proxyId, jobId, retainedKey, deniedStatus
const upstream = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks))
  assert.equal(body.model, 'wire-backup')
  assert.equal(request.headers.authorization, 'Bearer upstream-' + sensitive)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end('data: {"choices":[{"index":0,"delta":{"content":"backup wire works"},"finish_reason":null}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'
    + 'data: [DONE]\n\n')
}).listen(0, '127.0.0.1')
await once(upstream, 'listening')
function seal(plain, key) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
  const bytes = Buffer.concat([cipher.update(plain), cipher.final()])
  return 'enc1:' + Buffer.concat([nonce, bytes, cipher.getAuthTag()]).toString('base64')
}
function open(envelope, key) {
  assert.ok(envelope.startsWith('enc1:'), 'stored secrets must remain envelopes')
  const bytes = Buffer.from(envelope.slice(5), 'base64')
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  cipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()])
}
function originalSource(file) { return execFileSync('git', ['show', upstreamRef + ':' + sourcePrefix + file], { encoding: 'utf8' }) }
function schemaObjects(db) { return db.prepare("SELECT type,name,coalesce(sql,'') AS sql FROM sqlite_schema ORDER BY type,name").all() }
function columns(db, table) { return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name) }
function kv(db, name) { const row = db.prepare('SELECT value FROM kv WHERE key=?').get(name); return row ? JSON.parse(row.value) : undefined }
async function fixture(label, key = accountKey) {
  const home = join(root, label); await mkdir(home)
  const scopeKeys = { 'cloud-sync.key': Buffer.alloc(32, key[0] - 1), 'task-plugins.key': Buffer.alloc(32, key[0] - 2) }
  for (const [name, value] of Object.entries(scopeKeys)) await writeFile(join(home, name), value)
  const reservation = http.createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
  const base = `http://127.0.0.1:${port}`, credentials = { username: 'backup-admin', password: randomUUID() + 'Aa!' }
  const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: home,
    AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: gatewayKey,
    AGENT2API_ACCOUNT_KEY: key.toString('hex'), AGENT2API_CAPTCHA_ENABLED: '0',
    AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_SYSTEMD_UPDATE: '0' }
  for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
  let child, ended, session, logs = ''
  async function start(binary, login = false, setup = true) {
    child = spawn(binary, [], { env, cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); ended = once(child, 'exit')
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', bytes => { logs += bytes })
    let ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      assert.equal(child.exitCode, null, label + ' process exited')
      if ((await fetch(base + '/health').catch(() => null))?.ok) { ready = true; break }
      await wait(100)
    }
    assert.ok(ready, label + ' must listen')
    if (setup) session = await createFixturePanelSession(base, credentials, login ? 'login' : 'setup')
  }
  async function stop() { if (child?.exitCode === null) child.kill(); if (ended) await ended; child = ended = null }
  function db(action) { const connection = new DatabaseSync(join(home, 'agent2api.db')); try { return action(connection) } finally { connection.close() } }
  async function request(path, body, method = body === undefined ? 'GET' : 'POST', auth) {
    return fetch(base + path, { method, headers: { ...(auth || { 'x-panel-token': session.accessToken }), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) })
  }
  async function call(path, body, method, auth) {
    const response = await request(path, body, method, auth), value = await response.json()
    assert.equal(response.status, 200, path + ': ' + JSON.stringify(value))
    return value.data ?? value
  }
  async function login(restoredCredentials = credentials) { session = await createFixturePanelSession(base, restoredCredentials, 'login') }
  const result = { home, key, scopeKeys, credentials, start, stop, db, request, call, login,
    async evidence() { await writeFile(join(home, 'server.log'), logs) } }
  fixtures.push(result); return result
}
const disabledTasks = { scheduledTasks: { modelRefresh: { enabled: false }, credentialMaintenance: { enabled: false },
  updateCheck: { enabled: false }, magpiePluginCheck: { enabled: false } }, pluginUpdates: { checkMode: 'custom', autoCheck: false, autoUpdate: false } }
async function wire(f) {
  const response = await f.request('/v1/chat/completions', { model: publicModel, messages: [{ role: 'user', content: 'ordinary request' }] }, 'POST', { authorization: 'Bearer ' + retainedKey })
  assert.equal(response.status, 200, 'restored Key and route must still forward')
  assert.ok((await response.text()).includes('backup wire works'))
  const denied = await f.request('/v1/chat/completions', { model: 'ungranted-model', messages: [] }, 'POST', { authorization: 'Bearer ' + retainedKey })
  if (deniedStatus === undefined) { assert.ok([403, 404].includes(denied.status), 'scoped Key must reject the enabled ungranted model'); deniedStatus = denied.status }
  assert.equal(denied.status, deniedStatus, 'restore must retain Key model restrictions and denial status')
}
function important(f) {
  return f.db(db => ({ account: open(db.prepare('SELECT data FROM accounts WHERE id=?').get(legacyId).data, f.key).toString(),
    keys: kv(db, 'apiKeys'), provider: kv(db, 'customProviders'), cloud: kv(db, 'cloudSync'),
    privacy: kv(db, 'privacyRedaction'), routes: kv(db, 'routeGroups'),
    proxy: db.prepare('SELECT data FROM accounts WHERE id=?').get(legacyId).data,
    task: db.prepare('SELECT secrets_enc,storage_enc FROM task_jobs WHERE id=?').get(jobId) }))
}
async function verifyBusiness(f, original, restored) {
  const current = important(f)
  assert.equal(current.account, original.account, 'legacy account and proxy credential JSON must survive')
  const keys = current.keys.map(item => ({ ...item, key: open(item.key, f.key).toString() }))
  const expectedKeys = original.keys.map(item => ({ ...item, key: open(item.key, accountKey).toString() }))
  assert.deepEqual(keys, expectedKeys, 'Key bytes, permissions and metadata must survive')
  assert.deepEqual((await f.call('/api/proxies/pool')).items.find(item => item.id === proxyId).name, 'Backup proxy')
  assert.ok((await f.call('/api/routing/groups')).groups.some(row => row.group.model === publicModel))
  assert.equal(open(current.cloud.syncPassword, f.scopeKeys['cloud-sync.key']).toString(), sensitive + '-cloud')
  assert.equal(open(current.cloud.webdav.password, f.scopeKeys['cloud-sync.key']).toString(), sensitive + '-dav')
  assert.equal(current.cloud.enabled, false)
  assert.equal(current.cloud.autoSync, false)
  const privacy = JSON.parse(open(current.privacy.rulesEnc, f.key))
  assert.deepEqual(privacy.words, [sensitive])
  for (const field of ['secrets_enc', 'storage_enc']) {
    const envelope = current.task[field]
    let plain
    for (const key of [f.scopeKeys['task-plugins.key'], f.key]) { try { plain = JSON.parse(open(envelope, key)); break } catch {} }
    assert.ok(plain, 'task field must decrypt under retained local key')
    assert.equal(plain[field === 'secrets_enc' ? 'fixture' : 'retained'], sensitive)
  }
  if (restored) {
    const task = (await f.call('/api/task-jobs')).jobs.find(row => row.id === jobId)
    assert.equal(task.enabled, false); assert.equal(task.nextRunAt, null)
    const plugin = (await f.call('/api/task-plugins')).plugins.find(row => row.id === 'backup-task')
    assert.equal(plugin.enabled, false); assert.equal(plugin.notifyAllowed, false)
  }
  await wire(f)
}
async function realForkUpgradeAndBackups() {
  const source = await fixture('fork29')
  await writeFile(join(source.home, 'config.json'), JSON.stringify(disabledTasks))
  await writeFile(join(source.home, 'accounts.json'), JSON.stringify({ accounts: [
    { id: legacyId, provider: 'workbuddy', name: 'Retained legacy', enabled: false, accessToken: sensitive,
      unknownFuture: { keep: true } },
  ] }))
  await source.start(previous)
  assert.equal(source.db(db => db.prepare('PRAGMA user_version').get().user_version), 29, 'fixture must originate from actual schema29 binary')
  assert.equal((await source.call('/api/upgrade/run', {})).pending, false)
  await source.call('/api/accounts/' + legacyId, { proxy: { source: 'custom', protocol: 'http', host: '127.0.0.1', port: 8099,
    username: 'backup-user', password: sensitive + '-proxy' } }, 'PATCH')
  proxyId = (await source.call('/api/proxies/pool', { name: 'Backup proxy', protocol: 'http', host: '127.0.0.1', port: 8088, enabled: false })).items.find(item => item.name === 'Backup proxy').id
  const channel = await source.call('/api/custom-providers', { name: 'Backup source', protocol: 'chat_completions',
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'wire', enabled: true, apiKeys: ['upstream-' + sensitive], models: ['wire-backup'] }] })
  providerId = channel.provider.id
  const catalog = await source.call('/api/routing/groups')
  await source.call('/api/routing/groups', { revision: catalog.newRevision, id: publicModel,
    group: { id: publicModel, model: publicModel, name: publicModel, enabled: true, strategy: 'order', sticky: 'off',
      members: [{ id: 'wire', provider: providerId, model: 'wire-backup', included: true, accountScope: 'all', accounts: [] }] } }, 'PUT')
  const nextCatalog = await source.call('/api/routing/groups')
  await source.call('/api/routing/groups', { revision: nextCatalog.newRevision, id: 'ungranted-model',
    group: { id: 'ungranted-model', model: 'ungranted-model', name: 'Ungrantable fixture', enabled: true, strategy: 'order', sticky: 'off',
      members: [{ id: 'wire', provider: providerId, model: 'wire-backup', included: true, accountScope: 'all', accounts: [] }] } }, 'PUT')
  const accessible = await source.request('/v1/chat/completions', { model: 'ungranted-model', messages: [{ role: 'user', content: 'ordinary request' }] }, 'POST', { 'x-api-key': gatewayKey })
  assert.equal(accessible.status, 200, 'ungranted fixture model must be enabled and available to administrator')
  await accessible.text()
  retainedKey = (await source.call('/api/keys', { name: 'Backup scoped Key', allowedModels: [publicModel], allowedProviders: [providerId] })).created.key
  await source.call('/api/cloud-sync', { provider: 'webdav', enabled: false, autoSync: false, webdavBaseUrl: 'http://127.0.0.1:1',
    webdavUsername: 'fixture', webdavPassword: sensitive + '-dav', syncPassword: sensitive + '-cloud', remoteRoot: 'retained', profile: 'default' }, 'PUT')
  await source.call('/api/privacy', { enabled: true, words: [sensitive] }, 'PUT')
  await source.call('/api/task-plugins', { id: 'backup-task', name: 'Retained task', enabled: true,
    fields: [{ key: 'fixture', label: 'Fixture', type: 'password' }],
    scriptBody: 'async function onSchedule(ctx) { await ctx.storage.set("retained", ctx.form.fixture); return { message: "retained" }; }' })
  jobId = (await source.call('/api/task-jobs', { pluginId: 'backup-task', name: 'Retained task', enabled: false,
    cronExpression: '0 0 1 1 *', timezone: 'UTC', values: { fixture: sensitive } })).job.id
  await source.call('/api/task-plugins/backup-task/permissions', { enabled: true })
  assert.equal((await source.call('/api/task-jobs/' + jobId + '/run', {})).outcome.success, true)
  await wire(source)
  source.db(db => {
    db.prepare('INSERT INTO requests(id,ts,model,status,credit,cost_usd,pricing_evidence) VALUES (?,?,?,?,?,?,?)')
      .run('backup-retained-request', Date.now(), publicModel, 200, 7.25, 0.125, JSON.stringify({ retained: true }))
    db.prepare('INSERT INTO request_raw(id,ts,request_body) VALUES (?,?,?)').run('backup-retained-raw', Date.now(), 'ordinary fixture raw')
  })
  const original = important(source), oldSchemas = source.db(schemaObjects)
  const oldArchive = join(root, 'schema29.a2ab'), password = randomUUID()
  await source.call('/api/backup/export', { filePath: oldArchive, password, includeLogs: true })
  await source.stop()
  const collision = await fixture('fork-conflict')
  source.db(db => db.exec("VACUUM INTO '" + join(collision.home, 'agent2api.db').replaceAll("'", "''") + "'"))
  collision.db(db => { db.exec("CREATE TABLE coding_submissions(original TEXT); INSERT INTO coding_submissions VALUES ('keep'); PRAGMA user_version=36") })
  const collisionBefore = collision.db(db => ({ objects: schemaObjects(db), rows: db.prepare('SELECT * FROM accounts').all(),
    config: db.prepare('SELECT * FROM kv ORDER BY key').all() }))
  await collision.start(candidate, false, false)
  await collision.stop()
  assert.deepEqual(collision.db(db => ({ objects: schemaObjects(db), rows: db.prepare('SELECT * FROM accounts').all(),
    config: db.prepare('SELECT * FROM kv ORDER BY key').all() })), collisionBefore)
  assert.equal(collision.db(db => db.prepare('PRAGMA user_version').get().user_version), 36)
  console.log('PASS real fork schema conflict rejects upgrade without changing schema or retained encrypted accounts')
  await source.start(candidate, true)
  assert.equal(source.db(db => db.prepare('PRAGMA user_version').get().user_version), 37)
  await verifyBusiness(source, original, false)
  const unified = source.db(schemaObjects)
  const newTables = unified.filter(row => row.type === 'table' && !oldSchemas.some(old => old.name === row.name)).map(row => row.name)
  console.log('PASS actual fork29 -> unified37 retains encrypted accounts, scoped Keys, proxies, models, cloud and task/privacy secrets; added tables:', newTables.join(', '))
  await source.stop(); await source.start(candidate, true)
  assert.deepEqual(source.db(schemaObjects), unified, 'second schema upgrade must be a no-op')
  const archives = [['legacy-full', oldArchive, true]]
  for (const includeLogs of [true, false]) {
    const filePath = join(root, includeLogs ? 'full.a2ab' : 'slim.a2ab')
    await source.call('/api/backup/export', { filePath, password, includeLogs })
    assert.ok(!(await readFile(filePath)).includes(Buffer.from(sensitive)), 'archive must be encrypted')
    archives.push([includeLogs ? 'full' : 'slim', filePath, includeLogs])
  }
  for (const [label, filePath, includeLogs] of archives) {
    const target = await fixture('restore-' + label, destinationKey)
    await writeFile(join(target.home, 'config.json'), JSON.stringify(disabledTasks))
    await target.start(candidate); await target.call('/api/upgrade/run', {})
    const localKeys = await Promise.all(Object.keys(target.scopeKeys).map(name => readFile(join(target.home, name))))
    await target.call('/api/backup/import', { filePath, password }); await target.login(source.credentials)
    assert.deepEqual(await Promise.all(Object.keys(target.scopeKeys).map(name => readFile(join(target.home, name)))), localKeys,
      'restore must preserve destination key files')
    await verifyBusiness(target, original, true)
    target.db(db => {
      assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE id='backup-retained-request'").get().n, includeLogs ? 1 : 0)
      assert.equal(db.prepare("SELECT count(*) AS n FROM request_raw WHERE id='backup-retained-raw'").get().n, includeLogs ? 1 : 0)
      if (includeLogs) assert.equal(db.prepare("SELECT credit FROM requests WHERE id='backup-retained-request'").get().credit, 7.25)
      else assert.equal(db.prepare('SELECT count(*) AS n FROM task_job_runs').get().n, 0)
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    })
    console.log('PASS', label, 'cross-key real archive restore, permissions, decryptable business fields, expected history policy and integrity')
  }
}
async function actualUpstreamSchema() {
  const f = await fixture('upstream36')
  const source = originalSource('schema.rs')
  f.db(db => {
    const constant = version => {
      if (version === 4) return constant(3)
      const found = new RegExp('const V' + version + '_SCHEMA: &str = "([\\s\\S]*?)";').exec(source)
      assert.ok(found, 'read original upstream SQL constant ' + version)
      return found[1].replaceAll('\\"', '"').replaceAll('\\n', '\n')
    }
    for (let version = 1; version <= 24; version++) {
      if ([14, 22].includes(version)) continue
      if (version === 13) { db.exec(constant(3)); continue }
      const includes = { 18: 'schema_source_stats.sql', 19: 'schema_assistant_images.sql', 20: 'schema_debug_raw.sql',
        21: 'schema_assistant_title.sql', 24: 'schema_client_identification.sql' }
      db.exec(includes[version] ? originalSource(includes[version]) : constant(version))
    }
    for (const file of ['schema_tool_images.sql', 'schema_maintenance.sql', 'schema_coding.sql', 'schema_model_recency.sql',
      'schema_usage_query.sql', 'schema_usage_diagnostics.sql', 'schema_checkin_records_index.sql', 'schema_model_pricing.sql',
      'schema_task_plugins.sql', 'schema_privacy_redaction.sql', 'schema_local_direct.sql']) db.exec(originalSource(file))
    db.exec('PRAGMA user_version=36')
    db.prepare('INSERT INTO accounts(id,provider,priority,enabled,added_at,data) VALUES (?,?,?,?,?,?)')
      .run('upstream-kept', 'workbuddy', 0, 0, 0, seal(JSON.stringify({ id: 'upstream-kept', provider: 'workbuddy', accessToken: sensitive }), accountKey))
    for (const [name, value] of Object.entries(disabledTasks)) db.prepare('INSERT INTO kv(key,value) VALUES (?,?)').run(name, JSON.stringify(value))
  })
  const original = f.db(db => ({ account: db.prepare("SELECT data FROM accounts WHERE id='upstream-kept'").get().data,
    columns: columns(db, 'task_plugins') }))
  assert.ok(!original.columns.includes('network_grants_json'), 'source must be actual upstream schema, not unified test-builder DDL')
  await f.start(candidate)
  f.db(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 37)
    assert.equal(db.prepare("SELECT data FROM accounts WHERE id='upstream-kept'").get().data, original.account)
    for (const column of ['pricing_evidence', 'cache_creation_tokens', 'privacy_hits']) assert.ok(columns(db, 'requests').includes(column))
    assert.ok(columns(db, 'task_plugins').includes('network_grants_json'))
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  })
  console.log('PASS actual fixed-upstream36 SQL layout -> unified37 preserves ciphertext and adds fork fields')
}
try { await actualUpstreamSchema(); await realForkUpgradeAndBackups() }
finally {
  for (const f of fixtures) { await f.stop(); if (process.env.KEEP_DB_COMPAT_FIXTURE) await f.evidence() }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  if (process.env.KEEP_DB_COMPAT_FIXTURE) console.log('DB compatibility fixture retained: ' + root)
  else await rm(root, { recursive: true, force: true, maxRetries: 4 })
}
