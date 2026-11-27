// Real fixed public package install and Bun execution. No personal credentials or automatic browser authorization.
// Usage: node scripts/test-full-script-provider-magpie.mjs <candidate-server.exe> [--bun <Bun-1.4.2-executable>]
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pluginGateway } from './fixtures/plugin-gateway.mjs';

const pin = JSON.parse(await readFile(new URL('./fixtures/full-script-magpie-pin.json', import.meta.url), 'utf8'));
const executable = process.argv[2];
const bunIndex = process.argv.indexOf('--bun');
const bunPath = bunIndex < 0 ? null : path.resolve(process.argv[bunIndex + 1]);
const passed = [];
let gateway, failure = '', authorization = null;
try {
  gateway = await pluginGateway(executable, 'full-script-magpie');
  const { call, home } = gateway;
  const scripts = '/api/plugins/scripts';
  const snapshot = async () => (await call('/api/plugins')).scripts;
  async function step(name, action) { await action(); passed.push(name); console.log('PASS ' + name); }
  async function operation(endpoint, payload) {
    const started = await call(endpoint, 'POST', payload);
    assert.ok(started.operation?.operationId);
    for (let attempt = 0; attempt < 1200; attempt++) {
      const state = await snapshot();
      if (!state.operation.active && state.operation.operationId === started.operation.operationId) {
        assert.equal(state.operation.error, null, JSON.stringify(state.operation));
        assert.equal(state.operation.stage, 'done');
        // Packages are read before the operation in the management snapshot.
        return await snapshot();
      }
      await delay(250);
    }
    assert.fail('Public package install exceeded five minutes');
  }
  const before = await snapshot(); assert.ok(before?.runtime, 'A real script host is required');
  if (bunPath) {
    await mkdir(path.dirname(before.runtime.path), { recursive: true }); await copyFile(bunPath, before.runtime.path);
    console.log('Using explicit Bun executable; download is not claimed: ' + bunPath);
  }
  let pack, provider;
  await step('fixed public Magpie package downloads, verifies, installs and runs in Bun', async () => {
    const installed = await operation(scripts + '/install', { source: 'magpie:' + pin.name, version: pin.version, trusted: true });
    pack = installed.packages.find(item => item.name === pin.name);
    assert.equal(pack?.version, pin.version); assert.equal(pack.source?.kind, 'magpie');
    assert.equal(pack.source.file, pin.file); assert.equal(pack.source.integrity, pin.integrity);
    assert.equal(installed.runtime.installed, true); assert.equal(installed.runtime.error, null);
    assert.equal(pack.running, true, JSON.stringify(pack));
    provider = pack.providers.find(item => item.originalId === 'antigravity' || item.id === 'antigravity' || item.id.startsWith('antigravity'));
    assert.ok(provider?.loaded, JSON.stringify(pack.providers));
    assert.ok(provider.id, 'Actual public plugin must register a usable provider identity');
  });
  let method;
  await step('public plugin contributes real dynamic Google login methods and declared settings', async () => {
    const methods = await call('/api/session/login/methods?provider=' + encodeURIComponent(provider.id));
    method = methods.methods.find(item => item.type === 'oauth' && /browser|Google/i.test(item.label));
    assert.ok(method, JSON.stringify(methods));
    const settings = await call(scripts + '/settings', 'POST', { id: pack.id });
    assert.ok(settings.schema.providerOptions[provider.id]?.length > 0, JSON.stringify(settings));
    const session = await call('/api/session');
    assert.equal(JSON.stringify(session).includes('"provider":"' + provider.id + '"'), false,
      'Installing a package must not silently import a personal account');
  });
  await step('actual public OAuth start creates a PKCE authorization flow, then cancels without account access', async () => {
    authorization = await call('/api/session/login/start', 'POST', { provider: provider.id, methodIndex: method.methodIndex,
      mode: 'external', locale: 'en', proxy: { source: 'direct' } });
    assert.ok(authorization.state, JSON.stringify(authorization));
    const address = new URL(authorization.authUrl || authorization.url);
    assert.equal(address.hostname, 'accounts.google.com'); assert.equal(address.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(address.searchParams.get('code_challenge'));
    const callback = new URL(address.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, 'localhost'); assert.equal(callback.pathname, '/oauth-callback');
    const result = await call('/api/session/login/cancel', 'POST', { state: authorization.state });
    assert.equal(result.canceled, true); authorization = null;
    console.log('UNVERIFIED external Google authorization, credentials, account catalog and inference; flow canceled before browser authorization');
  });
  await step('restart reloads the public package and retains its provider identity', async () => {
    await gateway.restart();
    for (let attempt = 0; attempt < 160; attempt++) {
      if ((await snapshot()).packages.find(item => item.id === pack.id)?.running) break;
      await delay(250);
    }
    const restored = (await snapshot()).packages.find(item => item.id === pack.id);
    assert.equal(restored?.running, true); assert.ok(restored.providers.some(item => item.id === provider.id && item.loaded));
  });
  await step('public package disables, enables and uninstalls through normal administrator APIs', async () => {
    const disabled = await operation(scripts + '/change', { id: pack.id, action: 'enable', enabled: false });
    assert.equal(disabled.packages[0].running, false);
    const enabled = await operation(scripts + '/change', { id: pack.id, action: 'enable', enabled: true });
    assert.equal(enabled.packages[0].running, true);
    assert.deepEqual((await operation(scripts + '/change', { id: pack.id, action: 'remove' })).packages, []);
  });
  console.log('PASS ' + passed.length + ' actual public Magpie installation/runtime scenarios; external account operations remain unverified');
} catch (error) {
  failure = error.stack || String(error); console.error(failure); process.exitCode = 1;
} finally {
  if (gateway) {
    if (authorization?.state) await gateway.call('/api/session/login/cancel', 'POST', { state: authorization.state }).catch(() => {});
    await writeFile(path.join(gateway.home, 'acceptance.json'), JSON.stringify({ executable: path.resolve(executable), pin,
      passed, failure, externalAuthorization: 'not performed; no browser opened or personal credentials read' }, null, 2));
    await gateway.stop();
  }
}
