// Usage: node scripts/test-full-script-provider.mjs <candidate-server.exe> [--bun <Bun-1.4.2-executable>]
// Uses normal panel/account/Key/route APIs and a fresh database. No personal CLI credentials or product test APIs.
import assert from 'node:assert/strict';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { pluginGateway } from './fixtures/plugin-gateway.mjs';
import { fullScriptUpstream } from './fixtures/full-script-upstream.mjs';

const executable = process.argv[2];
const bunIndex = process.argv.indexOf('--bun');
const bunPath = bunIndex < 0 ? null : path.resolve(process.argv[bunIndex + 1]);
const upstream = await fullScriptUpstream();
let gateway;
const passed = [];
let failure = '';
try {
  gateway = await pluginGateway(executable, 'full-script-provider');
  const { home, call, base } = gateway;
  const scripts = '/api/plugins/scripts';
  const directory = path.join(home, 'provider-source');
  await mkdir(directory);
  await copyFile(fileURLToPath(new URL('./fixtures/full-script-provider.mjs', import.meta.url)), path.join(directory, 'index.mjs'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: '@fixture/full-script-provider', version: '1.0.0', type: 'module', exports: { './server': './index.mjs' },
    scripts: { postinstall: 'node -e "throw Error(\'Package lifecycle scripts must not execute\')"' },
  }));
  const source = 'file:' + directory;
  const snapshot = async () => (await call('/api/plugins')).scripts;
  async function step(name, action) { await action(); passed.push(name); console.log('PASS ' + name); }
  async function operation(endpoint, payload) {
    const started = await call(endpoint, 'POST', payload);
    assert.ok(started.operation?.operationId, 'A real script installation operation is required');
    for (let attempt = 0; attempt < 1200; attempt++) {
      const state = await snapshot();
      if (!state.operation.active && state.operation.operationId === started.operation.operationId) {
        assert.equal(state.operation.error, null, JSON.stringify(state.operation));
        assert.equal(state.operation.stage, 'done');
        // A snapshot reads package records before the operation, so completion
        // can be observed together with package data from before that completion.
        return await snapshot();
      }
      await delay(250);
    }
    assert.fail('Script operation exceeded five minutes');
  }
  // The old c500 delivery must fail here with 404, before dependency/runtime/plugin fixture work.
  // Prove route presence using a valid fixture path and real administrator authentication.
  await step('real script install interface is present', async () => {
    const response = await fetch(base + scripts + '/install', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': gateway.adminKey },
      body: JSON.stringify({ source, trusted: false }), signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    assert.notEqual(response.status, 404, 'RED missing real script install interface: POST ' + scripts + '/install returned 404; valid local package exists; real isolated admin authentication succeeded; response=' + text);
    assert.equal(response.status, 403, 'Gateway Keys cannot authorize script installation: ' + text);
    await call(scripts + '/install', 'POST', { source, trusted: false }, 400);
    const state = await snapshot(); assert.ok(state.runtime && state.operation && Array.isArray(state.packages));
    if (bunPath) {
      await mkdir(path.dirname(state.runtime.path), { recursive: true });
      await copyFile(bunPath, state.runtime.path);
      console.log('Using explicit Bun executable; download is not claimed: ' + bunPath);
    }
  });
  let pack, provider;
  await step('trusted package installs and executes in actual Bun/Magpie runtime', async () => {
    const installed = await operation(scripts + '/install', { source, trusted: true });
    assert.equal(installed.runtime.installed, true); assert.equal(installed.runtime.error, null);
    pack = installed.packages.find(item => item.name === '@fixture/full-script-provider');
    assert.ok(pack?.running, JSON.stringify(installed.packages));
    provider = pack.providers[0]; assert.equal(provider.loaded, true); assert.equal(provider.label, 'Full script acceptance');
    await operation(scripts + '/settings', { id: pack.id, options: { upstream: upstream.base } });
  });
  const accountIds = {};
  await step('declared API login validates and saves two isolated credentials', async () => {
    const methods = await call('/api/session/login/methods?provider=' + encodeURIComponent(provider.id));
    const method = methods.methods.find(item => item.type === 'api'); assert.ok(method);
    const prompts = await call(scripts + '/prompts', 'POST', { provider: provider.id, methodIndex: method.methodIndex });
    assert.ok(prompts.prompts.some(prompt => prompt.key === 'key' && prompt.secret));
    await call('/api/accounts', 'POST', { provider: provider.id, methodIndex: method.methodIndex,
      inputs: { key: 'invalid-disposable-key', account: 'a' }, proxy: { source: 'direct' } }, 502);
    for (const account of ['a', 'b']) {
      const saved = await call('/api/accounts', 'POST', { provider: provider.id, name: 'Acceptance ' + account,
        methodIndex: method.methodIndex, inputs: { key: upstream.keys[account], account }, proxy: { source: 'direct' } });
      accountIds[account] = saved.account.id; assert.ok(accountIds[account]);
      assert.equal(JSON.stringify(saved).includes(upstream.keys[account]), false, 'Public account responses must hide credentials');
    }
    assert.notEqual(accountIds.a, accountIds.b);
    assert.ok(upstream.calls.filter(item => item.path === '/authorize').every(item => item.bun === (pack.runtimeVersion || '1.4.2')));
  });
  await step('account model catalogs refresh and aggregate through normal management APIs', async () => {
    for (const account of ['a', 'b']) {
      // Startup maintenance shares this normal task slot, and manual operations
      // have a one-second rate limit. Retry only those two documented busy states.
      let result;
      for (let attempt = 0; attempt < 60; attempt++) {
        const response = await fetch(base + '/api/models/refresh', { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': gateway.adminKey },
          body: JSON.stringify({ providers: [provider.id], accounts: { [provider.id]: accountIds[account] } }),
          signal: AbortSignal.timeout(30000) });
        const value = await response.json();
        if (response.status === 400 && ['刚刚已执行，请稍后重试', '任务正在执行中，请稍候'].includes(value.error)) {
          await delay(1000); continue;
        }
        assert.equal(response.status, 200, JSON.stringify(value)); result = value.data ?? value; break;
      }
      assert.ok(result, 'Model maintenance did not become ready');
      assert.ok(upstream.calls.some(item => item.path === '/v1/models' && item.account === account));
      assert.ok(!JSON.stringify(result).includes('"status":"failed"'), JSON.stringify(result));
    }
    const routing = await call('/api/routing/groups');
    const models = routing.catalog.filter(item => item.provider === provider.id).map(item => item.model);
    for (const id of ['wire-common', 'wire-a', 'wire-b']) assert.ok(models.includes(id), JSON.stringify(routing.catalog));
  });
  const publicModel = 'Acceptance/Script';
  const otherModel = 'Acceptance/Other';
  async function saveGroup(model, account) {
    const state = await call('/api/routing/groups');
    const id = 'full-script-' + account;
    await call('/api/routing/groups', 'PUT', { id, revision: state.groups.find(row => row.group.id === id)?.revision ?? state.newRevision,
      group: { id, name: 'Actual script provider ' + account, model, strategy: 'order', sticky: 'off', enabled: true,
        members: [{ id: account, provider: provider.id, model: 'wire-common', included: true, accountScope: 'selected', accounts: [accountIds[account]] }] } });
  }
  await saveGroup(publicModel, 'a'); await saveGroup(otherModel, 'b');
  const key = (await call('/api/keys', 'POST', { name: 'Acceptance script scoped Key', allowedProviders: [provider.id], allowedModels: [publicModel] })).created;
  assert.deepEqual(key.allowedProviders, [provider.id]); assert.deepEqual(key.allowedModels, [publicModel]);
  const auth = { 'x-api-key': key.key };
  const tools = [{ type: 'function', function: { name: 'add', description: 'Add two integers',
    parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false } } }];
  const messages = [{ role: 'system', content: 'Preserve tools and reasoning' }, { role: 'user', content: 'Use add to add 2 and 3' }];
  let toolMessage;
  await step('restricted Key exposes only its published group and cannot bypass model scope', async () => {
    const models = await call('/v1/models', 'GET', undefined, 200, auth);
    assert.deepEqual(models.map(item => item.id), [publicModel]);
    const before = upstream.calls.length;
    await call('/v1/chat/completions', 'POST', { model: otherModel, messages }, 404, auth);
    await call(scripts + '/change', 'POST', { id: pack.id, action: 'remove' }, 403, auth);
    assert.equal(upstream.calls.length, before);
  });
  await step('nonstream aggregation retains tool fragments, reasoning and usage', async () => {
    const result = await call('/v1/chat/completions', 'POST', { model: publicModel, messages, tools, stream: false }, 200, auth);
    toolMessage = result.choices[0].message;
    assert.equal(result.model, publicModel); assert.equal(result.choices[0].finish_reason, 'tool_calls');
    assert.equal(toolMessage.reasoning_content, 'fixture reasoning preserved');
    assert.equal(toolMessage.tool_calls[0].id, 'call_fixture_add');
    assert.deepEqual(JSON.parse(toolMessage.tool_calls[0].function.arguments), { a: 2, b: 3 });
    assert.equal(result.usage.total_tokens, 26);
  });
  await step('SSE forwards tool argument fragments and the exact public model name', async () => {
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: publicModel, messages, tools, stream: true }),
      signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').includes('text/event-stream'));
    const text = await response.text(); assert.ok(text.includes('data: [DONE]'), text);
    const chunks = text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
    const choices = chunks.flatMap(chunk => chunk.choices ?? []);
    const calls = choices.flatMap(choice => choice.delta?.tool_calls ?? []);
    assert.ok(calls.some(call => call.id === 'call_fixture_add' && call.function?.name === 'add'));
    assert.deepEqual(JSON.parse(calls.map(call => call.function?.arguments || '').join('')), { a: 2, b: 3 });
    assert.equal(choices.map(choice => choice.delta?.reasoning_content || '').join(''), 'fixture reasoning preserved');
    assert.ok(choices.some(choice => choice.finish_reason === 'tool_calls'));
    assert.ok(chunks.filter(chunk => chunk.model).every(chunk => chunk.model === publicModel), text);
    assert.ok(chunks.some(chunk => chunk.usage?.total_tokens === 26));
  });
  await step('SSE tool roundtrip preserves tool IDs, history, reasoning and finish', async () => {
    const history = [...messages, toolMessage, { role: 'tool', tool_call_id: 'call_fixture_add', content: '5' }];
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: publicModel, messages: history, tools, stream: true }),
      signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').includes('text/event-stream'));
    const text = await response.text(); assert.ok(text.includes('data: [DONE]'), text);
    const chunks = text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
    assert.equal(chunks.flatMap(chunk => chunk.choices ?? []).map(choice => choice.delta?.reasoning_content || '').join(''), 'fixture reasoning preserved');
    assert.equal(chunks.flatMap(chunk => chunk.choices ?? []).map(choice => choice.delta?.content || '').join(''), 'tool result=5');
    assert.ok(chunks.filter(chunk => chunk.model).every(chunk => chunk.model === publicModel), text);
    const request = upstream.calls.filter(item => item.path === '/v1/chat/completions').at(-1);
    assert.equal(request.account, 'a'); assert.equal(request.body.model, 'wire-common');
    assert.deepEqual(request.body.tools, tools); assert.deepEqual(request.body.messages.map(item => item.role), history.map(item => item.role));
    assert.equal(request.body.messages.at(-1).tool_call_id, 'call_fixture_add'); assert.equal(request.bun, '1.4.2');
    assert.equal(upstream.calls.some(item => item.error), false, JSON.stringify(upstream.calls));
  });
  await step('restart restores plugin identities, settings, credentials and real requests', async () => {
    await gateway.restart();
    for (let attempt = 0; attempt < 160; attempt++) {
      if ((await snapshot()).packages.find(item => item.id === pack.id)?.running) break;
      await delay(250);
    }
    const restored = (await snapshot()).packages.find(item => item.id === pack.id);
    assert.equal(restored?.running, true); assert.equal(restored.providers[0].id, provider.id);
    const result = await call('/v1/chat/completions', 'POST', { model: publicModel, messages: [{ role: 'user', content: 'persisted credentials' }], stream: false }, 200, auth);
    assert.equal(result.choices[0].message.content, 'a:wire-common');
  });
  await step('disable blocks forwarding, enable resumes, removal unregisters provider', async () => {
    const disabled = await operation(scripts + '/change', { id: pack.id, action: 'enable', enabled: false });
    assert.equal(disabled.packages[0].running, false);
    const before = upstream.calls.length;
    assert.deepEqual(await call('/v1/models', 'GET', undefined, 200, auth), []);
    assert.equal(upstream.calls.length, before);
    const enabled = await operation(scripts + '/change', { id: pack.id, action: 'enable', enabled: true });
    assert.equal(enabled.packages[0].running, true);
    const result = await call('/v1/chat/completions', 'POST', { model: publicModel, messages: [{ role: 'user', content: 'enabled again' }] }, 200, auth);
    assert.equal(result.choices[0].message.content, 'a:wire-common');
    const removed = await operation(scripts + '/change', { id: pack.id, action: 'remove' });
    assert.deepEqual(removed.packages, []);
    assert.deepEqual(await call('/v1/models', 'GET', undefined, 200, auth), []);
  });
  console.log('PASS ' + passed.length + ' full script-provider integration scenarios (actual Bun execution and loopback HTTP; external OAuth not tested)');
} catch (error) {
  failure = error.stack || String(error); console.error(failure); process.exitCode = 1;
} finally {
  if (gateway) {
    await writeFile(path.join(gateway.home, 'acceptance.json'), JSON.stringify({ executable: path.resolve(executable), passed, failure, calls: upstream.calls }, null, 2));
    await gateway.stop();
  }
  await upstream.stop();
}
