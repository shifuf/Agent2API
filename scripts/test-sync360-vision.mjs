import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

process.env.AGENT2API_UI_DIR = path.resolve(import.meta.dirname, '../desktop-tauri/ui')

const home = await mkdtemp(path.join(os.tmpdir(), 'a2-vision-')), calls = [], endpoint = '/api/vision-compatibility'
const source = 'Public/Text', target = 'Public/Vision', unrelated = 'Another/Text', admin = 'vision-fixture-admin'
let hold
const relay = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); calls.push(body)
  if (hold && body.model === 'Wire-1') await hold.promise
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: body.model === 'Wire-1' ? 'fixture vision' : 'original answer' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens:10,completion_tokens:5,total_tokens:15 } })}\n\ndata: [DONE]\n\n`) })
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}` }
const upstream = await listen(relay), reserved = http.createServer(), base = await listen(reserved); await new Promise(resolve => reserved.close(resolve))
const child = spawn(path.resolve(process.argv[2]), [], { cwd: home, windowsHide: true, stdio: ['ignore','ignore','pipe'], env: { ...process.env, AGENT2API_PROXY_HOME: home, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: new URL(base).port, AGENT2API_ACCOUNT_KEY: '8'.repeat(64), AGENT2API_PROXY_API_KEY: admin, AGENT2API_CAPTCHA_ENABLED: '0', AGENT2API_SELF_UPDATE: '0', AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' } }); const exited = once(child, 'exit'); let session,diagnostics='';child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-2048)})
async function send(route, body, key, method = body ? 'POST' : 'GET') { const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : session ? { 'x-panel-token': session } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).catch(error=>{throw Error(`${method} ${route} (${body?.model||''}): ${error.cause?.code||error.message}; server exit ${child.exitCode}; ${diagnostics.split('\n').filter(line=>/panic|overflow|abort/i.test(line)).join(' ').slice(0,200)}`)}); const text = await res.text(); let data; try { data = JSON.parse(text) } catch { data = text.slice(0, 170) } return [res.status, data?.success && Object.hasOwn(data, 'data') ? data.data : data] }
async function ok(...args) { const [status, data] = await send(...args); assert.equal(status, 200, `${args[0]} ${JSON.stringify(data).slice(0, 350)}`); return data }
async function browserCheck() {
  const { chromium }=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright'), browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE,headless:true})
  try { for (const mobile of [false,true]) { const context=await browser.newContext({locale:'zh-CN',viewport:mobile?{width:390,height:844}:{width:1365,height:900},isMobile:mobile,hasTouch:mobile});
    try { await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue({headers:{...route.request().headers(),'x-panel-token':session}}):route.abort()); await isolateUpdateNotice(context);
      await context.addInitScript(key=>{localStorage.setItem('agent2api.webKey',key);localStorage.setItem('agent2api.webKey.origin',key)},admin)
      const page=await context.newPage(); const open=async()=>{await page.goto(mobile?base+'/m#routing':base);if(!mobile)await page.locator('.nav-item[data-page="routing"]').click();await page.getByRole('button',{name:'视觉辅助',exact:true}).click();return page.getByRole('dialog',{name:'视觉辅助'})}
      const dialog=await open(); await dialog.getByLabel('视觉目标组').selectOption(target); const choice=dialog.getByRole('checkbox',{name:unrelated,exact:true}); await choice.setChecked(!mobile)
      await Promise.all([page.waitForResponse(response=>response.url().endsWith(endpoint)&&response.request().method()==='PUT'&&response.ok()),dialog.getByRole('button',{name:'保存',exact:true}).click()]); const reloaded=await open(); assert.equal(await reloaded.getByRole('checkbox',{name:unrelated,exact:true}).isChecked(),!mobile)
    } finally {await context.close()} } } finally {await browser.close()}
  console.log('PASS desktop/mobile visual-assistance group selection and reload')
}
try {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(base + '/health')).ok) break } catch {} await delay(160) }
  session = (await ok('/api/panel/setup?auth-mode=body', { username: 'fixture', password: 'fixture-password-123' })).accessToken
  await ok(endpoint)
  const channels = []
  for (const [index, model] of [source, target, unrelated].entries()) {
    const wire = `Wire-${index}`; const channel = (await ok('/api/custom-providers', { name: `Vision fixture ${index}`, protocol: 'chat_completions', baseUrl: upstream + '/v1', keyGroups: [{ id: 'one', enabled: true, apiKeys: [`relay-${index}`], models: [wire] }] })).provider.id; channels.push(channel)
    await ok('/api/custom-providers/models', { providerId:channel,models:[{id:wire,enabled:true,capabilities:{supportsImages:index===1}}],mappings:[] })
    await ok('/api/routing/groups', { id: `vg-${index}`, revision: (await ok('/api/routing/groups')).newRevision, group: { id: `vg-${index}`, model, name: model, enabled: true, strategy: 'order', sticky: 'off', members: [{ id: `member-${index}`, provider: channel, model: wire, included: true, accountScope: 'all', accounts: [] }] } }, null, 'PUT')
  }
  const mixed='Public/Mixed';await ok('/api/routing/groups',{id:'mixed',revision:(await ok('/api/routing/groups')).newRevision,group:{id:'mixed',name:'mixed',model:mixed,enabled:true,strategy:'order',sticky:'off',members:[0,1].map(index=>({id:`mix-${index}`,provider:channels[index],model:`Wire-${index}`,included:true,accountScope:'all',accounts:[]}))}},null,'PUT')
  const cfg = { enabled: true, sources: [source,mixed], target }; await ok(endpoint, cfg, null, 'PUT')
  if(process.argv.includes('--browser')) await browserCheck()
  await ok('/api/model-pricing', {currency:'usd',modelPrices:{'*/wire-0':{input:10,output:10},'*/wire-1':{input:20,output:20}}},null,'PUT')
  const privateWord='fixture-secret-vision'; await ok('/api/privacy',{enabled:true,words:[privateWord]},null,'PUT')
  const key = async (name, allowedModels, allowedProviders = channels) => (await ok('/api/keys', { name, key: `${name}-vision-fixture`, allowedModels, allowedProviders })).created.key
  const full = await key('full', [source, target, unrelated,mixed]); const sourceOnly = await key('source', [source]); const targetOnly = await key('dest',[target]);const partial = await key('partial', [source, target], [channels[0]])
  assert([401, 403].includes((await send(endpoint, cfg, full, 'PUT'))[0])); assert.equal((await send(endpoint, { ...cfg, target: source }, null, 'PUT'))[0], 400)
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' } }
  const chat = (model, vision = true, question = 'Describe') => ({ model, messages: [{ role: 'user', content: vision ? [{ type: 'text', text: question }, image] : 'Hello' }] })
  assert.equal((await send('/v1/chat/completions',chat(source,true,privateWord),full))[0],400);assert.equal(calls.length,0)
  await ok('/api/privacy',{enabled:false,words:[privateWord]},null,'PUT')
  await ok('/v1/chat/completions', chat(source, false), full); assert.equal(calls.at(-1).model, 'Wire-0')
  await ok('/v1/chat/completions', chat(target), full); assert.equal(calls.at(-1).model, 'Wire-1'); let before = calls.length
  await ok('/v1/chat/completions', chat(mixed), full);assert.equal(calls.length,before+1);assert.equal(calls.at(-1).model,'Wire-1');before=calls.length
  const overview=async()=>(await ok('/api/stats/summary?range=all')).overview, initial=await overview()
  const answer=await ok('/v1/chat/completions', chat(source), full); assert.equal(answer.choices[0].message.content,'original answer'); assert.equal(calls.length, before + 2); assert.equal(calls.at(-2).model, 'Wire-1'); assert.equal(calls.at(-1).model, 'Wire-0'); assert(!JSON.stringify(calls.at(-1)).includes('data:image/')); assert(JSON.stringify(calls.at(-1)).includes('fixture vision')); assert.deepEqual(calls.at(-2).messages.at(-1).content[0], image); assert(!JSON.stringify(calls).includes(privateWord))
  let rows=[],parent,childEntry; for(let attempt=0;attempt<60;attempt++) {rows=(await ok('/api/stats/requests?limit=100')).entries;parent=rows.find(item=>item.route?.visionRoute);childEntry=rows.find(item=>item.route?.visionParent===parent?.id&&item.route?.visionParent);if(parent&&childEntry)break;await delay(120)}
  assert(parent && childEntry); assert.equal(parent.route.visionRoute.childId,childEntry.id);assert.equal(parent.apiKeyName,'full');assert.equal(childEntry.apiKeyId,parent.apiKeyId);assert.equal(childEntry.client,parent.client);assert.equal(parent.costUsd,0.00015);assert.equal(childEntry.costUsd,0.00030)
  const final=await overview(); assert.equal(final.requests-initial.requests,1);assert.equal(final.auxiliaryRequests-initial.auxiliaryRequests,1);assert(Math.abs(final.costUsd-initial.costUsd-0.00045)<1e-10)
  for(const [route, body] of [['/v1/responses',{model:source,input:[{role:'user',content:[{type:'input_text',text:'Describe'},{type:'input_image',image_url:image.image_url.url}]}]}],['/v1/messages',{model:source,max_tokens:100,messages:[{role:'user',content:[{type:'text',text:'Describe'},{type:'image',source:{type:'base64',media_type:'image/png',data:image.image_url.url.split(',')[1]}}]}]}]]){before=calls.length;await ok(route,body,full);assert.equal(calls.length,before+2);assert.equal(calls.at(-2).model,'Wire-1');assert.equal(calls.at(-1).model,'Wire-0');assert(!JSON.stringify(calls.at(-1)).includes('data:image/'))}
  rows=(await ok('/api/stats/requests?limit=100')).entries;before = calls.length; for (const denied of [sourceOnly, targetOnly, partial]) assert((await send('/v1/chat/completions', chat(source), denied))[0] >= 400)
  assert((await send('/v1/chat/completions', chat(unrelated), full))[0] >= 400); assert.equal(calls.length, before)
  hold=Promise.withResolvers();const pending=send('/v1/chat/completions',chat(source),full);let running;
  try {for(let attempt=0;attempt<80;attempt++){const list=(await ok('/api/stats/requests?limit=100')).entries;running=list.find(item=>item.route?.visionRoute&&!rows.some(previous=>previous.id===item.id));if(running&&calls.length>before)break;await delay(150)} assert(running,'active parent missing');await ok('/api/stats/requests/terminate?id='+encodeURIComponent(running.id),{}); const [status]=await pending;assert(status>=400)}finally{hold.resolve();hold=undefined}await delay(250);assert.equal(calls.length,before+1)
  console.log('PASS native vision, authorized description followed by original text model, non-image source passthrough, missing permissions and self-cycle rejection')
} finally { child.kill(); await exited; await new Promise(resolve => relay.close(resolve)); await rm(home, { recursive: true, force: true, maxRetries: 4 }) }
