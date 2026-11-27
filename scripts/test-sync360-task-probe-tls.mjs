import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

assert.ok(process.argv[2],'pass cargo test --lib --features task-plugins test executable')
const executable=path.resolve(process.argv[2]), directory=await mkdtemp(path.join(os.tmpdir(),'fixed-status-tls-'))
const gitOpenSSL='C:/Program Files/Git/usr/bin/openssl.exe', openssl=process.env.OPENSSL||(existsSync(gitOpenSSL)?gitOpenSSL:'openssl')
const opens=(...args)=>execFileSync(openssl,args,{cwd:directory,stdio:'pipe'})
let server
try {
  opens('req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout','ca.key','-out','ca.pem','-subj','/CN=Ephemeral task fixture CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign')
  opens('req','-new','-newkey','rsa:2048','-nodes','-keyout','host.key','-out','host.csr','-subj','/CN=status.fixture.invalid')
  await writeFile(path.join(directory,'extensions'),'subjectAltName=DNS:status.fixture.invalid\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
  opens('x509','-req','-days','2','-in','host.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-extfile','extensions','-out','host.pem')
  const hits=[]
  server=https.createServer({key:await readFile(path.join(directory,'host.key')),cert:await readFile(path.join(directory,'host.pem'))},(request,response)=>{
    hits.push({method:request.method,path:request.url,sni:request.socket.servername,cookie:request.headers.cookie,auth:request.headers.authorization})
    if(request.url==='/jump')response.writeHead(307,{Location:`https://127.0.0.1:${server.address().port}/not-authorized`}).end(); else response.writeHead(204).end()
  }); server.listen(0,'127.0.0.1'); await once(server,'listening')
  const run=spawn(executable,['--ignored','--exact','server::core::task_plugins::probe::tests::offline_tls_quickjs_fixture'],{cwd:directory,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TASK_FIXTURE_DIR:directory,TASK_FIXTURE_ADDR:`127.0.0.1:${server.address().port}`}})
  let output=''; run.stdout.on('data',data=>{output+=data}); run.stderr.on('data',data=>{output+=data})
  const [code]=await once(run,'exit'); assert.equal(code,0,output); assert.match(output,/1 passed/)
  assert.deepEqual(hits,['/health','/jump'].map(url=>({method:'HEAD',path:url,sni:'status.fixture.invalid',cookie:undefined,auth:undefined})))
  console.log('PASS offline TLS + QuickJS + SQLite grants: pinned socket and original certificate hostname, status only, no second call, no credentials or redirect replay')
} finally {
  if(server?.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})
  await rm(directory,{recursive:true,force:true,maxRetries:3})
}
