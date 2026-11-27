import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp,readdir,readFile,rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { createFixturePanelSession,installFixturePanelSession } from './fixtures/panel-session.mjs'

const dir=await mkdtemp(join(tmpdir(),'sync360-oauth-'));const listener=createServer().listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(done=>listener.close(done))
const secret=randomUUID(),key=randomUUID(), base=`http://127.0.0.1:${port}`, origin='https://panel.example.test', headers={host:'panel.example.test',origin,'content-type':'application/json'}
const env={...process.env,AGENT2API_HOST:'127.0.0.1',AGENT2API_PROXY_HOME:dir,AGENT2API_PROXY_PORT:String(port),AGENT2API_PROXY_API_KEY:key,AGENT2API_ACCOUNT_KEY:'7'.repeat(64),AGENT2API_CAPTCHA_ENABLED:'0',AGENT2API_SELF_UPDATE:'0',AGENT2API_WINDOWS_UPDATE:'0'};for(const name of ['AGENT2API_PANEL_PORT','AGENT2API_ADMIN_USER','AGENT2API_ADMIN_PASSWORD','AGENT2API_ADMIN_PASSWORD_HASH'])delete env[name]
env.AGENT2API_VERBOSE='1'
env.AGENT2API_UI_DIR=resolve(import.meta.dirname,'../desktop-tauri/ui')
const child=spawn(resolve(process.argv[2]),[],{cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});const exited=once(child,'exit');let logs='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',chunk=>{logs+=chunk})
const endpoint='/api/panel-oauth', start='/api/panel/oauth/start', cb='/api/panel/oauth/github/callback'
async function req(path,method='GET',body,extra={}) {return new Promise((resolve,reject)=>{const outgoing=httpRequest(base+path,{method,headers:{...headers,...extra},signal:AbortSignal.timeout(20000)},incoming=>{const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:incoming.statusCode,headers:incoming.headers})));incoming.on('error',reject)});outgoing.on('error',reject);outgoing.end(body&&JSON.stringify(body))})}
async function scan(path){for(const item of await readdir(path,{withFileTypes:true})){const file=join(path,item.name);if(item.isDirectory())await scan(file);else assert.ok(!(await readFile(file)).includes(Buffer.from(secret)))}}
async function web(session) {
  const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE})
  async function useContext(){const context=await browser.newContext({locale:'en-US',serviceWorkers:'block'});await context.route(origin+'/**',async route=>{
    const request=route.request(),target=new URL(request.url());const incomingHeaders=await request.allHeaders();delete incomingHeaders['content-length'];delete incomingHeaders['accept-encoding'];const bytes=request.postDataBuffer();const result=await new Promise((resolve,reject)=>{const outgoing=httpRequest(base+target.pathname+target.search,{method:request.method(),headers:{...incomingHeaders,host:target.host}},incoming=>{const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.on('end',()=>resolve({status:incoming.statusCode,headers:Object.fromEntries(Object.entries(incoming.headers).filter(([key])=>!['connection','transfer-encoding','content-length'].includes(key)).map(([key,value])=>[key,Array.isArray(value)?value.join('\n'):String(value)])),body:Buffer.concat(chunks)}));incoming.on('error',reject)});outgoing.on('error',reject);outgoing.end(bytes)});await route.fulfill(result)
  });return context}
  try {
    const owner=await useContext(), other=await useContext();await installFixturePanelSession(owner,origin,session,key)
    await owner.route('https://github.com/login/oauth/authorize*',route=>route.fulfill({contentType:'text/html',body:'<h1>Provider consent fixture</h1>'}))
    const page=await owner.newPage();await page.goto(origin);await page.locator('.nav-item[data-page="settings"]').click();await page.locator('#settings-nav [data-cat="security"]').click();const editor=page.locator('[data-panel-oauth]');await editor.waitFor();assert.equal(await editor.locator('input[type="password"]').inputValue(),'')
    await editor.getByRole('button',{name:/^(Bind identity|绑定身份)$/i}).click();await page.getByRole('heading',{name:'Provider consent fixture'}).waitFor();const target=new URL(page.url());const callback=origin+cb+'?state='+encodeURIComponent(target.searchParams.get('state'))+'&error=access_denied';assert.equal(new URL(target.searchParams.get('redirect_uri')).origin,origin)
    const outsider=await other.newPage();assert.equal((await outsider.goto(callback)).status(),403);assert.equal((await page.goto(callback)).status(),400);assert.equal((await page.goto(callback)).status(),403)
    const mobile=await owner.newPage();await mobile.setViewportSize({width:390,height:844});await mobile.goto(origin+'/m#settings');const mobileEditor=mobile.locator('[data-panel-oauth]');await mobileEditor.waitFor();assert.equal(await mobileEditor.locator('input[type="password"]').inputValue(),'');await mobileEditor.locator('select').selectOption('google');assert.equal(await mobileEditor.locator('input[type="password"]').inputValue(),'')
    await other.close();await owner.close();console.log('PASS HTTPS desktop and mobile OAuth settings, browser binds via real PKCE start, foreign browser cannot consume callback, owner state used only once')
  } finally{await browser.close()}
}
try {
  for(let turn=0;turn<100;turn++){if((await fetch(base+'/health').catch(()=>null))?.ok)break;await wait(100)}
  const credentials={username:'oauth-admin',password:randomUUID()+'!Aa'};const session=await createFixturePanelSession(base,credentials),admin={'x-panel-token':session.accessToken,cookie:session.cookie.name+'='+session.cookie.value},gateway={'x-api-key':key}
  assert.equal((await req(endpoint,'GET',undefined,gateway)).status,403,'gateway keys must not configure administrator login');const settings=await req(endpoint,'GET',undefined,admin);assert.equal(settings.status,200)
  const config={origin,provider:'github',clientId:'fixture-github-client',secret,enabled:true};assert.equal((await req(endpoint,'PUT',{...config,origin:'http://not-https.test'},admin)).status,400);assert.equal((await req(endpoint,'PUT',{...config,subject:'injected'},admin)).status,400)
  const saved=await req(endpoint,'PUT',config,admin);assert.equal(saved.status,200);assert.ok(!JSON.stringify(await saved.json()).includes(secret));assert.equal((await req(start,'POST',{provider:'github',mode:'bind'},gateway)).status,403);assert.ok(!(await req(start,'POST',{provider:'github',mode:'login'})).ok)
  if(process.argv.includes('--browser'))await web(session)
  assert.ok(!(await req(start,'POST',{provider:'github',mode:'bind'}, {...admin,origin:'https://other.example.test'})).ok)
  const begin=await req(start+'?origin=https://other.example.test','POST',{provider:'github',mode:'bind'},{...admin,'x-forwarded-host':'other.example.test'});assert.equal(begin.status,200);const url=new URL((await begin.json()).data.url);assert.equal(url.origin,'https://github.com');assert.equal(url.searchParams.get('redirect_uri'),origin+cb);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(url.searchParams.get('code_challenge'));assert.ok(!url.href.includes(secret));const state=url.searchParams.get('state');assert.ok(state)
  const cookie=begin.headers.get('set-cookie');assert.ok(cookie.startsWith('__Host-'));assert.match(cookie,/HttpOnly/i);assert.match(cookie,/Secure/i);assert.match(cookie,/SameSite=Lax/i)
  const target=cb+'?state='+encodeURIComponent(state)+'&error=access_denied';assert.equal((await req(target,'GET',undefined,admin)).status,403);const owner={...admin,cookie:admin.cookie+'; '+cookie.split(';')[0]};const responses=await Promise.all([req(target,'GET',undefined,owner),req(target,'GET',undefined,owner)]);assert.deepEqual(responses.map(response=>response.status).sort(),[400,403]);for(const response of responses)assert.ok(!response.headers.get('set-cookie')?.includes(session.cookie.name+'='));
  await scan(dir);assert.ok(!logs.includes(secret));assert.ok(!logs.includes(state));await createFixturePanelSession(base,credentials,'login');console.log('PASS admin-only OAuth configuration; canonical HTTPS callback, PKCE, browser/session bound one-use state, no session on denial; password fallback')
}finally{if(child.exitCode===null)child.kill();await exited;await rm(dir,{recursive:true,force:true,maxRetries:4})}
