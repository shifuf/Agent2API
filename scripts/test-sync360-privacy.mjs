import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { createFixturePanelSession, installFixturePanelSession } from './fixtures/panel-session.mjs'

const home = await mkdtemp(join(tmpdir(), 'sync360-privacy-'))
const credentials = { username: 'privacy-admin', password: 'SyntheticPrivacyPass123!' }
const key = 'synthetic-privacy-gateway'
const secret = 'PrivatePhraseQ29Marker'
let foreign = '', previous = '', calls = 0, mode = 'echo'
let idleSeen = null, idleClosed = null, account = ''
const upstream = http.createServer(async (request, reply) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString()); calls++
  account=request.headers.authorization
  const text = typeof body.messages?.at(-1)?.content === 'string' ? body.messages.at(-1).content : JSON.stringify(body.input || body.messages)
  if (JSON.stringify(body).includes(secret)) { reply.writeHead(400); reply.end('Unsafe plaintext reached upstream'); return }
  const matched = /BEFORE (.+?) AFTER/.exec(text)
  if (!matched) { reply.writeHead(400); reply.end('Missing synthetic input'); return }
  previous = matched[1]; const echo = mode === 'plaintext' ? secret : foreign || previous
  if (mode === 'error') { reply.writeHead(400,{'content-type':'application/json'}); reply.end(JSON.stringify({error:{message:`diagnostic ${secret}`}})); return }
  reply.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const parts=[echo.slice(0,4),echo.slice(4,12),echo.slice(12)]
  if(request.url.endsWith('/responses') || request.url.endsWith('/messages')) {
    const event=(type,payload)=>`event: ${type}\ndata: ${JSON.stringify({type,...payload})}\n\n`
    if(request.url.endsWith('/responses')) {
      reply.write(event('response.created',{response:{id:'resp_fixture',model:'wire-safe',status:'in_progress'}})); for(const delta of parts)reply.write(event('response.output_text.delta',{output_index:0,content_index:0,delta})); reply.end(event('response.completed',{response:{id:'resp_fixture',model:'wire-safe',status:'completed',usage:{input_tokens:4,output_tokens:3}}}))
    }else{
      reply.write(event('message_start',{message:{id:'msg_fixture',type:'message',role:'assistant',model:'wire-safe',content:[],usage:{input_tokens:4,output_tokens:0}}})); reply.write(event('content_block_start',{index:0,content_block:{type:'text',text:''}})); for(const text of parts)reply.write(event('content_block_delta',{index:0,delta:{type:'text_delta',text}})); reply.write(event('content_block_stop',{index:0})); reply.write(event('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:3}})); reply.end(event('message_stop',{}))
    }
    return
  }
  if (mode === 'streamError') { reply.end(`data: ${JSON.stringify({error:{message:'fixture '+secret}})}\n\ndata: [DONE]\n\n`); return }
  if (mode === 'idle') {
    reply.write('data: {"choices":[{"index":0,"delta":{"content":"ready"}}]}\n\n'); reply.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content:echo.slice(0,3)}}]})}\n\n`)
    reply.once('close',()=>idleClosed?.()); idleSeen?.(); return
  }
  if (mode === 'tools') {
    for (const [index,part] of ['{"word":"'+echo.slice(0,7),echo.slice(7,19),echo.slice(19)+'"}'].entries()) {
      reply.write(`data: ${JSON.stringify({id:'completion',choices:[{index:0,delta:{tool_calls:[{index:0,...(index===0?{id:'call_fixture',type:'function'}:{}),function:{...(index===0?{name:'lookup'}:{}),arguments:part}}]},finish_reason:null}]})}\n\n`)
    }
    reply.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'); return
  }
  for (const content of [echo.slice(0, 4), echo.slice(4, 12), echo.slice(12)]) reply.write(`data: ${JSON.stringify({id:'completion',choices:[{index:0,delta:{content},finish_reason:null}]})}\n\n`)
  reply.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\ndata: [DONE]\n\n')
}).listen(0, '127.0.0.1'); await once(upstream, 'listening')
const reserved = http.createServer().listen(0, '127.0.0.1'); await once(reserved, 'listening'); const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve))
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, AGENT2API_HOST:'127.0.0.1', AGENT2API_PROXY_HOME:home, AGENT2API_PROXY_PORT:String(port), AGENT2API_PROXY_API_KEY:key, AGENT2API_CAPTCHA_ENABLED:'0', AGENT2API_ACCOUNT_KEY:'7'.repeat(64), AGENT2API_SELF_UPDATE:'0', AGENT2API_WINDOWS_UPDATE:'0' }
env.AGENT2API_UI_DIR=resolve(import.meta.dirname,'../desktop-tauri/ui')
for (const field of ['AGENT2API_PANEL_PORT','AGENT2API_ADMIN_USER','AGENT2API_ADMIN_PASSWORD','AGENT2API_ADMIN_PASSWORD_HASH']) delete env[field]
const child = spawn(resolve(process.argv[2]), [], { env, cwd:home, windowsHide:true, stdio:['ignore','pipe','pipe'] }); let logs = ''
for (const pipe of [child.stdout,child.stderr]) pipe.on('data', bytes => { logs += bytes.toString() })
const exited = once(child,'exit')
async function call(path, data, method, headers = { 'x-api-key':key }) {
  return fetch(base + path, { method:method || (data ? 'POST' : 'GET'), headers:{ ...headers, 'Content-Type':'application/json' }, body:data ? JSON.stringify(data) : undefined, signal:AbortSignal.timeout(25000) })
}
async function ok(path, data, method, headers) { const r = await call(path,data,method,headers); const text = await r.text(); assert.equal(r.status,200,`${path}: ${r.status}`); return JSON.parse(text).data }
async function inspect(dir) { for (const item of await readdir(dir,{withFileTypes:true})) { const path = join(dir,item.name); if (item.isDirectory()) await inspect(path); else assert.ok(!(await readFile(path)).includes(Buffer.from(secret)), `plaintext in ${item.name}`) } }
async function findDb(dir) { for (const item of await readdir(dir,{withFileTypes:true})) { const file=join(dir,item.name); if (item.isDirectory()) { const result=await findDb(file); if(result)return result } else if (/\.(db|sqlite|sqlite3)$/.test(item.name)) { const db=new DatabaseSync(file,{readOnly:true}); try { if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get())return file } finally { db.close() } } } }
async function inspectRestored(archive, password, original) {
  const dir=await mkdtemp(join(tmpdir(),'sync360-privacy-restore-')); const reservation=http.createServer().listen(0,'127.0.0.1'); await once(reservation,'listening'); const port=reservation.address().port; await new Promise(resolve=>reservation.close(resolve)); const base=`http://127.0.0.1:${port}`
  const restored=spawn(resolve(process.argv[2]),[],{env:{...env,AGENT2API_PROXY_HOME:dir,AGENT2API_PROXY_PORT:String(port),AGENT2API_ACCOUNT_KEY:'a'.repeat(64)},cwd:dir,windowsHide:true,stdio:['ignore','pipe','pipe']}); const ended=once(restored,'exit'); let output=''; for(const pipe of [restored.stdout,restored.stderr])pipe.on('data',chunk=>{output+=chunk.toString()})
  try {
    for(let turn=0;turn<100;turn++){if((await fetch(base+'/health').catch(()=>null))?.ok)break;await wait(150)}
    const session=await createFixturePanelSession(base,{username:'restore-admin',password:randomUUID()+'Aa!'}); const form=new FormData(); form.append('backup',new Blob([archive]),'privacy.backup'); form.append('password',password)
    const response=await fetch(base+'/api/backup/upload',{method:'POST',headers:{'x-panel-token':session.accessToken},body:form,signal:AbortSignal.timeout(45000)}); assert.equal(response.status,200,'isolated restore must decrypt and apply the archive'); assert.ok((await response.json()).success)
    const db=new DatabaseSync(await findDb(dir),{readOnly:true}); try { const config=JSON.parse(db.prepare("SELECT value FROM kv WHERE key='privacyRedaction'").get().value); assert.equal(config.enabled,true); assert.ok(config.rulesEnc.startsWith('enc1:')); assert.notEqual(config.rulesEnc,original); assert.ok(db.prepare('SELECT count(*) AS n FROM request_raw').get().n>0) } finally { db.close() }
    assert.ok(!output.includes(secret)); await inspect(dir)
  } finally { if(restored.exitCode===null)restored.kill(); await ended; await rm(dir,{recursive:true,force:true,maxRetries:3}) }
}
async function browserCheck(session) {
  const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright'); const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE})
  try {
    const context=await browser.newContext(); await installFixturePanelSession(context,base,session,key)
    for(const mobile of [false,true]) {
      const page=await context.newPage(); if(mobile)await page.setViewportSize({width:390,height:844}); await page.goto(base+(mobile?'/m#settings':'/'))
      if(!mobile) { await page.locator('.nav-item[data-page="settings"]').click(); await page.locator('#settings-nav [data-cat="security"]').click() }
      const editor=page.locator('[data-privacy-editor]'); await editor.waitFor(); const sample=editor.locator('textarea').last(); await sample.fill(secret)
      await editor.locator('button').last().click(); await editor.locator('pre').waitFor(); assert.ok(!(await editor.locator('pre').innerText()).includes(secret))
      const replace=editor.getByRole('checkbox').nth(1); await replace.check(); const area=editor.locator('textarea').first(); await area.fill('x'); await editor.locator('button').first().click(); await editor.getByRole('status').waitFor(); assert.equal(await area.inputValue(),'x','failed save must retain input')
      await area.fill(secret); const save=page.waitForResponse(r=>r.url().endsWith('/api/privacy')&&r.request().method()==='PUT'&&r.status()===200); await editor.locator('button').first().click(); await save; await page.waitForFunction(()=>document.querySelectorAll('[data-privacy-editor] textarea').length===1); assert.ok(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes(secret)); await page.close()
    }
    console.log('PASS desktop security and mobile settings, preview, encrypted write-only terms, rejected input retained')
  } finally { await browser.close() }
}
try {
  for (let turn=0; turn<100;turn++) { if ((await fetch(base+'/health').catch(()=>null))?.ok) break; await wait(150) }
  const session = await createFixturePanelSession(base,credentials); const auth = { 'x-panel-token': session.accessToken }
  assert.equal((await call('/api/privacy',undefined,'GET',auth)).status,200,'administrator privacy endpoint')
  assert.equal((await call('/api/privacy',undefined,'GET')).status,403)
  assert.equal((await call('/api/privacy',{enabled:true,words:[secret]},'PUT')).status,403)
  const config = await ok('/api/privacy',{enabled:true, words:[secret]},'PUT',auth); assert.ok(!JSON.stringify(config).includes(secret))
  if(process.argv.includes('--browser')) await browserCheck(session)
  const sample = await ok('/api/privacy/test',{text:`probe ${secret} free@example.test`},'POST',auth)
  assert.ok(!sample.text.includes(secret) && !sample.text.includes('free@example.test') && sample.text.startsWith('probe '))
  assert.equal((await call('/api/privacy',{words:['x']},'PUT',auth)).status,400)
  await ok('/api/debug',{debugMode:true},'PUT',auth)
  const channel = await ok('/api/custom-providers',{name:'Privacy fixture',protocol:'chat_completions',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,keyGroups:[{id:'main',enabled:true,apiKeys:['fixture-upstream'],models:['wire-safe']}]})
  const model='Privacy-Fixture'; const catalog=await ok('/api/routing/groups'); await ok('/api/routing/groups',{revision:catalog.newRevision,id:model,group:{id:model,model,name:model,enabled:true,strategy:'order',sticky:'off',members:[{id:'source',provider:channel.provider.id,model:'wire-safe',included:true,accountScope:'all',accounts:[]}]}},'PUT')
  for (const path of ['/v1/chat/completions','/v1/responses','/v1/messages']) for (const stream of [false,true]) {
    const text=`BEFORE ${secret} AFTER`; const body={model,stream,max_tokens:128,...(path.endsWith('responses')?{input:text}:{messages:[{role:'user',content:text}]})}
    const response=await call(path,body); const output=await response.text(); assert.equal(response.status,200,`${path} ${stream}`); assert.ok(output.includes(secret),`original restored for ${path} ${stream}`)
    assert.notEqual(previous,secret); if (foreign) assert.fail('unexpected foreign placeholder')
  }
  const otherChannel=await ok('/api/custom-providers',{name:'Other privacy fixture',protocol:'chat_completions',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,keyGroups:[{id:'other',enabled:true,apiKeys:['fixture-upstream-other'],models:['wire-safe']}]}); const other='Other-Privacy-Fixture'; const nextCatalog=await ok('/api/routing/groups'); await ok('/api/routing/groups',{revision:nextCatalog.newRevision,id:other,group:{id:other,model:other,name:other,enabled:true,strategy:'order',sticky:'off',members:[{id:'source',provider:otherChannel.provider.id,model:'wire-safe',included:true,accountScope:'all',accounts:[]}]}},'PUT')
  const firstAccount=account; foreign=previous; const response=await call('/v1/chat/completions',{model:other,messages:[{role:'user',content:`BEFORE ${secret} AFTER`}]}); const output=await response.text(); assert.equal(response.status,200); assert.ok(output.includes(foreign)); assert.ok(!output.includes(secret)); assert.notEqual(foreign,previous); assert.notEqual(account,firstAccount)
  assert.equal(calls,7); foreign=''; mode='tools'
  for (const path of ['/v1/chat/completions','/v1/responses','/v1/messages']) for (const stream of [false,true]) {
    const text=`BEFORE ${secret} AFTER`; const body={model,stream,max_tokens:128,...(path.endsWith('responses')?{input:text}:{messages:[{role:'user',content:text}]})}
    const response=await call(path,body); const output=await response.text(); assert.equal(response.status,200,`tool ${path} ${stream}`); assert.ok(output.includes(secret),`tool restoration ${path} ${stream}`); assert.ok(!output.includes(previous),`token visible ${path} ${stream}`)
  }
  const expectedCalls=calls
  for (const bad of [{model:secret,messages:[{role:'user',content:secret}]}, {model,messages:[{role:'user',content:[{type:'image',source:{type:'base64',data:'ZmFrZQ=='}}]}]}, {model,metadata:{[secret]:'bad'},messages:[]}]) {
    const response=await call('/v1/chat/completions',bad); assert.equal(response.status,400); assert.ok(!(await response.text()).includes(secret))
  }
  assert.equal(calls,expectedCalls); await inspect(home); assert.ok(!logs.includes(secret))
  const scoped=await ok('/api/keys',{name:'privacy-scope',allowedModels:['scope-only-other-model']},'POST',auth); const scopedHeaders={authorization:`Bearer ${scoped.created.key}`}; await ok('/api/privacy',{enabled:false},'PUT',auth); const deniedBaseline=await call('/v1/chat/completions',{model,messages:[{role:'user',content:'ordinary fixture'}]},'POST',scopedHeaders); assert.ok([403,404].includes(deniedBaseline.status)); await ok('/api/privacy',{enabled:true},'PUT',auth); const forbidden=await call('/v1/chat/completions',{model,messages:[{role:'user',content:`BEFORE ${secret} AFTER`}]},'POST',scopedHeaders); assert.equal(forbidden.status,deniedBaseline.status); assert.equal(calls,expectedCalls)
  mode='echo'; for(const protocol of ['anthropic','responses']) {
    const wire=await ok('/api/custom-providers',{name:`Privacy ${protocol}`,protocol,baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,keyGroups:[{id:'wire',enabled:true,apiKeys:['fixture-upstream-wire'],models:['wire-safe']}]}); const name=`Privacy-${protocol}`; const groups=await ok('/api/routing/groups'); await ok('/api/routing/groups',{revision:groups.newRevision,id:name,group:{id:name,model:name,name,enabled:true,strategy:'order',sticky:'off',members:[{id:'source',provider:wire.provider.id,model:'wire-safe',included:true,accountScope:'all',accounts:[]}]}},'PUT')
    for(const stream of [false,true]) { const wireResponse=await call('/v1/chat/completions',{model:name,stream,messages:[{role:'user',content:`BEFORE ${secret} AFTER`}]}); assert.equal(wireResponse.status,200,`wire ${protocol} ${stream}`); assert.ok((await wireResponse.text()).includes(secret),`wire restored ${protocol} ${stream}`) }
  }
  mode='idle'; const controller=new AbortController(); const pending=new Promise(resolve=>{idleSeen=resolve}); const closed=new Promise(resolve=>{idleClosed=resolve}); const streaming=fetch(base+'/v1/chat/completions',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:JSON.stringify({model,stream:true,messages:[{role:'user',content:`BEFORE ${secret} AFTER`}]}),signal:controller.signal}).then(res=>res.text()).catch(()=>null)
  await Promise.race([pending,wait(3000).then(()=>{throw Error('idle stream did not start')})]); controller.abort(); await streaming; await Promise.race([closed,wait(3000).then(()=>{throw Error('idle upstream still connected after cancellation')})]); idleSeen=idleClosed=null
  mode='plaintext'; for(const stream of [false,true]) { const returned=await call('/v1/chat/completions',{model,stream,messages:[{role:'user',content:`BEFORE ${secret} AFTER`}]}); assert.equal(returned.status,200); await returned.text(); await wait(170); await inspect(home); assert.ok(!logs.includes(secret)) }
  mode='error'; const rejected=await call('/v1/chat/completions',{model,messages:[{role:'user',content:`BEFORE ${secret} AFTER`}]}); assert.ok(!rejected.ok); assert.ok(!(await rejected.text()).includes(secret)); await wait(200); await inspect(home); assert.ok(!logs.includes(secret),'upstream diagnostics must not leak')
  mode='streamError'; const erroredStream=await call('/v1/chat/completions',{model,stream:true,messages:[{role:'user',content:`BEFORE ${secret} AFTER`}]}); assert.ok(!(await erroredStream.text()).includes(secret)); await wait(200); await inspect(home); assert.ok(!logs.includes(secret),'stream diagnostics must not leak')
  const password=randomUUID(); const backup=await call('/api/backup/download',{password,includeLogs:true},'POST',auth); assert.equal(backup.status,200); const archive=Buffer.from(await backup.arrayBuffer()); assert.ok(!archive.includes(Buffer.from(secret)))
  const db=new DatabaseSync(await findDb(home)); const stored=JSON.parse(db.prepare("SELECT value FROM kv WHERE key='privacyRedaction'").get().value); assert.deepEqual(Object.keys(stored).sort(),['enabled','rulesEnc','version']); assert.ok(stored.rulesEnc.startsWith('enc1:'))
  await inspectRestored(archive,password,stored.rulesEnc)
  db.prepare("UPDATE kv SET value=? WHERE key='privacyRedaction'").run(JSON.stringify({...stored,rulesEnc:'enc1:broken'})); db.close()
  const before=calls; const failed=await call('/v1/chat/completions',{model,messages:[{role:'user',content:`BEFORE ${secret} AFTER`}]}); assert.equal(failed.status,503); assert.equal(calls,before); assert.ok(!(await failed.text()).includes(secret))
  console.log('PASS private admin settings, three protocols x stream/aggregate x text/tools, request-scoped mapping, corrupted configuration closed, debug files/database/log confidentiality')
} finally { if (child.exitCode===null) child.kill(); await exited; await new Promise(resolve=>upstream.close(resolve)); await rm(home,{recursive:true,force:true,maxRetries:3}) }
