import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { createFixturePanelSession,installFixturePanelSession } from './fixtures/panel-session.mjs'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'

const binary=resolve(process.argv[2]), dir=await mkdtemp(join(tmpdir(),'sync360-maint-'))
const listener=createServer().listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(done=>listener.close(done))
const base=`http://127.0.0.1:${port}`, key=randomUUID(), credentials={username:'maintenance-admin',password:randomUUID()+'Aa!'}
let updateCalls=0
const mirror=httpServer((req,res)=>{updateCalls++;res.writeHead(503);res.end()}).listen(0,'127.0.0.1');await once(mirror,'listening')
const env={...process.env,AGENT2API_HOST:'127.0.0.1',AGENT2API_PROXY_HOME:dir,AGENT2API_PROXY_PORT:String(port),AGENT2API_PROXY_API_KEY:key,AGENT2API_ACCOUNT_KEY:'9'.repeat(64),AGENT2API_CAPTCHA_ENABLED:'0',AGENT2API_SELF_UPDATE:'0',AGENT2API_WINDOWS_UPDATE:'0'}
for(const key of ['AGENT2API_PANEL_PORT','AGENT2API_ADMIN_USER','AGENT2API_ADMIN_PASSWORD','AGENT2API_ADMIN_PASSWORD_HASH'])delete env[key]
env.WORKBUDDY_UPDATE_API_BASE=`http://127.0.0.1:${mirror.address().port}`;env.AGENT2API_SYSTEMD_UPDATE='0'
env.AGENT2API_UI_DIR=resolve(import.meta.dirname,'../desktop-tauri/ui')
let child,exited,session
async function start(){child=spawn(binary,[],{env,cwd:dir,windowsHide:true,stdio:'ignore'});exited=once(child,'exit');for(let turn=0;turn<100;turn++){if((await fetch(base+'/health').catch(()=>null))?.ok)return;await delay(100)}throw Error('server not ready')}
async function stop(){if(child && child.exitCode===null)child.kill();if(exited)await exited;child=null}
async function request(path,method='GET',body){return fetch(base+path,{method,headers:{'Content-Type':'application/json','x-panel-token':session.accessToken},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(20000)})}
async function list(){const response=await request('/api/scheduled-tasks');assert.equal(response.status,200);return (await response.json()).data.tasks}
const task=async()=> (await list()).find(row=>row.id==='credentialMaintenance')
async function dbfile(path){for(const item of await readdir(path,{withFileTypes:true})){const file=join(path,item.name);if(item.name==='agent2api.db')return file;if(item.isDirectory()){const nested=await dbfile(file);if(nested)return nested}}}
async function checkHistoryUi(history){
  const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE})
  try {for(const mobile of [false,true]){
    const context=await browser.newContext({locale:'zh-CN',viewport:mobile?{width:390,height:844}:{width:1400,height:900},isMobile:mobile});await installFixturePanelSession(context,base,session,key);await isolateUpdateNotice(context)
    const page=await context.newPage();await page.goto(mobile?base+'/m#tasks':base);if(!mobile)await page.locator('.nav-item[data-page="tasks"]').click()
    const firstTime=new Date(history[0].startedAt).toISOString();const list=page.locator('details[data-maintenance-history]').filter({has:page.locator(`time[datetime="${firstTime}"]`)});await list.locator('summary').click();for(const item of history.slice(0,3)){
      const row=list.locator('li').filter({has:page.locator(`time[datetime="${new Date(item.startedAt).toISOString()}"]`)});assert.ok(await row.isVisible());assert.match(await row.textContent(),item.trigger==='manual'?/手动|Manual/i:/定时|Scheduled/i);if(item.status==='interrupted')assert.match(await row.textContent(),/已中断|Interrupted/i)
    }await context.close();console.log('PASS',mobile?'mobile':'desktop','actual maintenance run history and recovered interruption')
  }}finally{await browser.close()}
}
try {
  await writeFile(join(dir,'config.json'), JSON.stringify({scheduledTasks:{modelRefresh:{enabled:false},credentialMaintenance:{enabled:false}}}))
  await start();session=await createFixturePanelSession(base,credentials)
  assert.ok(Array.isArray((await task()).history),'credential maintenance must expose durable per-run history')
  const plans=await list();assert.equal(plans.find(item=>item.id==='modelRefresh').enabled,false);assert.equal(plans.find(item=>item.id==='credentialMaintenance').enabled,false);const plugin=plans.find(item=>item.id==='pluginCatalog');assert.ok(plugin.readOnlyPlan);assert.equal(plugin.available,false);assert.ok(!(await request('/api/scheduled-tasks/pluginCatalog/run','POST',{})).ok)
  const noUpdates=plans.find(item=>item.id==='updateCheck');assert.equal(noUpdates.canRun,false);const callsBefore=updateCalls;assert.ok(!(await request('/api/scheduled-tasks/updateCheck/run','POST',{})).ok);await delay(80);assert.equal(updateCalls,callsBefore)
  await request('/api/scheduled-tasks/credentialMaintenance','POST',{enabled:false});await delay(1400)
  const outcomes=await Promise.all([request('/api/accounts/refresh-expiring','POST',{}),request('/api/scheduled-tasks/credentialMaintenance/run','POST',{})]);assert.equal(outcomes.filter(result=>result.ok).length,1,'both manual paths must share the same claim')
  let item=(await task()).history[0];assert.equal(item.trigger,'manual');assert.equal(item.status,'succeeded');assert.ok(item.finishedAt>=item.startedAt);assert.deepEqual(Object.keys(item).sort(),['finishedAt','startedAt','status','trigger'])
  await request('/api/scheduled-tasks/credentialMaintenance','POST',{enabled:true,interval:60});for(let turn=0;turn<140;turn++){if((await task()).history[0]?.trigger==='scheduled')break;await delay(100)}assert.equal((await task()).history[0].trigger,'scheduled')
  await request('/api/scheduled-tasks/credentialMaintenance','POST',{enabled:false});await stop()
  const file=await dbfile(dir);assert.ok(file);function changeRow(change){const db=new DatabaseSync(file);try{const state=JSON.parse(db.prepare('SELECT value FROM kv WHERE key=?').get('backgroundTaskState').value);change(state.credentialMaintenance);db.prepare('UPDATE kv SET value=? WHERE key=?').run(JSON.stringify(state),'backgroundTaskState')}finally{db.close()}}
  changeRow(row=>{row.owner='fixture-other-instance';row.leaseUntil=Date.now()+120000;row.history.unshift({startedAt:Date.now()-10000,finishedAt:null,status:'running',trigger:'scheduled'})});await start();session=await createFixturePanelSession(base,credentials,'login');assert.equal((await task()).history[0].status,'running');assert.ok(!(await request('/api/scheduled-tasks/credentialMaintenance/run','POST',{})).ok);await stop()
  changeRow(row=>{row.leaseUntil=Date.now()-1000})
  await start();session=await createFixturePanelSession(base,credentials,'login');item=(await task()).history[0];assert.equal(item.status,'interrupted');assert.ok(item.finishedAt>=item.startedAt);assert.ok((await task()).history.some(run=>run.status==='succeeded'&&run.trigger==='manual'))
  if(process.argv.includes('--browser'))await checkHistoryUi((await task()).history)
  await stop();changeRow(row=>{const oldest=row.history.at(-1);while(row.history.length<32)row.history.push({...oldest,startedAt:oldest.startedAt-row.history.length});row.history[31].startedAt=1});await start();session=await createFixturePanelSession(base,credentials,'login');await delay(1400);assert.ok((await request('/api/scheduled-tasks/credentialMaintenance/run','POST',{})).ok);const recent=(await task()).history;assert.equal(recent.length,32);assert.ok(!recent.some(item=>item.startedAt===1));assert.equal(recent[0].trigger,'manual')
  console.log('PASS durable bounded credential history, shared manual/automatic lease, live foreign owner preserved, stale run interrupted after restart, non-sensitive history fields')
}finally{await stop();await new Promise(resolve=>mirror.close(resolve));await rm(dir,{recursive:true,force:true,maxRetries:4})}
