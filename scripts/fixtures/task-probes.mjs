import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const catalog='/api/task-plugins', id='status-fixture', host='service.example', endpoint=`https://${host}/health`, route=`${catalog}/${id}/permissions`
const grants={[host]:endpoint}
const plugin={id,name:'Status fixture',domains:[host],scriptBody:`async function onSchedule(ctx) { await ctx.http.status(${JSON.stringify(host)}); }`}
const current=async call=>(await call(catalog)).plugins.find(item=>item.id===id)
const authorize=async (call,networkGrants,changes={})=>call(route,'POST',{networkGrants,expectedUpdatedAt:(await current(call)).updatedAt,...changes})

export async function verifyProbeGrants(call) {
  const installed=(await call(catalog,'POST',{...plugin,networkGrants:grants})).plugin
  assert.deepEqual(installed.networkGrants,{},'declaring or importing domains cannot grant the network')
  for(const domain of ['*','*.example.org','localhost','127.0.0.1','0x7f.0.0.1','bad.example:443','https://valid.example/','bad..example']) {
    await call(catalog,'POST',{...plugin,id:'bad-probe',domains:[domain]},400)
  }
  await call(route,'POST',{networkGrants:grants},400)
  for (const url of ['http://service.example/','https://wrong.example/','https://service.example:444/','https://user@service.example/','https://service.example/path?secret=value','https://service.example/#fragment']) {
    await call(route,'POST',{expectedUpdatedAt:installed.updatedAt,networkGrants:{[host]:url}},400)
  }
  const job=(await call('/api/task-jobs','POST',{pluginId:id,name:'Probe',cronExpression:'0 0 1 1 *',timezone:'UTC',enabled:false})).job
  await call(route,'POST',{enabled:true})
  const run=async()=>(await call(`/api/task-jobs/${job.id}/run`,'POST',{})).outcome
  assert.equal((await run()).success,false,'script cannot spend an ungranted capability')
  const granted=(await authorize(call,grants)).plugin
  assert.deepEqual(granted.networkGrants,grants)
  const proxy=http.createServer((req,res)=>res.writeHead(502).end()); let contacts=0
  proxy.on('connection',socket=>{ contacts++; socket.destroy() }); proxy.listen(0,'127.0.0.1'); await once(proxy,'listening')
  try {
    const name='Fixed status proxy fixture', pool=await call('/api/proxies/pool','POST',{name,protocol:'http',host:'127.0.0.1',port:proxy.address().port,enabled:true})
    const proxyId=pool.items.find(item=>item.name===name).id
    await call(`/api/task-jobs/${job.id}`,'PUT',{proxyId})
    for(const enabled of [true,false]) {
      if(!enabled) await call('/api/proxies/pool/enable','POST',{id:proxyId,enabled:false})
      const blocked=await run(); assert.equal(blocked.success,false); assert.match(blocked.error,/代理.*未直连/)
    }
    assert.equal(contacts,0,'unsupported proxy must never receive the target name or any HTTP request')
    await call(`/api/task-jobs/${job.id}`,'PUT',{proxyId:'direct'})
  } finally { await new Promise(resolve=>proxy.close(resolve)) }
  assert.equal((await call(catalog+'/preview','POST',{plugin})).outcome.success,false,'preview cannot inherit the real plugin grant')
  const disabled=(await call(route,'POST',{enabled:false})).plugin
  assert.deepEqual(disabled.networkGrants,{})
  await call(route,'POST',{enabled:true,networkGrants:grants,expectedUpdatedAt:granted.updatedAt},400)
  await authorize(call,grants,{enabled:true})
  const edited=(await call(`${catalog}/${id}`,'PUT',{...plugin,networkGrants:grants})).plugin
  assert.equal(edited.enabled,false); assert.deepEqual(edited.networkGrants,{})
  await authorize(call,grants,{enabled:true})
  const exported=await call(`${catalog}/${id}/script`)
  assert.ok(!exported.rawScript.includes(endpoint),'export never includes administrator-granted paths')
}

export async function verifyRestoredProbe(call) {
  const restored=await current(call)
  assert.equal(restored.enabled,false)
  assert.deepEqual(restored.networkGrants,{},'restore requires fresh network consent')
}

export async function verifyNoDisabledReplay(call,db) {
  const sleeping={...plugin,id:'no-catchup',name:'Disabled replay fixture',scriptBody:'function onSchedule(){return 1}'}
  const installed=(await call(catalog,'POST',sleeping)).plugin
  const job=(await call('/api/task-jobs','POST',{pluginId:sleeping.id,name:'Skip while disabled',cronExpression:'0 0 1 1 *',timezone:'UTC',enabled:true})).job
  db.prepare('UPDATE task_jobs SET next_run_at=? WHERE id=?').run(Date.now()-30000,job.id)
  await call(`${catalog}/${sleeping.id}/permissions`,'POST',{enabled:true,networkGrants:grants,expectedUpdatedAt:installed.updatedAt})
  for(let attempt=0;attempt<70;attempt++) {
    const current=(await call('/api/task-jobs')).jobs.find(item=>item.id===job.id)
    if(current.nextRunAt>Date.now())break
    assert.ok(attempt<69,'scheduler must advance the expired time'); await delay(100)
  }
  await delay(150)
  assert.deepEqual((await call(`/api/task-jobs/${job.id}/runs`)).runs,[],'re-enabling and granting must not replay a time missed while disabled')
}

export async function verifyProbePanel(page,pane,call) {
  const card=pane.locator(`[data-probe-plugin="${id}"]`)
  const input=card.locator('input[type=url]')
  await input.fill(endpoint)
  const click=async locator=>{
    const [response]=await Promise.all([page.waitForResponse(response=>response.url().endsWith(route) && response.request().method()==='POST'),locator.click()]); assert.equal(response.status(),200)
  }
  await click(card.locator('[data-probe-grant]')); assert.deepEqual((await current(call)).networkGrants,grants)
  await click(card.locator('[data-probe-revoke]')); assert.deepEqual((await current(call)).networkGrants,{})
}
