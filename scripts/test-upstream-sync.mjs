// Isolated HTTP regression for request lifetimes and live debug configuration.
// No external upstream or real account data is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = path.resolve(process.argv[2] || 'target/debug/agent2api-server.exe');
const directory = await mkdtemp(path.join(os.tmpdir(), 'agent2api-upstream-sync-'));
const key = 'isolated-sync-admin';
const calls = [];
const upstream = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id:'fixture', choices:[{index:0,delta:{role:'assistant',content:'sync-ok'},finish_reason:null}] })}\n\ndata: ${JSON.stringify({ choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12} })}\n\ndata: [DONE]\n\n`);
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const child = spawn(executable, [], { cwd:directory, windowsHide:true, stdio:['ignore','pipe','pipe'], env:{
  ...process.env, AGENT2API_PROXY_HOME:directory, AGENT2API_HOST:'127.0.0.1', AGENT2API_PROXY_PORT:String(port),
  AGENT2API_PROXY_API_KEY:key, AGENT2API_ACCOUNT_KEY:'7'.repeat(64), AGENT2API_SELF_UPDATE:'0', AGENT2API_WINDOWS_UPDATE:'0',
  AGENT2API_PANEL_PORT:'', AGENT2API_ADMIN_USER:'', AGENT2API_ADMIN_PASSWORD:'', AGENT2API_ADMIN_PASSWORD_HASH:'',
} });
const exited = once(child, 'exit'); let logs = '';
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { logs = (logs + chunk).slice(-64000); });
const base = `http://127.0.0.1:${port}`;
async function send(endpoint, raw, method = raw ? 'POST' : 'GET') {
  return fetch(base + endpoint, { method, headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json'},
    body:raw, signal:AbortSignal.timeout(30000) });
}
async function api(endpoint, body, method = body ? 'POST' : 'GET') {
  const response = await send(endpoint, body ? JSON.stringify(body) : undefined, method);
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  return result.success === true && result.data !== undefined ? result.data : result;
}
let passed = 0;
try {
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (child.exitCode !== null) throw new Error('Fixture exited before startup');
    try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  assert(ready, 'Fixture did not start');
  const channel = await api('/api/custom-providers', { name:'Sync fixture', protocol:'chat_completions',
    baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,
    keyGroups:[{id:'main',enabled:true,apiKeys:['fixture-upstream'],models:['wire-sync']}] });
  const model = 'Public-Sync';
  const catalog = await api('/api/routing/groups');
  await api('/api/routing/groups', { revision:catalog.newRevision,id:model,group:{id:model,model,name:model,enabled:true,
    strategy:'order',sticky:'off',members:[{id:'source',provider:channel.provider.id,model:'wire-sync',included:true,accountScope:'all',accounts:[]}] } }, 'PUT');
  const seen = new Set();
  for (const debugMode of [false, true, false]) {
    await api('/api/debug', { debugMode }, 'PUT');
    for (const endpoint of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
      for (const stream of [false, true]) {
        const content = `${endpoint} ${stream} ${passed}: ` + 'large request\n'.repeat(20000);
        const payload = {model,stream,max_tokens:128};
        if (endpoint === '/v1/responses') payload.input = content;
        else payload.messages = [{role:'user',content}];
        const raw = JSON.stringify(payload, null, 2) + '\n';
        const before = calls.length;
        const response = await send(endpoint, raw); const text = await response.text();
        assert.equal(response.status, 200, text);
        assert(text.includes('sync-ok'), `${endpoint}: missing response`);
        assert.equal(calls.length, before + 1, 'one forwarding per request');
        assert.equal(calls.at(-1).model, 'wire-sync');
        assert.equal(calls.at(-1).messages.at(-1).content, content);
        let entry;
        for (let n = 0; n < 100; n++) {
          const stats = await api('/api/stats/requests?model=' + encodeURIComponent(model));
          entry = stats.entries.find(item => !seen.has(item.id) && item.status !== 0);
          if (entry) break;
          await delay(50);
        }
        assert(entry, 'request did not reach terminal accounting'); seen.add(entry.id);
        const captured = await send('/api/stats/requests/raw?id=' + encodeURIComponent(entry.id));
        assert.equal(captured.status, debugMode ? 200 : 404);
        if (debugMode) {
          const value = await captured.json();
          assert.equal((value.data || value).requestBody, raw, 'capture retains original bytes before model/protocol conversion');
        } else await captured.text();
        passed++;
      }
    }
  }
  console.log(`PASS ${passed} requests: three protocols, streaming and aggregated, live debug off/on/off, original request capture`);
} finally {
  child.kill(); await exited;
  await new Promise(resolve => upstream.close(resolve));
  await writeFile(path.join(directory, 'server.log'), logs);
  console.log(`Evidence: ${directory}`);
}
