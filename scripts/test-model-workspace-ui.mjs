import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/**
 * End-to-end channel/model UI smoke using an isolated server and local fake upstream.
 * Build the UI and server first. Playwright is an optional external dependency:
 *   npm install --prefix /tmp/browser-tools playwright
 *   NODE_PATH=/tmp/browser-tools/node_modules node scripts/test-channel-ui.mjs --server /path/to/agent2api-server
 * Or set PLAYWRIGHT_MODULE to the absolute path of the installed playwright package.
 * All browser sessions are headless and isolated from the user's profile.
 */
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/test-channel-ui.mjs --server PATH [--browser PATH] [--output DIR] [--ui-dir DIR]');
  console.log('Environment: PLAYWRIGHT_MODULE or NODE_PATH for optional Playwright; AGENT2API_SERVER_BIN, BROWSER_EXECUTABLE for executable defaults.');
  process.exit(0);
}
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return '';
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(option('--output') || path.join(os.tmpdir(), 'agent2api-ui-smoke'));
const binary = path.resolve(option('--server') || process.env.AGENT2API_SERVER_BIN || path.join(repository, 'target/debug', process.platform === 'win32' ? 'agent2api-server.exe' : 'agent2api-server'));
const uiDirectory = path.resolve(option('--ui-dir') || path.join(repository, 'desktop-tauri/ui'));
if (!fs.existsSync(binary)) throw new Error(`Server executable does not exist: ${binary}`);
if (!fs.existsSync(path.join(uiDirectory, 'index.html'))) throw new Error(`Built UI does not exist: ${uiDirectory}`);
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); }
catch { throw new Error('Install Playwright externally and set PLAYWRIGHT_MODULE to its package path, or NODE_PATH to its node_modules directory.'); }
const browserCandidates = process.platform === 'win32'
  ? [path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
     path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')]
  : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const browserPath = option('--browser') || process.env.BROWSER_EXECUTABLE || browserCandidates.find(candidate => fs.existsSync(candidate));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(root, runId);
fs.mkdirSync(out, { recursive: true });
const apiKey = `smoke-${randomUUID()}`;
const results = { runId, binary, steps: [], consoleErrors: [], pageErrors: [], failedRequests: [], responseErrors: [], screenshots: [] };
const publicCatalog = { providers: [
  { id: 'maker-a', name: 'Maker A', models: [{ id: 'Alpha/Latest', name: 'Alpha Latest', kind: 'chat', type: 'chat', icon: 'deepseek', family: 'alpha', modelCard: { limit: { context: 8192 }, modalities: { input: ['text', 'image'] }, toolCall: true } }, { id: 'shared', name: 'Shared A', kind: 'chat' }] },
  { id: 'maker-b', name: 'Maker B', models: [{ id: 'shared', name: 'Shared B', kind: 'chat' }] },
  { id: 'deepseek', name: 'DeepSeek', models: [] },
  { id: 'alims-intl', name: 'Model Studio International', models: [] },
], sourceUrl: 'https://raw.githubusercontent.com/ThinkInAIXYZ/PublicProviderConf/refs/heads/dev/dist/all.json', fetchedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stale: false };
let directoryRequests = 0;
const longUpstreamName = 'LongUpstreamDisplayName'.repeat(6);
const mockCatalog = async context => {
  await context.route('**/api/models/public-catalog', route => {
    directoryRequests++;
    const refreshed = route.request().method() === 'POST';
    return route.fulfill({ json: { success: true, data: { ...publicCatalog, stale: refreshed, ...(refreshed ? { error: 'upstream unavailable' } : {}) } } });
  });
  // Custom channels currently expose IDs only. Exercise the optional display name
  // supplied by other provider catalogs without requiring a real provider login.
  await context.route('**/api/models/catalog', async route => {
    // Saves also return a fresh catalog, so decorate both read and write responses.
    const response = await route.fetch();
    const json = await response.json();
    for (const source of json.data?.sources || []) {
      for (const model of source.models) if (model.id === 'upstream-b') model.name = longUpstreamName;
    }
    return route.fulfill({ response, json });
  });
};
const serverLog = fs.openSync(path.join(out, 'server.log'), 'a');
const mock = http.createServer((request, response) => {
  const key = request.headers.authorization || '';
  response.setHeader('Content-Type', 'application/json');
  if (request.url?.endsWith('/models')) {
    const ids = key.includes('key-b') ? ['upstream-b', 'shared-model'] : ['upstream-a', 'shared-model'];
    response.end(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'smoke' })) }));
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'smoke upstream only exposes models' }));
  }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const upstreamBase = `http://127.0.0.1:${mock.address().port}/v1`;
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENT2API_PROXY_HOME: path.join(out, 'data'), AGENT2API_PROXY_API_KEY: apiKey,
  AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port), AGENT2API_UI_DIR: uiDirectory,
  AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0' };
delete env.AGENT2API_PANEL_PORT;
delete env.AGENT2API_ADMIN_USER;
delete env.AGENT2API_ADMIN_PASSWORD;
delete env.AGENT2API_ADMIN_PASSWORD_HASH;
const server = spawn(binary, [], { cwd: path.dirname(binary), env, windowsHide: true, stdio: ['ignore', serverLog, serverLog] });
let browser;
let desktop;
let mobile;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const api = async (url, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(`${base}${url}`, { method, headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  assert(response.ok && result.success !== false, `${url}: ${JSON.stringify(result)}`);
  return result.data ?? result;
};
const attach = (page, label) => {
  page.on('console', message => { if (message.type() === 'error') results.consoleErrors.push({ label, text: message.text() }); });
  page.on('pageerror', error => results.pageErrors.push({ label, error: String(error) }));
  page.on('requestfailed', request => results.failedRequests.push({ label, url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400) results.responseErrors.push({ label, status: response.status(), url: response.url() }); });
};
const screenshot = async (page, name) => {
  const target = path.join(out, `${name}.png`);
  await page.screenshot({ path: target, fullPage: true, animations: 'disabled' });
  results.screenshots.push(target);
};
const step = async (name, work, page = desktop) => {
  try {
    await work();
    results.steps.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.steps.push({ name, status: 'failed', error: String(error), stack: error.stack });
    if (page) {
      await screenshot(page, `failed-${results.steps.length}`).catch(() => {});
      fs.writeFileSync(path.join(out, `failed-${results.steps.length}.txt`), await page.locator('body').innerText().catch(() => ''));
      fs.writeFileSync(path.join(out, `failed-${results.steps.length}-aria.txt`), await page.locator('body').ariaSnapshot().catch(() => ''));
    }
    console.error(`FAIL ${name}: ${error}`);
  }
};
const nav = async id => {
  await desktop.locator(`.nav-item[data-page="${id}"]`).click();
  await desktop.locator(`.page[data-page="${id}"].active`).waitFor();
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`);
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
    await pause(500);
  }
  assert(ready, 'Server was not ready within 60 seconds');
  results.base = base;
  browser = await chromium.launch({ ...(browserPath ? { executablePath: browserPath } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  await mockCatalog(context);
  await context.addInitScript(key => {
    localStorage.setItem('agent2api.webKey', key);
    localStorage.setItem('agent2api.webKey.origin', key);
  }, apiKey);
  desktop = await context.newPage();
  desktop.setDefaultTimeout(20000);
  attach(desktop, 'desktop');
  await desktop.goto(base, { waitUntil: 'domcontentloaded' });

  await step('model workspace offers separate model creation, batch creation and association workflows', async () => {
    await nav('gateway');
    await desktop.getByRole('button', { name: '批量添加', exact: true }).waitFor();
    await desktop.getByRole('button', { name: '未关联模型', exact: true }).waitFor();
    await screenshot(desktop, 'model-workspace-empty');
  });
  if (results.steps.some(item => item.status === 'failed')) throw new Error('Workspace entry points are missing');

  await step('standalone model creation works without any configured account or channel', async () => {
    await desktop.getByRole('button', { name: '添加模型', exact: true }).click();
    assert.equal(await desktop.locator('#managed-model-name, #managed-model-icon, #managed-model-group, #managed-model-type, .models-card-fields').count(), 0, 'Model editor should omit metadata fields and the entire model card');
    await desktop.getByRole('combobox', { name: '开发者 / 厂商', exact: true }).click();
    const brand = desktop.getByRole('option', { name: 'DeepSeek', exact: true }).locator('img');
    await brand.waitFor();
    await brand.evaluate(img => img.decode());
    assert.equal(await desktop.getByRole('option', { name: 'Model Studio International', exact: true }).locator('img').count(), 1, 'Regional brands should use their bundled logo');
    await screenshot(desktop, 'model-manufacturer-picker');
    await desktop.getByRole('option', { name: 'Maker A', exact: true }).click();
    assert.equal(await desktop.getByRole('combobox', { name: '对外模型 ID', exact: true }).count(), 1);
    await desktop.locator('#managed-model-id').fill('alpha');
    await desktop.getByRole('option', { name: 'Maker A / Alpha/Latest', exact: true }).waitFor();
    await desktop.locator('#managed-model-id').press('ArrowDown');
    await desktop.locator('#managed-model-id').press('Enter');
    assert.equal(await desktop.locator('#managed-model-id').inputValue(), 'Alpha/Latest');
    await desktop.locator('#managed-model-remark').fill('Standalone catalog model');
    await screenshot(desktop, 'model-workspace-editor');
    await desktop.getByRole('button', { name: '保存', exact: true }).click();
    await desktop.getByRole('cell', { name: 'Alpha/Latest', exact: true }).waitFor();
    const model = (await api('/api/models/catalog')).models.find(item => item.id === 'Alpha/Latest');
    assert.equal(model.enabled, false);
    assert.deepEqual(model.bindings, []);
    assert.equal(model.developer, 'maker-a');
    assert.deepEqual(model.modelCard.modalities.input, ['text', 'image']);
    assert.equal(model.modelCard.limit.context, 8192);
    assert.equal(model.name, 'Alpha Latest');
    assert.equal(model.icon, 'deepseek');
    assert.equal(model.group, 'alpha');
    assert.equal(model.remark, 'Standalone catalog model');
    assert.deepEqual((await api('/api/keys')).modelsByProvider, {});
    await screenshot(desktop, 'model-workspace-standalone');
    await desktop.getByRole('button', { name: '关联渠道 Alpha/Latest', exact: true }).click();
    assert.equal(await desktop.getByRole('combobox', { name: '账号提供商', exact: true }).isDisabled(), true);
    await desktop.getByRole('button', { name: '取消', exact: true }).click();
  });
  if (results.steps.some(item => item.status === 'failed')) throw new Error('Standalone model creation failed');

  let providerId;
  let secondProviderId;
  let secondAccountId;
  await step('associating an upstream is a separate operation that preserves model information', async () => {
    const created = await api('/api/custom-providers', { name: 'Workspace channel', protocol: 'chat_completions', baseUrl: upstreamBase,
      keyGroups: [{ id: 'first', name: 'First', enabled: true, apiKeys: ['smoke-key-a'], accountIds: [], models: ['upstream-a', 'shared-model'] }] });
    providerId = created.provider.id;
    const second = await api('/api/custom-providers', { name: 'Second channel', protocol: 'chat_completions', baseUrl: upstreamBase,
      keyGroups: [{ id: 'second', name: 'Second', enabled: true, apiKeys: ['smoke-key-b'], accountIds: [], models: ['upstream-b', 'shared-model'] }] });
    secondProviderId = second.provider.id;
    secondAccountId = second.accounts[0].id;
    const accountless = await api('/api/custom-providers', { name: 'Accountless channel', protocol: 'chat_completions', baseUrl: upstreamBase,
      keyGroups: [{ id: 'removed', name: 'Removed', enabled: true, apiKeys: ['smoke-key-removed'], accountIds: [], models: ['unused-model'] }] });
    await api(`/api/accounts/${accountless.accounts[0].id}`, undefined, 'DELETE');
    await desktop.getByRole('button', { name: '刷新', exact: true }).click();
    await desktop.getByRole('button', { name: '关联渠道 Alpha/Latest', exact: true }).click();
    await desktop.getByRole('combobox', { name: '账号提供商', exact: true }).click();
    assert.equal(await desktop.getByRole('option', { name: 'Accountless channel', exact: true }).count(), 0);
    await screenshot(desktop, 'model-association-provider-picker');
    await desktop.getByRole('option', { name: 'Workspace channel', exact: true }).click();
    assert.equal(await desktop.getByRole('checkbox', { name: 'Second channel / upstream-b', exact: true }).count(), 0);
    await desktop.getByRole('checkbox', { name: 'Workspace channel / upstream-a', exact: true }).check();
    await desktop.getByRole('combobox', { name: '账号提供商', exact: true }).click();
    await desktop.getByRole('option', { name: 'Second channel', exact: true }).click();
    assert.equal(await desktop.getByRole('checkbox', { name: 'Workspace channel / upstream-a', exact: true }).count(), 0);
    await desktop.getByRole('checkbox', { name: 'Second channel / upstream-b', exact: true }).check();
    await desktop.getByRole('checkbox', { name: 'Second channel / shared-model', exact: true }).check();
    assert.equal(await desktop.getByRole('checkbox', { name: 'Second channel / upstream-b', exact: true }).isChecked(), false);
    await desktop.getByRole('combobox', { name: '账号提供商', exact: true }).click();
    await desktop.getByRole('option', { name: 'Workspace channel', exact: true }).click();
    assert.equal(await desktop.getByRole('checkbox', { name: 'Workspace channel / upstream-a', exact: true }).isChecked(), true);
    await screenshot(desktop, 'model-workspace-associations');
    await desktop.getByRole('button', { name: '保存关联', exact: true }).click();
    await desktop.getByRole('heading', { name: '关联渠道', exact: true }).waitFor({ state: 'hidden' });
    const enabled = desktop.waitForResponse(response => response.url() === `${base}/api/models/catalog` && response.request().method() === 'POST');
    await desktop.getByRole('switch', { name: '启用 Alpha/Latest', exact: true }).click();
    assert.equal((await enabled).status(), 200);
    await desktop.locator('[data-model-row="Alpha/Latest"] [role=switch][aria-checked=true]').waitFor();
    const model = (await api('/api/models/catalog')).models.find(item => item.id === 'Alpha/Latest');
    assert.equal(model.name, 'Alpha Latest');
    assert.equal(model.remark, 'Standalone catalog model');
    assert.equal(model.enabled, true);
    assert.deepEqual(model.bindings, [{ provider: providerId, model: 'upstream-a' }, { provider: secondProviderId, model: 'shared-model' }]);
    assert((await api('/api/keys')).modelsByProvider[providerId].includes('Alpha/Latest'));
  });
  if (results.steps.some(item => item.status === 'failed')) throw new Error('Association setup failed');

  await step('batch directory selection deduplicates IDs and creates disabled standalone records atomically', async () => {
    await desktop.getByRole('button', { name: '批量添加', exact: true }).click();
    assert.equal(await desktop.getByRole('checkbox', { name: '添加 shared', exact: true }).count(), 1);
    assert.equal(await desktop.getByRole('checkbox', { name: '添加 Alpha/Latest', exact: true }).count(), 0);
    await desktop.getByRole('combobox', { name: '模型厂商', exact: true }).selectOption('maker-b');
    await desktop.getByRole('checkbox', { name: '添加 shared', exact: true }).check();
    await desktop.getByRole('combobox', { name: '模型厂商', exact: true }).selectOption('maker-a');
    await desktop.getByRole('button', { name: '添加所选模型', exact: true }).click();
    await desktop.getByRole('cell', { name: 'shared', exact: true }).waitFor();
    const models = (await api('/api/models/catalog')).models;
    assert.equal(models.length, 2);
    assert.equal(models.find(item => item.id === 'shared').enabled, false);
    assert.equal(models.find(item => item.id === 'shared').developer, 'maker-b');
    assert.equal(models.find(item => item.id === 'shared').name, 'Shared B');
  });

  await step('archiving hides published availability and restoring preserves bindings', async () => {
    await desktop.getByRole('button', { name: '归档 Alpha/Latest', exact: true }).click();
    await desktop.getByRole('button', { name: '确认归档', exact: true }).click();
    await desktop.getByRole('button', { name: '恢复 Alpha/Latest', exact: true }).waitFor();
    assert(!(await api('/api/keys')).modelsByProvider[providerId]?.includes('Alpha/Latest'));
    await desktop.getByRole('button', { name: '恢复 Alpha/Latest', exact: true }).click();
    await desktop.getByRole('button', { name: '归档 Alpha/Latest', exact: true }).waitFor();
    const model = (await api('/api/models/catalog')).models.find(item => item.id === 'Alpha/Latest');
    assert.equal(model.archived, false);
    assert.equal(model.enabled, false);
    assert.equal(model.bindings[0].model, 'upstream-a');
  });

  await step('selecting the current model preserves its draft remark, hidden metadata and associations', async () => {
    const before = (await api('/api/models/catalog')).models.find(model => model.id === 'Alpha/Latest');
    await desktop.getByRole('button', { name: '编辑 Alpha/Latest', exact: true }).click();
    await desktop.locator('#managed-model-remark').fill('Preserved draft remark');
    await desktop.locator('#managed-model-id').fill('Alpha');
    await desktop.getByRole('option', { name: 'Maker A / Alpha/Latest', exact: true }).click();
    assert.equal(await desktop.locator('#managed-model-id').inputValue(), 'Alpha/Latest');
    assert.equal(await desktop.locator('#managed-model-remark').inputValue(), 'Preserved draft remark');
    await desktop.getByRole('button', { name: '保存', exact: true }).click();
    await desktop.getByRole('heading', { name: '编辑模型', exact: true }).waitFor({ state: 'hidden' });
    const after = (await api('/api/models/catalog')).models.find(model => model.id === 'Alpha/Latest');
    for (const field of ['name', 'developer', 'type', 'icon', 'group', 'modelCard', 'bindings', 'enabled']) assert.deepEqual(after[field], before[field], field);
    assert.equal(after.remark, 'Preserved draft remark');
  });

  await step('a concurrent catalog change can be refreshed without losing the editor draft', async () => {
    await desktop.getByRole('button', { name: '编辑 Alpha/Latest', exact: true }).click();
    await desktop.locator('#managed-model-remark').fill('Draft after concurrent change');
    const latest = await api('/api/models/catalog');
    await api('/api/models/catalog', { action: 'create', revision: latest.revision, models: [{ id: 'concurrent-model', name: 'External creation', enabled: false, bindings: [] }] });
    const rejected = desktop.waitForResponse(response => response.url() === `${base}/api/models/catalog` && response.request().method() === 'POST');
    await desktop.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal((await rejected).status(), 400);
    await desktop.getByRole('button', { name: '刷新目录，保留草稿', exact: true }).click();
    assert.equal(await desktop.locator('#managed-model-remark').inputValue(), 'Draft after concurrent change');
    await desktop.getByRole('button', { name: '保存', exact: true }).click();
    await desktop.getByRole('heading', { name: '编辑模型', exact: true }).waitFor({ state: 'hidden' });
    const saved = (await api('/api/models/catalog')).models;
    assert(saved.some(model => model.id === 'concurrent-model'));
    assert.equal(saved.find(model => model.id === 'Alpha/Latest').remark, 'Draft after concurrent change');
    results.expectedErrors = results.responseErrors.filter(error => error.status === 400 && error.url === `${base}/api/models/catalog`);
    assert.equal(results.expectedErrors.length, 1);
    results.responseErrors = results.responseErrors.filter(error => !results.expectedErrors.includes(error));
    const expectedConsole = results.consoleErrors.filter(error => error.text.includes('Failed to load resource') && error.text.includes('400'));
    assert.equal(expectedConsole.length, 1);
    results.consoleErrors = results.consoleErrors.filter(error => !expectedConsole.includes(error));
  });

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  await mockCatalog(mobileContext);
  await mobileContext.addInitScript(key => { localStorage.setItem('agent2api.webKey', key); localStorage.setItem('agent2api.webKey.origin', key); }, apiKey);
  mobile = await mobileContext.newPage();
  mobile.setDefaultTimeout(20000);
  attach(mobile, 'mobile');
  await step('mobile uses the same model editor without horizontal overflow or metadata loss', async () => {
    await mobile.goto(`${base}/m#models`, { waitUntil: 'domcontentloaded' });
    await mobile.getByRole('button', { name: '编辑 Alpha/Latest', exact: true }).click();
    await mobile.locator('#managed-model-id').click();
    await mobile.getByRole('option', { name: 'Maker A / Alpha/Latest', exact: true }).waitFor();
    assert.equal(await mobile.locator('[data-model-id-options]').evaluate(element => element.scrollWidth > element.clientWidth), false);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(mobile, 'mobile-model-id-picker');
    await mobile.keyboard.press('Escape');
    assert.equal(await mobile.locator('#managed-model-name, #managed-model-icon, #managed-model-group, #managed-model-type, .models-card-fields').count(), 0);
    await mobile.locator('#managed-model-remark').fill('Mobile workspace remark');
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(mobile, 'mobile-model-workspace-editor');
    await mobile.getByRole('button', { name: '保存', exact: true }).click();
    await mobile.getByRole('heading', { name: '编辑模型', exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await api('/api/models/catalog')).models.find(item => item.id === 'Alpha/Latest').developer, 'maker-a');
    assert.equal((await api('/api/models/catalog')).models.find(item => item.id === 'Alpha/Latest').remark, 'Mobile workspace remark');
    await mobile.getByRole('button', { name: '关联渠道 Alpha/Latest', exact: true }).click();
    await mobile.getByRole('combobox', { name: '账号提供商', exact: true }).click();
    await screenshot(mobile, 'mobile-association-provider-picker');
    await mobile.getByRole('option', { name: 'Second channel', exact: true }).click();
    assert.equal(await mobile.getByRole('checkbox', { name: 'Second channel / shared-model', exact: true }).isChecked(), true);
    assert.equal(await mobile.getByRole('checkbox', { name: 'Workspace channel / upstream-a', exact: true }).count(), 0);
    await mobile.getByText(longUpstreamName, { exact: true }).waitFor();
    assert.equal(await mobile.locator('.models-association-list').evaluate(element => element.scrollWidth > element.clientWidth), false, 'Long upstream display names must wrap inside the list');
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(mobile, 'mobile-model-association');
    await mobile.getByRole('button', { name: '取消', exact: true }).click();
  }, mobile);

  await step('unavailable saved associations remain intact until explicitly removed', async () => {
    await api(`/api/accounts/${secondAccountId}`, { enabled: false }, 'PATCH');
    await desktop.getByRole('button', { name: '刷新', exact: true }).click();
    await desktop.getByRole('button', { name: '关联渠道 Alpha/Latest', exact: true }).click();
    await desktop.getByText('以下关联暂时不可用，仍会保留；可手动移除。', { exact: true }).waitFor();
    await desktop.getByRole('combobox', { name: '账号提供商', exact: true }).click();
    assert.equal(await desktop.getByRole('option', { name: 'Second channel', exact: true }).count(), 0);
    await desktop.keyboard.press('Escape');
    await desktop.getByRole('button', { name: '保存关联', exact: true }).click();
    await desktop.getByRole('heading', { name: '关联渠道', exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await api('/api/models/catalog')).models.find(item => item.id === 'Alpha/Latest').bindings.length, 2);
    await desktop.getByRole('button', { name: '关联渠道 Alpha/Latest', exact: true }).click();
    await desktop.getByRole('button', { name: '移除', exact: true }).click();
    await desktop.getByRole('button', { name: '保存关联', exact: true }).click();
    await desktop.getByRole('heading', { name: '关联渠道', exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual((await api('/api/models/catalog')).models.find(item => item.id === 'Alpha/Latest').bindings, [{ provider: providerId, model: 'upstream-a' }]);
  });
} catch (error) {
  results.fatalError = String(error);
  console.error(error);
} finally {
  if (browser) await browser.close();
  server.kill();
  await new Promise(resolve => mock.close(resolve));
  fs.closeSync(serverLog);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(root, 'latest-run.txt'), out);
  console.log(`RESULTS ${path.join(out, 'results.json')}`);
  if (results.fatalError || results.steps.some(step => step.status === 'failed') || results.pageErrors.length || results.consoleErrors.length || results.failedRequests.length || results.responseErrors.length) process.exitCode = 1;
}

