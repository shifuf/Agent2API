// node scripts/test-full-native-vision.mjs <candidate.exe> --bun <Bun-1.4.2.exe>
// Regression: enabling visual assistance must not reject a valid native state request.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { pluginGateway } from './fixtures/plugin-gateway.mjs';

const executable = process.argv[2];
const bunIndex = process.argv.indexOf('--bun');
assert.ok(bunIndex >= 0 && process.argv[bunIndex + 1], 'Pass the synthetic fixture Bun executable explicitly');
const bunPath = path.resolve(process.argv[bunIndex + 1]);
const calls = [], passed = [];
const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const upstream = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path: req.url, body, bun: req.headers['x-native-fixture-bun'] });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url === '/v1/responses') {
      const response = { id: 'resp_fixture_native', object: 'response', status: 'completed', model: body.model,
        output: [{ type: 'reasoning', id: 'rs_fixture', encrypted_content: 'opaque-native-state' },
          { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'native state retained', annotations: [] }] }],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }, future_native: { keep: true } };
      for (const value of [
        { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.completed', sequence_number: 1, response },
      ]) res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    } else {
      const text = body.model === 'wire-vision' ? 'synthetic visual description' : 'original text answer';
      res.write(`data: ${JSON.stringify({ id: 'chat_fixture', model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    }
    res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
let gateway, failure = '';
try {
  gateway = await pluginGateway(executable, 'full-native-vision');
  const { home, call, base } = gateway;
  const snapshot = async () => (await call('/api/plugins')).scripts;
  const state = await snapshot();
  await mkdir(path.dirname(state.runtime.path), { recursive: true });
  await copyFile(bunPath, state.runtime.path);
  console.log('Using explicit synthetic Bun executable; runtime download is not tested: ' + bunPath);
  const directory = path.join(home, 'provider-source'); await mkdir(directory);
  await copyFile(fileURLToPath(new URL('./fixtures/full-native-vision-provider.mjs', import.meta.url)), path.join(directory, 'index.mjs'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: '@fixture/full-native-vision', version: '1.0.0', type: 'module', exports: { './server': './index.mjs' },
  }));
  async function operation(endpoint, body) {
    const started = await call(endpoint, 'POST', body);
    assert.ok(started.operation?.operationId);
    for (let attempt = 0; attempt < 1200; attempt++) {
      const state = await snapshot();
      if (!state.operation.active && state.operation.operationId === started.operation.operationId) {
        assert.equal(state.operation.error, null, JSON.stringify(state.operation));
        assert.equal(state.operation.stage, 'done'); return await snapshot();
      }
      await delay(250);
    }
    assert.fail('Synthetic script installation timed out');
  }
  const installed = await operation('/api/plugins/scripts/install', { source: 'file:' + directory, trusted: true });
  assert.equal(installed.runtime.version, '1.4.2');
  const pack = installed.packages.find(pack => pack.name === '@fixture/full-native-vision');
  assert.ok(pack?.running, JSON.stringify(installed.packages));
  await operation('/api/plugins/scripts/settings', { id: pack.id, options: { upstream: upstreamBase } });
  const provider = pack.providers[0].id;
  const methods = await call('/api/session/login/methods?provider=' + encodeURIComponent(provider));
  const method = methods.methods.find(method => method.type === 'api'); assert.ok(method);
  const account = (await call('/api/accounts', 'POST', { provider, name: 'Native synthetic account',
    methodIndex: method.methodIndex, inputs: { key: 'synthetic-native-api-key' }, proxy: { source: 'direct' } })).account;
  const groups = [];
  async function group(id, model, provider, wire, accounts = []) {
    const state = await call('/api/routing/groups');
    await call('/api/routing/groups', 'PUT', { id, revision: state.newRevision,
      group: { id, name: model, model, enabled: true, strategy: 'order', sticky: 'off',
        members: [{ id: id + '-member', provider, model: wire, included: true,
          accountScope: accounts.length ? 'selected' : 'all', accounts }] } });
    groups.push(model);
  }
  const nativeModel = 'Fixture/NativeState', textModel = 'Fixture/Text', visionModel = 'Fixture/Vision';
  await group('native-state', nativeModel, provider, 'wire-native', [account.id]);
  const customProviders = [];
  for (const [id, model, wire, supportsImages] of [
    ['native-text', textModel, 'wire-text', false], ['native-vision', visionModel, 'wire-vision', true],
  ]) {
    const custom = (await call('/api/custom-providers', 'POST', { name: id, protocol: 'chat_completions',
      baseUrl: upstreamBase + '/v1', keyGroups: [{ id: 'synthetic', enabled: true, apiKeys: ['synthetic-chat-key'], models: [wire] }] })).provider.id;
    customProviders.push(custom);
    await call('/api/custom-providers/models', 'POST', { providerId: custom,
      models: [{ id: wire, enabled: true, capabilities: { supportsImages } }], mappings: [] });
    await group(id, model, custom, wire);
  }
  const key = (await call('/api/keys', 'POST', { name: 'Native fixture scoped Key',
    allowedProviders: [provider, ...customProviders], allowedModels: groups })).created.key;
  const auth = { 'x-api-key': key };
  const endpoint = '/api/vision-compatibility';
  const config = { enabled: true, rules: [{ enabled: true,
    models: [nativeModel, textModel].map(model => ({ provider: '@routing-group', model })),
    mode: 'assist', source: 'custom', target: { provider: '@routing-group', model: visionModel }, reuseResults: false }] };
  const save = async enabled => call(endpoint, 'PUT', { config: { ...config, enabled }, revision: (await call(endpoint)).revision, consent: true });
  const nativeBody = stream => ({ model: nativeModel, stream, previous_response_id: 'resp_previous_fixture', store: true,
    instructions: 'Keep native instructions unchanged', future_native: { signature: 'opaque-signature', keep: true },
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Describe without losing server state' },
      { type: 'input_image', image_url: imageUrl, detail: 'high' }] }] });
  async function nativeRequest(stream) {
    const input = nativeBody(stream), before = calls.length;
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    assert.equal(response.status, 200, `Native state+image request must remain eligible (stream=${stream}): ${text}`);
    assert.equal(calls.length, before + 1, 'Native requests must bypass auxiliary visual calls');
    const actual = calls.at(-1); assert.equal(actual.path, '/v1/responses'); assert.equal(actual.bun, '1.4.2');
    assert.equal(actual.body.model, 'wire-native'); assert.equal(actual.body.previous_response_id, 'resp_previous_fixture');
    assert.deepEqual(actual.body.input, input.input); assert.deepEqual(actual.body.future_native, input.future_native);
    assert.equal(actual.body.instructions, input.instructions); assert.equal(actual.body.store, true);
    assert.ok(text.includes('opaque-native-state')); assert.ok(text.includes('native state retained')); assert.ok(text.includes(nativeModel));
    if (!stream) { const output = JSON.parse(text); assert.equal(output.future_native.keep, true); }
  }
  await save(false); await nativeRequest(false);
  passed.push('native Bun state+image baseline with visual assistance disabled'); console.log('PASS ' + passed.at(-1));
  await save(true);
  const controlBefore = calls.length;
  const control = await call('/v1/chat/completions', 'POST', { model: textModel, stream: false,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: imageUrl } }] }] }, 200, auth);
  assert.equal(control.choices[0].message.content, 'original text answer'); assert.equal(calls.length, controlBefore + 2);
  assert.equal(calls.at(-2).body.model, 'wire-vision'); assert.equal(calls.at(-1).body.model, 'wire-text');
  assert.ok(!JSON.stringify(calls.at(-1).body).includes(imageUrl));
  passed.push('enabled visual assistance genuinely performs an authorized auxiliary call'); console.log('PASS ' + passed.at(-1));
  for (const stream of [false, true]) await nativeRequest(stream);
  passed.push('enabled visual assistance bypasses native Bun state+image in aggregate and stream modes without losing fields'); console.log('PASS ' + passed.at(-1));
  const deniedBefore = calls.length;
  await call('/v1/responses', 'POST', { ...nativeBody(false), model: textModel }, 400, auth);
  const malformed = await fetch(base + '/v1/responses', { method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' }, body: '{"model":', signal: AbortSignal.timeout(30000) });
  assert.equal(malformed.status, 400, 'Malformed native request JSON must still be rejected');
  await malformed.text();
  assert.equal(calls.length, deniedBefore, 'Wrong-protocol and malformed requests must not reach any upstream');
  passed.push('wrong-protocol native state and malformed native request JSON remain rejected before forwarding'); console.log('PASS ' + passed.at(-1));
} catch (error) { failure = error.stack || String(error); console.error(failure); process.exitCode = 1; }
finally {
  if (gateway) { await writeFile(path.join(gateway.home, 'acceptance.json'), JSON.stringify({ executable: path.resolve(executable), passed, failure, calls }, null, 2)); await gateway.stop(); }
  await new Promise(resolve => upstream.close(resolve));
}
