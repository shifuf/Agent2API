import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { createFixturePanelSession, installFixturePanelSession } from './fixtures/panel-session.mjs'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'
import { verifyProbeGrants, verifyRestoredProbe, verifyProbePanel, verifyNoDisabledReplay } from './fixtures/task-probes.mjs'

assert.ok(process.argv[2], 'pass the candidate server executable')
const home = await mkdtemp(path.join(os.tmpdir(), 'agent2api-task-jobs-'))
const reserve = http.createServer().listen(0, '127.0.0.1')
await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))
const base = `http://127.0.0.1:${port}`
const marker = 'private-task-fixture-' + randomUUID()
const signals = []
const sink = http.createServer(async (req,res) => { const chunks=[]; for await (const chunk of req) chunks.push(chunk); signals.push(Buffer.concat(chunks).toString()); res.writeHead(200).end() }).listen(0,'127.0.0.1')
await once(sink,'listening')
const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: home, AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: randomUUID(), AGENT2API_ACCOUNT_KEY: '8'.repeat(64), AGENT2API_SELF_UPDATE: '0', AGENT2API_CAPTCHA_ENABLED: '0' }
for (const key of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[key]
env.AGENT2API_UI_DIR = path.resolve(import.meta.dirname,'../desktop-tauri/ui')
const start = () => spawn(path.resolve(process.argv[2]), [], { cwd: home, env, windowsHide: true, stdio: 'ignore' })
let app = start(), done = once(app,'exit')
const credentials = { username: 'operator', password: randomUUID() + '!Aa' }
async function ready() {
  for (let attempt=0; ; attempt++) {
    assert.ok(attempt < 120 && app.exitCode === null, 'fixture unavailable')
    try { if ((await fetch(base+'/health')).ok) return } catch {}
    await delay(200)
  }
}
try {
  await ready()
  let session = await createFixturePanelSession(base, credentials)
  const headers = { 'x-panel-token': session.accessToken }
  async function call(endpoint, method = 'GET', body, status = 200, auth = headers) {
    const res = await fetch(base + endpoint, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    assert.equal(res.status, status, `${method} ${endpoint}`)
    const raw = await res.text(); assert.ok(!raw.includes(marker),'no secrets in API responses')
    const value = JSON.parse(raw)
    return value.data ?? value
  }
  const plugins = '/api/task-plugins', jobs = '/api/task-jobs'
  assert.deepEqual((await call(plugins)).plugins, [])
  await verifyProbeGrants(call)
  if (!process.argv.includes('--without-store')) {
    assert.deepEqual((await call(plugins+'/store')).items, [],'opening the store does not trigger network requests')
    await call(plugins+'/install-store','POST',{id:'missing-catalog-entry',url:'http://127.0.0.1/ignored'},400)
    await call('/api/update/proxy','POST',{proxy:{source:'pool',proxyId:'missing-test-set'}})
    const unavailable=await call(plugins+'/store/refresh','POST',{},400)
    assert.match(JSON.stringify(unavailable),/更新代理不可用/)
    const tunnels=[]
    const proxy=http.createServer().on('connect',(req,socket)=>{tunnels.push(req.url);socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')}).listen(0,'127.0.0.1')
    await once(proxy,'listening')
    try {
      await call('/api/update/proxy','POST',{proxy:{source:'custom',protocol:'http',host:'127.0.0.1',port:proxy.address().port}})
      const disconnected=await call(plugins+'/store/refresh','POST',{},400)
      assert.match(JSON.stringify(disconnected),/下载连接失败/)
      assert.ok(tunnels.includes('cdn.agent2api.dev:443'),'selected proxy sees the catalog request')
    } finally { await new Promise(resolve=>proxy.close(resolve)); await call('/api/update/proxy','POST',{proxy:null}) }
  }
  const key = (await call('/api/keys', 'POST', { name: 'task fixture' })).created.key
  await call(plugins, 'GET', undefined, 403, { 'x-api-key': key })
  if (!process.argv.includes('--without-store')) {
    for (const op of ['/store/refresh','/install-store']) await call(plugins+op,'POST',{},403,{'x-api-key':key})
  }
  const plugin = { id: 'local-count', name: 'Local count', declaresNotify: true, notifyAllowed: true, scriptBody: 'async function onSchedule(ctx) { if (3 * 7 !== 21 || [typeof fetch, typeof process, typeof require, typeof Bun].some(kind => kind !== "undefined")) throw Error(); return 21; }' }
  const imported = (await call(plugins, 'POST', plugin)).plugin
  assert.equal(imported.notifyAllowed, false, 'import does not authorize delivery')
  assert.equal(imported.enabled, false, 'import never starts a task')
  assert.equal(imported.signed, false)
  const preview = (await call(plugins + '/preview', 'POST', { plugin })).outcome
  assert.equal(preview.success, true, 'local script executes isolated in QuickJS')
  for (const scriptBody of ['async function onSchedule(ctx) { await ctx.sleep(4000); }','function onSchedule() { while (true) {} }','function onSchedule() { new Uint8Array(48 * 1024 * 1024); }']) {
    const limited = (await call(plugins + '/preview','POST',{plugin:{...plugin,defaultTimeout:1,scriptBody}})).outcome
    assert.equal(limited.success,false); assert.ok(limited.durationMs<2500,'resource limits are bounded')
  }
  const denied = { ...plugin, scriptBody: 'async function onSchedule(ctx) { await ctx.notify.send("preview", "must not send"); }' }
  assert.equal((await call(plugins + '/preview', 'POST', { plugin: denied })).outcome.success, false)
  const times = (await call(jobs + '/cron-preview', 'POST', { cronExpression: '15 2 * * *', timezone: 'Asia/Shanghai' })).nextRuns
  assert.equal(times.length, 3)
  assert.equal(new Date(times[0]).getUTCHours(), 18)
  assert.equal(new Date(times[0]).getUTCMinutes(), 15)
  const form = { pluginId: plugin.id, name: 'Count 1', enabled: false, cronExpression: '15 2 * * *', timezone: 'Asia/Shanghai', timeoutSeconds: 20 }
  const first = (await call(jobs, 'POST', form)).job
  const second = (await call(jobs, 'POST', { ...form, name: 'Count 2' })).job
  assert.notEqual(first.id, second.id)
  await call(`${jobs}/${first.id}/run`, 'POST', {}, 400)
  await call(`${plugins}/${plugin.id}/permissions`, 'POST', { enabled: true })
  assert.equal((await call(`${jobs}/${first.id}/run`, 'POST', {})).outcome.success, true)
  assert.equal((await call(`${jobs}/${first.id}/runs`)).runs.length, 1)
  assert.equal((await call(`${jobs}/${second.id}/runs`)).runs.length, 0)
  await call(`${jobs}/${second.id}`,'PUT',{enabled:true})
  const file=(await readdir(home,{withFileTypes:true,recursive:true})).find(entry=>entry.isFile() && entry.name==='agent2api.db'); assert.ok(file)
  const db=new DatabaseSync(path.join(file.parentPath,file.name))
  try { await verifyNoDisabledReplay(call,db); db.prepare('UPDATE task_jobs SET next_run_at=? WHERE id=?').run(Date.now(),second.id) } finally {db.close()}
  let schedule
  for (let attempt=0;attempt<60;attempt++) { schedule=(await call(`${jobs}/${second.id}/runs`)).runs; if (schedule[0]?.status==='success') break; await delay(150) }
  assert.equal(schedule.length,1); assert.equal(schedule[0].triggerType,'schedule')
  assert.equal(schedule[0].status,'success'); await call(`${jobs}/${second.id}`,'PUT',{enabled:false})
  const configure = (enabled) => call('/api/notifications','PUT',{enabled,channels:{webhook:{enabled:true,url:`http://127.0.0.1:${sink.address().port}/signal`}}})
  const update = (scriptBody) => call(`${plugins}/${plugin.id}`,'PUT',{...plugin,fields:[{key:'fixture',label:'Fixture',type:'password'}],scriptBody})
  const grant = (notifyAllowed) => call(`${plugins}/${plugin.id}/permissions`,'POST',{enabled:true,notifyAllowed})
  const run = () => call(`${jobs}/${first.id}/run`,'POST',{})
  await configure(true)
  await update(`async function onSchedule(ctx) { if (ctx.task.id===${JSON.stringify(second.id)}) { if (ctx.form.fixture || await ctx.storage.get("local")) throw Error(); return; } await ctx.storage.set("local",ctx.form.fixture); await ctx.notify.send(ctx.form.fixture, ctx.form.fixture); }`)
  await call(`${jobs}/${first.id}`,'PUT',{...form,values:{fixture:marker}})
  await grant(false); assert.equal((await run()).outcome.success,false)
  await grant(true); await configure(false); assert.equal((await run()).outcome.success,false)
  await configure(true); assert.equal((await run()).outcome.success,true)
  assert.equal((await call(`${jobs}/${second.id}/run`,'POST',{})).outcome.success,true,'sibling instance has neither the saved secret nor private storage')
  for (let attempt=0; !signals.length && attempt<50; attempt++) await delay(40)
  assert.equal(signals.length,1); assert.equal(JSON.parse(signals[0]).event,'task_signal'); assert.ok(!signals[0].includes(marker))
  const backup={filePath:path.join(home,'fixture.a2ab'),password:randomUUID()+'!Aa',includeLogs:true}
  await update('async function onSchedule(ctx) { if (await ctx.storage.get("local") !== ctx.form.fixture) throw Error(); await ctx.sleep(8000); }')
  await grant(false)
  const completedRuns = (await call(`${jobs}/${first.id}/runs`)).runs
  const siblingRuns = (await call(`${jobs}/${second.id}/runs`)).runs
  async function running() {
    for (let attempt=0; attempt<60; attempt++) { if ((await call(jobs)).jobs.find(job=>job.id===first.id).lastStatus==='running') return; await delay(40) }
    assert.fail('task did not enter running state')
  }
  const pending = run(); await running()
  await call('/api/backup/export','POST',backup)
  await call(`${jobs}/${first.id}/run`,'POST',{},400)
  const busyRestore=await call('/api/backup/import','POST',backup,500)
  assert.match(JSON.stringify(busyRestore),/请先停止任务/)
  await call(`${jobs}/${first.id}/stop`,'POST',{})
  assert.equal((await pending).outcome.success,false)
  const interrupted = run().catch(()=>null); await running(); app.kill(); await done; await interrupted
  app=start(); done=once(app,'exit'); await ready()
  session=await createFixturePanelSession(base,credentials,'login'); headers['x-panel-token']=session.accessToken
  const history = (await call(`${jobs}/${first.id}/runs`)).runs
  assert.equal(history[0].status,'failed'); assert.match(history[0].error,/重启/); assert.equal(signals.length,1)
  await call('/api/backup/import','POST',backup)
  session=await createFixturePanelSession(base,credentials,'login'); headers['x-panel-token']=session.accessToken
  const restored=(await call(plugins)).plugins.find(entry=>entry.id===plugin.id)
  await verifyRestoredProbe(call)
  assert.equal(restored.enabled,false); assert.equal(restored.notifyAllowed,false)
  const restoredJob = (await call(jobs)).jobs.find(job=>job.id===first.id)
  assert.equal(restoredJob.enabled,false); assert.equal(restoredJob.nextRunAt,null)
  assert.equal(restoredJob.lastStatus,'failed'); assert.match(restoredJob.lastError,/恢复.*中断/)
  const restoredRuns = (await call(`${jobs}/${first.id}/runs`)).runs
  assert.equal(restoredRuns[0].status,'failed'); assert.match(restoredRuns[0].error,/恢复.*中断/)
  assert.ok(restoredRuns[0].finishedAt >= restoredRuns[0].startedAt)
  assert.deepEqual(restoredRuns.slice(1),completedRuns)
  assert.deepEqual((await call(`${jobs}/${second.id}/runs`)).runs,siblingRuns); assert.equal(signals.length,1)
  console.log('PASS sandbox, grants, encrypted form/storage, timezone, mutex, stop, restart, busy restore refusal, interrupted restore and untouched completed history')
  if (process.argv.includes('--browser')) {
    const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
    const browser=await chromium.launch({executablePath:process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
    try { for (const mobile of [false,true]) {
      const context=await browser.newContext({locale:'zh-CN',viewport:mobile?{width:390,height:844}:{width:1400,height:900},isMobile:mobile})
      await installFixturePanelSession(context,base,session,env.AGENT2API_PROXY_API_KEY); await isolateUpdateNotice(context)
      const page=await context.newPage()
      await page.goto(mobile?base+'/m#tasks':base)
      if (!mobile) await page.locator('.nav-item[data-page="tasks"]').click()
      const pane=page.locator('[data-local-task-plugins]:visible'); await pane.getByRole('button').first().click()
      await verifyProbePanel(page,pane,call)
      await pane.getByRole('button',{name:plugin.name,exact:true}).click(); await pane.locator('[data-task-name]').fill(mobile?'mobile fixture':'desktop fixture')
      const submit=pane.getByRole('button',{name:/创建停用的实例/})
      const [saved]=await Promise.all([page.waitForResponse(res=>res.url().endsWith(jobs) && res.request().method()==='POST'),submit.click({timeout:10000})]); assert.equal(saved.status(),200)
      if (!process.argv.includes('--without-store')) {
        if (mobile) {
          await page.goto(base+'/m?screen-test=more#more')
          await page.locator('[data-screen="more"]').getByRole('button',{name:/网关插件/}).click()
          await page.locator('[data-screen="plugins"]').waitFor()
        } else {
          await page.locator('.nav-item[data-page="plugins"]').click()
          await page.locator('.page[data-page="plugins"]:visible').waitFor()
        }
        await pane.getByRole('button').first().click()
        const script='/* @agent2api-task-plugin\n'+JSON.stringify({id:mobile?'mobile-editor':'desktop-editor',name:'Raw script fixture',version:'1.0.0'})+'\n*/\nexport function onSchedule() { return 7; }'
        await pane.locator('[data-task-manifest]').fill(script)
        const seenPreview=page.waitForResponse(res=>res.url().endsWith(plugins+'/preview') && res.request().method()==='POST')
        await pane.getByRole('button',{name:/试跑/}).click(); const preview=await (await seenPreview).json(); assert.equal((preview.data??preview).outcome.success,true)
        const seenSave=page.waitForResponse(res=>res.url().endsWith(plugins) && res.request().method()==='POST'); await pane.getByRole('button',{name:/保存插件/}).click(); assert.equal((await seenSave).status(),200)
        await pane.getByRole('button',{name:'Raw script fixture',exact:true}).first().waitFor(); assert.equal(await pane.getByRole('button',{name:/刷新任务插件商店/}).count(),1)
      }
      await context.close(); console.log('PASS',mobile?'mobile':'desktop','task editor and independent instance',process.argv.includes('--without-store')?'':'plus plugin category and single-file preview/save')
    } } finally {await browser.close()}
  }
} finally {
  if (app.exitCode === null) app.kill()
  await done
  await new Promise(resolve=>{sink.close(resolve);sink.closeAllConnections()})
  try { for (const file of await readdir(home,{recursive:true,withFileTypes:true})) if (file.isFile()) assert.ok(!(await readFile(path.join(file.parentPath,file.name))).includes(marker),'no plaintext secret in SQLite or logs') }
  finally { await rm(home, { recursive: true, force: true, maxRetries: 3 }) }
}
