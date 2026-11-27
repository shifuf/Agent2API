import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const executable = path.resolve(process.argv[2]), home = await mkdtemp(path.join(os.tmpdir(), 'sync360-image-auth-'))
const provider = 'isolated-image-engine', model = 'Public/Image', wire = 'Internal-Pixels'
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
const calls = [], admin = 'image-fixture-admin'
const privateFailure = 'private-fixture-diagnostic-marker'
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}` }
const relay = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  calls.push({ path: req.url, body: JSON.parse(raw), account: req.headers.authorization });
  if(calls.at(-1).body.prompt===privateFailure){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:privateFailure}}));return}
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ created: 1, data: [{ b64_json: pixel }] }))
})
const relayUrl = await listen(relay), reserved = http.createServer(), base = await listen(reserved)
await new Promise(resolve => reserved.close(resolve))
const pack = 'sync-image-fixture', packDir = path.join(home, 'plugins', pack, '1.0.0'), script = path.join(packDir, 'fixture.cjs')
const entry = process.platform === 'win32' ? 'fixture.exe' : 'fixture'
const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${({ win32: 'pc-windows-msvc', linux: 'unknown-linux-gnu', darwin: 'apple-darwin' })[process.platform]}`
const providers = [{ id: provider, label: 'Isolated fixture' }]
await mkdir(packDir, { recursive: true }); await copyFile(process.execPath, path.join(packDir, entry))
await writeFile(path.join(packDir, 'pack.json'), JSON.stringify({ id: pack, name: pack, version: '1.0.0', protocol: 1, providers, entry: { [triple]: entry } }))
await writeFile(path.join(home, 'plugins', 'plugins.json'), JSON.stringify({ packs: [{ id: pack, version: '1.0.0', enabled: true, providers: { [provider]: true }, entry, manifest_providers: providers }] }))
await writeFile(script, `const readline=require('node:readline'),models=[{id:${JSON.stringify(wire)},kind:'image',supports_image_generation:true,supports_image_editing:true}];
readline.createInterface({input:process.stdin}).on('line',line=>{const frame=JSON.parse(line),p=frame.params||{};let result=null;switch(frame.method){
case 'init':result=[{id:${JSON.stringify(provider)},label:'Isolated fixture',capabilities:{chat:true},default_models:models}];break;
case 'images.capabilities':result={generation:true,editing:true};break;case 'models.list':result=models;break;
case 'account.normalize':result={identity:'fixture-owner',secret:{token:'fixture'},public:{name:'fixture',hasCredentials:true},desktop:false};break;
case 'token.ensure':result='fixture';break;case 'images.generate':case 'images.edit':result={url:${JSON.stringify(relayUrl)}+(frame.method==='images.edit'?'/edits':'/generations'),headers:[['Authorization','Bearer '+p.account],['Content-Type','application/json']],body:p.body,response:'openai'};break;
case 'classify_error':result={kind:'fatal',status:p.status,message:${JSON.stringify(privateFailure)},reset_at:null,upstream_code:null};break;
case 'is_error_response':result=p.status>=400;break;case 'retry.decision':result={action:'default'};break;case 'error.policy':result={};break;
case 'shutdown':process.exit(0);}process.stdout.write(JSON.stringify({id:frame.id,result})+'\\n');}).on('close',()=>process.exit(0));`)
const profile = path.join(home, 'isolated-client'), gemini = path.join(profile, '.gemini', 'settings.json')
await mkdir(path.dirname(gemini), { recursive: true }); await writeFile(gemini, '{}')
const start = () => spawn(executable, [], { cwd: home, windowsHide: true, stdio: 'ignore', env: { ...process.env, USERPROFILE: profile, HOME: profile, GEMINI_CLI_HOME: profile,
  AGENT2API_UI_DIR: path.resolve(import.meta.dirname, '../desktop-tauri/ui'),
  CODEX_HOME: path.join(profile, '.codex'), NODE_OPTIONS: `--require=${JSON.stringify(script)}`,
  AGENT2API_PROXY_HOME: home, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: new URL(base).port, AGENT2API_ACCOUNT_KEY: '7'.repeat(64),
  AGENT2API_PROXY_API_KEY: admin, AGENT2API_CAPTCHA_ENABLED: '0', AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0',
  AGENT2API_PANEL_PORT: '', AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' } })
let child = start(), exited = once(child, 'exit'); const configPath = '/api/tools/image-generation/config', mcp = '/mcp/image-generation'
let session
async function send(route, body, key, method = body ? 'POST' : 'GET') {
  const auth = key ? { authorization: `Bearer ${key}` } : session ? { 'x-panel-token': session } : {}
  return fetch(base + route, { method, headers: { ...auth, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000), ...(body ? { body: JSON.stringify(body) } : {}) })
}
async function ok(route, ...args) { const response = await send(route, ...args); const text = await response.text(); assert.equal(response.status, 200, `${route}: ${text.slice(0, 200)}`); const value = JSON.parse(text); return value.success && Object.hasOwn(value, 'data') ? value.data : value }
async function tool(name, args, key, reject = false) {
  const response = await send(mcp, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, key)
  const data = await response.json(); if (reject) { assert(response.status >= 400 || data.error || data.result?.isError, `${name} unexpectedly allowed`); return data.result?.structuredContent }
  assert.equal(response.status, 200); assert(!data.error && !data.result?.isError, JSON.stringify(data)); return data.result.structuredContent
}
async function browserCheck() {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright'); const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless:true })
  try { for (const mobile of [false, true]) {
    const context = await browser.newContext({locale:'zh-CN', viewport: mobile ? { width:390,height:844 } : { width:1365,height:900 },isMobile:mobile,hasTouch:mobile})
    try {
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue({headers:{...route.request().headers(),'x-panel-token':session}}) : route.abort()); await isolateUpdateNotice(context)
      await context.addInitScript(key => { localStorage.setItem('agent2api.webKey',key); localStorage.setItem('agent2api.webKey.origin',key) },admin)
      const page = await context.newPage(); const open = async () => { await page.goto(mobile ? base+'/m#tools' : base)
        if (!mobile) { await page.locator('.nav-item[data-page="tools"]').click(); await page.getByRole('row').filter({hasText:'图片生成与编辑'}).first().getByRole('button',{name:'详情',exact:true}).click() }
        return page.locator('form').filter({has:page.getByLabel('图片生成路由组',{exact:true})}) }
      const form = await open(), hours = mobile ? '3' : '4'; await form.getByLabel('每次最多生成图片数').waitFor(); assert.equal(await form.getByLabel('图片生成路由组',{exact:true}).inputValue(),model)
      await form.getByLabel('保留时间（小时）').fill(hours); await Promise.all([page.waitForResponse(r=>r.url().endsWith(configPath)&&r.request().method()==='PUT'&&r.ok()),form.getByRole('button',{name:'保存',exact:true}).click()]);
      const reloaded = await open(); assert.equal(await reloaded.getByLabel('保留时间（小时）').inputValue(),hours)
    } finally { await context.close() }
  } } finally { await browser.close() }
  console.log('PASS desktop and mobile image route group settings persist')
}
try {
  let ready = false
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) { try { if ((await fetch(base + '/health')).ok) { ready = true; break } } catch {} await delay(150) }
  assert(ready); session = (await ok('/api/panel/setup?auth-mode=body', { username: 'fixture', password: 'fixture-password-123' })).accessToken
  assert(session); await ok(configPath)
  let loaded = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const plugins = await ok('/api/plugins'); loaded = plugins.packs.some(item => item.id === pack && item.providers.some(candidate => candidate.loaded))
    if (loaded) break
    await delay(200)
  }
  assert(loaded, 'isolated fixture plugin did not finish loading')
  const account = (await ok('/api/accounts', { provider, name: 'fixture' })).account.id
  await ok('/api/routing/groups', { id: 'fixture-image-group', revision: (await ok('/api/routing/groups')).newRevision, group: { id: 'fixture-image-group', name: 'fixture', kind: 'image', model, enabled: true, strategy: 'order', sticky: 'off',
    members: [{ id: 'fixture-image', provider, model: wire, included: true, accountScope: 'selected', accounts: [account] }] } }, null, 'PUT')
  const createKey = async (name, allowedModels) => (await ok('/api/keys', { name, key: `${name}-image-fixture`, allowedProviders: [provider], allowedModels })).created.key
  const owner = await createKey('owner', [model]), peer = await createKey('peer', [model])
  const config = { generation: { model }, editing: { model }, max_images: 1, max_concurrency: 1, retention_hours: 2, storage_mb: 64 }
  assert([401, 403].includes((await send(configPath, config, owner, 'PUT')).status)); await ok(configPath, config, null, 'PUT')
  const args = { request_id: 'submission-pixels-001', prompt: 'One white fixture pixel.', wait_seconds: 10 }
  await ok('/api/tools/servers/image-generation', { protocol: 'mcp', enabled: true }, null, 'PATCH')
  if (process.argv.includes('--browser')) await browserCheck()
  const targets = (await ok('/api/tools/install-targets?service=image-generation&protocol=mcp')).targets
  assert.equal(path.resolve(targets.find(row => row.key === 'gemini-cli').path), path.resolve(gemini))
  const keyId = (await ok('/api/tools/api-keys')).keys.find(key => key.name === 'owner').id
  const installs = (await ok('/api/tools/install-mcp', { service_id:'image-generation',mode:'bridge',api_key_id:keyId,clients:['gemini-cli'] })).results; assert.equal(installs[0].ok,true)
  assert([401,403].includes((await send('/api/tools/uninstall-mcp',{service_id:'image-generation',clients:['gemini-cli']},owner)).status))
  const bridge = JSON.parse(await readFile(gemini, 'utf8')).mcpServers['agent2api-image-generation']; assert.equal(bridge.command,'node'); assert.equal(bridge.env.AGENT2API_IMAGE_ENDPOINT,base+mcp); assert.equal(bridge.env.AGENT2API_IMAGE_KEY,owner)
  assert(!path.relative(home,bridge.args[0]).startsWith('..')); assert.equal(await (await send('/api/tools/mcp-bridge/image-generation.cjs')).text(),await readFile(bridge.args[0],'utf8'))
  const client = spawn(process.execPath, bridge.args, { cwd:profile, windowsHide:true, env:{...process.env,...bridge.env},stdio:['pipe','pipe','pipe'] }); const closed = once(client,'close'); let output=''; client.stdout.on('data',chunk=>{output+=chunk}); client.stdin.end(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list'})+'\n'); await closed; assert(JSON.parse(output).result.tools.some(item=>item.name==='edit_images'))
  const excluded = await createKey('excluded',['Some/Other']); await tool('generate_images',args,excluded,true); assert.equal(calls.length,0)
  await ok('/api/debug',{debugMode:true},null,'PUT')
  await ok('/api/retry',{retryCount:0,retryCrossProviderCount:0,retryIntervalSeconds:0,noRetryStatusCodes:[400]},null,'PUT')
  const job = await tool('generate_images', args, owner); assert.equal(job.status, 'succeeded'); assert(job.job_id); assert.equal(calls.length, 1); assert.equal(calls[0].body.model, wire)
  assert(!Object.keys(job).some(key => ['actual_account_id','actual_account_name','actual_provider','actual_model'].includes(key)))
  assert.equal((await tool('generate_images', args, owner)).job_id, job.job_id); assert.equal(calls.length, 1)
  await tool('get_image_result', { job_id: job.job_id }, peer, true)
  const file = new URL(job.images[0].url, base); assert.equal(file.origin, base)
  assert.equal((await send(file.pathname, undefined, peer)).status, 404); assert.equal((await send(file.pathname, undefined, owner)).status, 200)
  const edit = { request_id: 'submission-edit-001', prompt: 'Keep this pixel.', images: [job.images[0].ref], wait_seconds: 10 }
  await tool('edit_images', edit, peer, true); assert.equal(calls.length, 1)
  assert.equal((await tool('edit_images', edit, owner)).status, 'succeeded'); assert.equal(calls.at(-1).path, '/edits')
  const failed=await tool('generate_images',{...args,request_id:'failure-pixels-001',prompt:privateFailure},owner,true);assert.equal(failed.status,'failed');assert(!JSON.stringify(failed).includes(privateFailure))
  const before = calls.length
  const rows = JSON.stringify(await ok('/api/stats/requests?limit=100')); assert(!rows.includes(pixel) && !rows.includes(args.prompt) && !rows.includes(privateFailure))
  for (const id of [job.job_id,failed.job_id]) { assert.equal((await send('/api/stats/requests/raw?id='+id)).status,404);assert.equal((await send('/api/debug/traffic?id='+id)).status,404) }
  child.kill(); await exited; child=start(); exited=once(child,'exit'); for (let n=0;n<100;n++) { try { if ((await fetch(base+'/health')).ok) break } catch {} await delay(200) }
  for (let n=0;n<100;n++) { if ((await ok('/api/plugins')).packs.some(item=>item.id===pack && item.providers.some(candidate=>candidate.loaded))) break; await delay(200) }
  assert.equal((await send(file.pathname,undefined,owner)).status,404); const expired = await tool('get_image_result',{job_id:job.job_id},owner,true); assert.equal(expired.status,'expired'); assert.equal((await tool('generate_images',args,owner,true)).status,'expired'); assert.equal(calls.length,before)
  await ok(`/api/accounts/${account}`, { enabled: false }, null, 'PATCH')
  await tool('generate_images', { ...args, request_id: 'disabled-source-001' }, owner, true); assert.equal(calls.length, before)
  console.log('PASS image MCP: isolated real install and stdio bridge, scoped generation/edit, owner-only results, restart deduplication, no raw stats, disabled group member')
} finally { child.kill(); await exited; await new Promise(resolve => relay.close(resolve)); await rm(home, { recursive: true, force: true, maxRetries: 4 }) }
