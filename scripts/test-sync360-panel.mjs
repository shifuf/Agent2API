import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as wait } from 'node:timers/promises'
import { createFixturePanelSession, installFixturePanelSession } from './fixtures/panel-session.mjs'

const home=await mkdtemp(join(tmpdir(),'sync360-panel-'))
const reserved=createServer().listen(0,'127.0.0.1'); await once(reserved,'listening'); const port=reserved.address().port; await new Promise(resolve=>reserved.close(resolve))
const base=`http://127.0.0.1:${port}`; const key=randomUUID(), secret=randomUUID(), site='fixture-public-sitekey'; const credentials={username:'panel-admin',password:randomUUID()+'Aa!'}
const widgetOrigin='https://fixture.invalid'
const env={...process.env,AGENT2API_HOST:'127.0.0.1',AGENT2API_PROXY_HOME:home,AGENT2API_PROXY_PORT:String(port),AGENT2API_PROXY_API_KEY:key,AGENT2API_ACCOUNT_KEY:'8'.repeat(64),AGENT2API_CAPTCHA_ENABLED:'0',AGENT2API_SELF_UPDATE:'0',AGENT2API_WINDOWS_UPDATE:'0',AGENT2API_UI_DIR:resolve(import.meta.dirname,'../desktop-tauri/ui')}
for(const name of ['AGENT2API_PANEL_PORT','AGENT2API_ADMIN_USER','AGENT2API_ADMIN_PASSWORD','AGENT2API_ADMIN_PASSWORD_HASH'])delete env[name]
const child=spawn(resolve(process.argv[2]),[],{env,cwd:home,windowsHide:true,stdio:['ignore','pipe','pipe']}); const exited=once(child,'exit'); let logs=''; for(const pipe of [child.stdout,child.stderr])pipe.on('data',chunk=>{logs+=chunk.toString()})
async function request(path,method,body,headers={}) { return fetch(base+path,{method,headers:{...headers,'content-type':'application/json'},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(20000)}) }
async function inspect(dir) {for(const item of await readdir(dir,{withFileTypes:true})) {const file=join(dir,item.name); if(item.isDirectory())await inspect(file);else assert.ok(!(await readFile(file)).includes(Buffer.from(secret)),`plaintext verifier secret in ${item.name}`)}}
async function browserCheck(session) {
  const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright'); const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE,headless:true})
  try {
    for (const mobile of [false,true]) {
      const context=await browser.newContext({locale:'en-US',serviceWorkers:'block',...(mobile?{viewport:{width:390,height:844}}:{})})
      if(mobile) await context.addInitScript(origin=>{
        if (location.origin!==origin || window!==top) return
        window.Capacitor={isNativePlatform:()=>true,getPlatform:()=>'android',isPluginAvailable:()=>false,Plugins:{}}
        localStorage.setItem('agent2api.servers',JSON.stringify([{id:'fixture',name:'Fixture',base:origin}])); localStorage.setItem('agent2api.activeServer','fixture')
      },base)
      const token=randomUUID(); let submitted
      await context.route(widgetOrigin+'/turnstile-widget.html',route=>route.fulfill({contentType:'text/html',path:resolve(import.meta.dirname,'../desktop-tauri/src-tauri/server/src/server/api/turnstile-widget.html')}))
      await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js*',route=>route.fulfill({contentType:'application/javascript',body:`window.turnstile={render:(node, options)=>{let isolated=false;try{parent.document.title}catch{isolated=true};if(!isolated||options.action!=='agent2api_panel'||options.sitekey!==${JSON.stringify(site)}){options['error-callback']();return;}document.querySelector(node).textContent='Isolated fixture';options.callback(${JSON.stringify(token)})}}`}))
      await context.route('**/api/panel/login*',route=>{if(route.request().method()!=='POST')return route.continue();submitted=route.request().postDataJSON();return route.fulfill({status:400,json:{error:'fixture'}})})
      const page=await context.newPage();await page.goto(base+(mobile?'/m':'/login'));await page.frameLocator('iframe[title="Cloudflare Turnstile"]').getByText('Isolated fixture').waitFor()
      const frame=page.locator('iframe[title="Cloudflare Turnstile"]');assert.ok((await frame.getAttribute('src')).startsWith(widgetOrigin+'/'));assert.equal(await frame.getAttribute('sandbox'),'allow-scripts allow-same-origin'); await page.locator(mobile?'input[autocomplete="username"]':'#username').fill(credentials.username);await page.locator('input[type=password]:visible').fill(credentials.password)
      if(mobile) {const button=page.getByRole('button',{name:/^(log in|login|sign in|登录)$/i});try{await button.click({timeout:5000})}catch{throw Error('Simulated mobile submit control: '+JSON.stringify(await page.getByRole('button').allTextContents()))}} else await page.locator('#submit').click();for(let turn=0;turn<30&&!submitted;turn++)await wait(100);assert.equal(submitted?.captcha,token);await context.close()
    }
    const admin=await browser.newContext({locale:'en-US',serviceWorkers:'block'});await installFixturePanelSession(admin,base,session,key)
    for(const mobile of [false,true]) {const page=await admin.newPage();await page.goto(base+(mobile?'/m#settings':'/'));if(!mobile) {await page.locator('.nav-item[data-page="settings"]').click();await page.locator('#settings-nav [data-cat="security"]').click()} const editor=page.locator('[data-turnstile-editor]');await editor.waitFor();assert.equal(await editor.locator('select').inputValue(),'turnstile');assert.equal(await editor.locator('input[type=password]').inputValue(),'');await page.close()}
    await admin.close();console.log('PASS sandboxed desktop + simulated packaged mobile widget submits fixture token; admin editor hides stored secret')
  } finally {await browser.close()}
}
try {
  for(let turn=0;turn<100;turn++){if((await fetch(base+'/health').catch(()=>null))?.ok)break;await wait(100)}
  const session=await createFixturePanelSession(base,credentials); const auth={'x-panel-token':session.accessToken}, gateway={'x-api-key':key}; const endpoint='/api/captcha/turnstile'
  assert.equal((await request('/api/captcha','PUT',{captchaWeb:false},gateway)).status,403,'gateway Key must not change the login requirement')
  assert.equal((await request(endpoint,'GET',undefined,gateway)).status,403); const initial=await request(endpoint,'GET',undefined,auth); assert.equal(initial.status,200); assert.equal((await initial.json()).data.provider,'altcha')
  assert.equal((await request(endpoint,'PUT',{provider:'turnstile',siteKey:site,secret,hostnames:[]},auth)).status,400)
  for (const host of ['*.invalid','fixture.invalid/path','http://fixture.invalid','fixture.invalid:443','elsewhere.invalid'])assert.equal((await request(endpoint,'PUT',{provider:'turnstile',siteKey:site,secret,widgetOrigin,hostnames:[host]},auth)).status,400)
  for (const origin of ['http://fixture.invalid','https://fixture.invalid/widget','https://127.0.0.1','https://fixture.invalid:8000'])assert.equal((await request(endpoint,'PUT',{provider:'turnstile',siteKey:site,secret,widgetOrigin:origin,hostnames:['fixture.invalid']},auth)).status,400)
  const configured=await request(endpoint,'PUT',{provider:'turnstile',siteKey:site,secret,widgetOrigin,hostnames:['FIXTURE.invalid']},auth); assert.equal(configured.status,200); const result=(await configured.json()).data; assert.equal(result.hasSecret,true); assert.deepEqual(result.hostnames,['fixture.invalid']); assert.ok(!JSON.stringify(result).includes(secret))
  assert.equal((await request('/api/captcha','PUT',{captchaWeb:true},auth)).status,200); const publicStatus=(await (await request('/api/panel/status','GET')).json()).data; assert.equal(publicStatus.captchaProvider,'turnstile'); assert.equal(publicStatus.turnstileSiteKey,site); assert.ok(!JSON.stringify(publicStatus).includes(secret)); assert.ok(!JSON.stringify(publicStatus).includes('fixture.invalid'))
  const challenge=await request('/api/panel/captcha','GET'); assert.ok(!JSON.stringify(await challenge.json()).includes('signature'),'no fallback ALTCHA challenge')
  const widget=await request('/api/panel/turnstile-widget','GET');assert.equal(widget.status,200);assert.ok(widget.headers.get('content-security-policy').includes('sandbox allow-scripts;'));assert.ok(!widget.headers.get('content-security-policy').includes('allow-same-origin'));assert.ok(!(await widget.text()).includes(secret))
  if(process.argv.includes('--browser'))await browserCheck(session)
  const missing=await request('/api/panel/login','POST',credentials); assert.equal(missing.status,400); assert.ok(!missing.headers.get('set-cookie'))
  const tooLong=await request('/api/panel/login','POST',{...credentials,captcha:'x'.repeat(2050)}); assert.equal(tooLong.status,400); assert.ok(!tooLong.headers.get('set-cookie'))
  assert.equal((await request(endpoint,'PUT',{provider:'altcha'},auth)).status,200); const altcha=await (await request('/api/panel/captcha','GET')).json(); assert.ok(altcha.signature)
  assert.equal((await request('/api/captcha','PUT',{captchaWeb:false},auth)).status,200); await createFixturePanelSession(base,credentials,'login'); await inspect(home); assert.ok(!logs.includes(secret)); console.log('PASS admin-only verifier configuration, encrypted credentials, public field isolation, no ALTCHA fallback, password recovery')
} finally {if(child.exitCode===null)child.kill();await exited;await rm(home,{recursive:true,force:true,maxRetries:3})}
