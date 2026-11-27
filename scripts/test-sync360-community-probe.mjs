import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as wait} from 'node:timers/promises'
import {gzipSync} from 'node:zlib'
import {createFixturePanelSession} from './fixtures/panel-session.mjs'

const home=await mkdtemp(path.join(os.tmpdir(),'community-probe-')),key=randomUUID(),listener=http.createServer().listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(done=>listener.close(done));const base=`http://127.0.0.1:${port}`,kind=process.argv.includes('--guest');
const env={...process.env,AGENT2API_PROXY_HOME:home,AGENT2API_PROXY_PORT:String(port),AGENT2API_HOST:'127.0.0.1',AGENT2API_PROXY_API_KEY:key,AGENT2API_CAPTCHA_ENABLED:'0',AGENT2API_SELF_UPDATE:'0',AGENT2API_WINDOWS_UPDATE:'0'};for(const item of ['AGENT2API_PANEL_PORT','AGENT2API_ADMIN_USER','AGENT2API_ADMIN_PASSWORD','AGENT2API_ADMIN_PASSWORD_HASH'])delete env[item];if(!kind)delete env.AGENT2API_COMMUNITY_GUEST_DIR;
const server=spawn(path.resolve(process.argv[2]),[],{env,cwd:home,windowsHide:true,stdio:'ignore'}),ended=once(server,'exit');let admin={};
function pack(name,source,version){
  const chunks=[],manifest={name,version,main:'index.mjs',scripts:{install:'exit 1'}};
  for(const [file,content] of [['package/package.json',JSON.stringify(manifest)],['package/index.mjs',source]]){
    const text=Buffer.from(content),header=Buffer.alloc(512);header.write(file);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
    header.write(text.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header.write('0',156);header.write('ustar\0',257);header.write('00',263);
    header.write([...header].reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148);chunks.push(header,text,Buffer.alloc((512-text.length%512)%512));
  }
  const bytes=gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));return {sha256:createHash('sha256').update(bytes).digest('hex'),archive:bytes.toString('base64'),retain:true};
}
const probe='/api/plugins/community/probe',archives='/api/plugins/community/archives';
const request=(endpoint,body,headers=admin,signal=AbortSignal.timeout(340000))=>fetch(base+endpoint,{method:body?'POST':'GET',headers:{...headers,'content-type':'application/json'},body:body&&JSON.stringify(body),signal});
async function retain(name,source,previousSha256,version='1.0.0'){const packed=pack(name,source,version);assert.equal((await request('/api/plugins/community/inspect',{...packed,previousSha256})).status,200);return{name,sha256:packed.sha256}}
async function state(endpoint){const response=await request(endpoint);assert.equal(response.status,200);return (await response.json()).data}
async function pluginState(){
  const snapshot=await state('/api/plugins'),registry={};for(const field of ['packs','adminPanels','accountFeatures','providerDocs']){assert.ok(Object.hasOwn(snapshot,field));registry[field]=snapshot[field]}
  return {registry,policy:await state('/api/plugins/settings'),archives:await state(archives)};
}
async function probeChildren(){const threads=await readdir(`/proc/${server.pid}/task`);const result=new Set();for(const thread of threads){const children=await readFile(`/proc/${server.pid}/task/${thread}/children`,'utf8').catch(()=> '');for(const pid of children.trim().split(/\s+/).filter(Boolean)){const name=await readFile(`/proc/${pid}/comm`,'utf8').catch(()=> '');if(name.trim().startsWith('qemu-system'))result.add(pid)}}return result}
async function assertLimits(pid){
  const prefix=`/proc/${pid}/`,limits=await readFile(prefix+'limits','utf8'),cpu=Number(env.AGENT2API_COMMUNITY_GUEST_TIMEOUT_SECS??80)-15;
  assert.match(limits,new RegExp(`Max cpu time\\s+${cpu}\\s+${cpu}\\s+seconds`));
  assert.match(limits,/Max address space\s+4294967296\s+4294967296\s+bytes/);
  assert.match(limits,/Max core file size\s+0\s+0\s+bytes/);
  const argv=(await readFile(prefix+'cmdline','utf8')).split('\0');
  for(const [option,expected] of Object.entries({'-nic':'none','-monitor':'none','-smp':'1','-m':'768','-sandbox':'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny'}))assert.equal(argv[argv.indexOf(option)+1],expected);
  let status='';for(let attempt=0;attempt<60;attempt++){status=await readFile(prefix+'status','utf8');if(/^Seccomp:\s+2$/m.test(status))break;await wait(100)}
  assert.match(status,/^Seccomp:\s+2$/m);assert.match(status,/^NoNewPrivs:\s+1$/m);for(const field of ['CapEff','CapPrm','CapAmb'])assert.match(status,new RegExp(`^${field}:\\s+0+$`,'m'));
}
async function limitCase(pkg,stop){
  const start=performance.now(),wall=Number(env.AGENT2API_COMMUNITY_GUEST_TIMEOUT_SECS??80),pending=request(probe,pkg);let pid;
  for(let attempt=0;attempt<120&&!pid;attempt++){pid=[...await probeChildren()][0];if(!pid)await wait(100)}
  assert.ok(pid,'real hypervisor must be running');await assertLimits(pid);
  if(stop){
    process.kill(Number(pid),'SIGSTOP');let stopped=false;
    for(let attempt=0;attempt<50&&!stopped;attempt++){stopped=/^State:\s+T/m.test(await readFile(`/proc/${pid}/status`,'utf8'));if(!stopped)await wait(50)}
    assert.ok(stopped,'Linux must have delivered SIGSTOP before the wall watchdog is measured');
  }
  let done=false,cpuTicks=0;const observed=pending.finally(()=>{done=true});
  while(!done){const stat=await readFile(`/proc/${pid}/stat`,'utf8').catch(()=>null);if(stat){const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');cpuTicks=Math.max(cpuTicks,Number(fields[11])+Number(fields[12]))}await wait(100)}
  const response=await observed,elapsed=(performance.now()-start)/1000,cpu=cpuTicks/100;
  console.log(`LIMIT ${stop?'stopped':'running'} pid=${pid} wall=${elapsed.toFixed(1)}s CPU=${cpu.toFixed(1)}s status=${response.status}`);
  if(stop){assert.equal(response.status,504);assert.ok(elapsed>=wall-1);assert.ok(cpu<wall-15)}
  else{assert.equal(response.status,422);assert.ok(cpu>=wall-16,'actual process CPU must reach the kernel quota');assert.ok(elapsed<wall)}
  assert.equal((await probeChildren()).size,0,'resource expiration must reap the hypervisor');
}
try{
  for(let attempt=0;attempt<150;attempt++){if((await fetch(base+'/health').catch(()=>null))?.ok)break;await wait(100)}
  const session=await createFixturePanelSession(base,{username:'probe-admin',password:randomUUID()+'aA!'});admin={'x-panel-token':session.accessToken};const pkg=await retain('isolated-probe',await readFile(new URL('./fixtures/bun-guest-provider.mjs',import.meta.url),'utf8'));
  assert.equal((await request(probe,pkg,{'x-api-key':key})).status,403,'probe requires a panel admin, not a gateway key');const data=await state(archives),available=kind&&!process.argv.includes('--unavailable');assert.equal(data.executionAvailable,available);
  if(!available){assert.equal((await request(probe,pkg)).status,503);console.log('PASS missing guest, invalid budget or unsupported platform refuses retained code')}
  else {
    assert.equal((await request(probe,{...pkg,sha256:'0'.repeat(64)})).status,409);
    for(const extra of [{timeoutSecs:300},{permissions:['network']},{installed:true}])assert.equal((await request(probe,{...pkg,...extra})).status,400);
    const replacement=await retain(pkg.name,'export default {server(){return {}}}',pkg.sha256,'2.0.0');assert.equal((await state(archives)).items.find(item=>item.name===pkg.name).version,'2.0.0');
    assert.equal((await request(probe,pkg)).status,409);assert.equal((await request(archives,{...replacement,action:'rollback'})).status,200);
    assert.equal((await request(probe,replacement)).status,409);assert.equal((await state(archives)).items.find(item=>item.name===pkg.name).sha256,pkg.sha256);
    const tooLarge=await retain('large-entry','x'.repeat(256*1024+1));assert.equal((await request(probe,tooLarge)).status,400);assert.equal((await probeChildren()).size,0);
    console.log('PASS admin-only, trusted kit, exact retained digest and oversize rejection before launch')
    const slow=await retain('probe-cancel','export default {async server(){await Bun.sleep(300000)}}');const control=new AbortController();const active=request(probe,slow,admin,control.signal).catch(()=>null);let children=new Set();for(let turn=0;turn<120;turn++){children=await probeChildren();if(children.size)break;await wait(250)}assert.equal(children.size,1,'a real QEMU process must start');await assertLimits([...children][0]);assert.equal((await request(probe,pkg)).status,429);control.abort();await active;for(let turn=0;turn<50&&(await probeChildren()).size;turn++)await wait(100);assert.equal((await probeChildren()).size,0,'disconnect must kill and reap QEMU before releasing the slot');
    assert.equal((await request(probe,tooLarge)).status,400);console.log('PASS single-slot busy gate, actual hypervisor killed and reaped on HTTP disconnect, slot reusable');
    if(!process.argv.includes('--controls-only')){
      const before=await pluginState();
      const result=await request(probe,pkg);const report=await result.json();assert.equal(result.status,200,JSON.stringify(report));assert.deepEqual(report.data,{status:'completed',hook:'server',sha256:pkg.sha256,metadataOnly:true,installed:false});
      assert.deepEqual(await pluginState(),before);console.log('PASS actual saved hook completed in isolated guest, no NIC or gateway/peer reads, response cannot install or grant permissions');
      const mark=randomUUID();const bad=await retain('probe-failure',`export default {server(){console.log('A2API_DIAGNOSTIC_HOOK_COMPLETED','${mark}');throw Error('${mark}')}}`),beforeFailure=await pluginState();
      const failure=await request(probe,bad);assert.equal(failure.status,422);assert.ok(!(await failure.text()).includes(mark));assert.equal((await probeChildren()).size,0);assert.deepEqual(await pluginState(),beforeFailure);console.log('PASS rejected hook cannot claim success via console, expose raw output or change registry, policy and archive state');
    }
    if(process.argv.includes('--limits')){
      await limitCase(slow,true);const cpu=await retain('probe-cpu','export default {server(){let sum=0;for(let index=0;index<1e12;index++)sum+=Math.sqrt(index);return {sum}}}');await limitCase(cpu,false);
      console.log('PASS stalled hypervisor triggers wall watchdog; CPU-bound hypervisor hits a separate kernel CPU quota; both are reaped');
    }
  }
}finally{if(server.exitCode===null)server.kill();await ended;await rm(home,{recursive:true,force:true,maxRetries:3})}
