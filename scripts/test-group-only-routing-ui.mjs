import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1] && args.includes(name) ? args[args.indexOf(name) + 1] : '';
const binary = path.resolve(option('--server') || 'target/debug/agent2api-server.exe');
const uiDirectory = path.resolve(option('--ui-dir') || 'desktop-tauri/ui');
const out = path.join(path.resolve(option('--output') || path.join(os.tmpdir(), 'agent2api-group-only-ui')), new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browserPath = option('--browser') || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => fs.existsSync(file));
const results = { steps: [], errors: [], screenshots: [] };
const upstreamRequests = [];
const upstream = http.createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); upstreamRequests.push(payload);
    response.end(JSON.stringify({ id: 'fixture-chat', object: 'chat.completion', model: payload.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'directory-test-ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model' }, { id: 'gpt-4.1-mini', object: 'model' }, { id: 'Fetched-Custom', object: 'model' }] }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const key = `routing-ui-${randomUUID()}`;
const log = fs.openSync(path.join(out, 'server.log'), 'a');
// Real plugin RPC fixture provides image catalogs without touching installed plugins.
const pluginDir = path.join(out, 'data', 'plugins', 'ui-image-fixture', '1.0.0');
fs.mkdirSync(pluginDir, { recursive: true });
fs.copyFileSync(process.execPath, path.join(pluginDir, 'fixture.exe'));
const fixturePath = path.join(pluginDir, 'fixture.cjs');
const imageProvider = 'ui-image-source';
fs.writeFileSync(fixturePath, `
const readline = require('node:readline');
const models = [{ id: 'Wire-Image', kind: 'image', credits: 'x0.25 credits', supports_image_generation: true, supports_image_editing: true }];
let refreshed = false;
let accountSequence = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  let frame; try { frame = JSON.parse(line) } catch { return; }
  const p = frame.params || {}; let result;
  switch (frame.method) {
    case 'init': result = [{ id: 'ui-image-source', label: 'Image source', capabilities: { chat: true, model_refresh: true, refresh_uses_account: true }, default_models: models }]; break;
    case 'images.capabilities': result = { generation: true, editing: true }; break;
    case 'account.normalize': result = { identity: p.provider + '-' + (++accountSequence), secret: { token: 'fixture-' + (p.name || p.source?.payload?.name || accountSequence) }, public: { name: p.name || 'Image account', hasCredentials: true }, desktop: false }; break;
    case 'token.ensure': result = 'fixture'; break;
    case 'models.list': result = { models: refreshed ? [...models, { id: 'Fetched-Builtin', credits: 'x0.00 credits' }] : models, meta: { remote: refreshed, refreshed_at: refreshed ? Date.now() : 0 } }; break;
    case 'models.refresh': refreshed = true; result = { refreshed: true, count: 2 }; break;
    case 'shutdown': process.exit(0); break;
    default: result = null;
  }
  process.stdout.write(JSON.stringify({ id: frame.id, result }) + '\\n');
});
`);
const declared = [{ id: imageProvider, label: 'Image source' }];
fs.writeFileSync(path.join(pluginDir, 'pack.json'), JSON.stringify({ id: 'ui-image-fixture', name: 'UI image fixture', version: '1.0.0', protocol: 1,
  providers: declared, entry: { 'x86_64-pc-windows-msvc': 'fixture.exe' } }));
fs.writeFileSync(path.join(out, 'data', 'plugins', 'plugins.json'), JSON.stringify({ packs: [{ id: 'ui-image-fixture', version: '1.0.0', enabled: true,
  providers: { [imageProvider]: true }, entry: 'fixture.exe', manifest_providers: declared }] }));
const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_HOME: path.join(out, 'data'),
  AGENT2API_PROXY_API_KEY: key, AGENT2API_ACCOUNT_KEY: '7'.repeat(64), NODE_OPTIONS: `--require=${JSON.stringify(fixturePath)}`, AGENT2API_UI_DIR: uiDirectory, AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0' };
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name];
const server = spawn(binary, [], { cwd: path.dirname(binary), env, windowsHide: true, stdio: ['ignore', log, log] });
let browser;
let desktop;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const api = async (url, body, method) => {
  const response = await fetch(`${base}${url}`, { method: method || (body ? url === '/api/routing/groups' ? 'PUT' : 'POST' : 'GET'), headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert(response.ok && data.success !== false, `${url}: ${JSON.stringify(data)}`);
  return data.data ?? data;
};
const screenshot = async (page, name) => {
  const filename = path.join(out, `${name}.png`);
  await page.screenshot({ path: filename, fullPage: true, animations: 'disabled' });
  results.screenshots.push(filename);
};
const step = async (name, action) => {
  try { await action(); results.steps.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) {
    results.steps.push({ name, status: 'failed', error: String(error) });
    await screenshot(desktop, `failed-${results.steps.length}`).catch(() => {});
    if (desktop) fs.writeFileSync(path.join(out, `failed-${results.steps.length}.aria.txt`), await desktop.locator('body').ariaSnapshot().catch(() => ''));
    throw error;
  }
};
const newContext = async mobile => {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, locale: 'zh-CN' });
  await context.addInitScript(key => { localStorage.setItem('agent2api.webKey', key); localStorage.setItem('agent2api.webKey.origin', key); }, key);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => results.errors.push(String(error)));
  return page;
};
const openDetails = async (page, label) => {
  const summary = page.locator('summary').filter({ hasText: label });
  if (!await summary.evaluate(element => element.parentElement.open)) await summary.click();
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`);
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
    await pause(250);
  }
  assert(ready, 'Server did not become ready');
  for (let attempt = 0; attempt < 120 && !fs.readFileSync(path.join(out, 'server.log'), 'utf8').includes('ui-image-fixture」v1.0.0 已加载'); attempt++) await pause(250);
  assert(fs.readFileSync(path.join(out, 'server.log'), 'utf8').includes('ui-image-fixture」v1.0.0 已加载'), 'Image fixture plugin did not load');
  const sources = [];
  for (const name of ['North source', 'South source']) {
    const created = await api('/api/custom-providers', { name, protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      keyGroups: [{ id: 'main', name: 'Main', enabled: true, apiKeys: ['fixture-key'], accountIds: [], models: ['gpt-4.1', 'gpt-4.1-mini'] }] });
    sources.push(created.provider.id);
  }
  await api('/api/custom-providers', { name: 'No account', protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` });
  await api('/api/accounts', { provider: imageProvider, name: 'selected' });
  await api('/api/accounts', { provider: imageProvider, name: 'Backup account' });
  await api('/api/accounts', { provider: imageProvider, name: 'Disabled account' });
  const pluginAccounts = (await api('/api/session')).accounts.accounts.filter(account => account.provider === imageProvider);
  await api(`/api/accounts/${pluginAccounts.find(account => account.name === 'Disabled account').id}`, { enabled: false }, 'PATCH');
  const workspace = await api('/api/routing/workspace');
  for (const [id, name, kind, provider, model] of [['chat-child', 'Chat child', 'chat', sources[0], 'gpt-4.1'], ['image-child', 'Image child', 'image', imageProvider, 'Wire-Image']]) {
    const state = await api('/api/routing/groups');
    await api('/api/routing/groups', { id, revision: state.newRevision, group: { id, name, kind, model: id, enabled: false, description: '', strategy: 'order', sticky: 'auto',
      members: [{ id: `${id}-member`, provider, model, included: true, accounts: workspace.accounts.filter(account => account.provider === provider).map(account => account.id) }] } });
  }
  browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  desktop = await newContext(false);
  await desktop.goto(base, { waitUntil: 'domcontentloaded' });
  await desktop.locator('.nav-item[data-page="routing"]').click();
  await desktop.locator('[data-routing-dashboard]').waitFor();
  await step('account groups restore upstream fetching with explicit provider and eligible account selection', async () => {
    await desktop.locator('.nav-item[data-page="accounts"]').click();
    const group = desktop.locator(`.grp-band[data-provider="${imageProvider}"]`);
    fs.writeFileSync(path.join(out, 'fetch-sources.json'), JSON.stringify(await desktop.evaluate(() => ({ providers: window.wbProviders?.all?.(), accounts: window.wbApp?.getState?.()?.accounts?.accounts?.map(({ id, name, provider, available, enabled, hasCredentials, needsRelogin }) => ({ id, name, provider, available, enabled, hasCredentials, needsRelogin })) })), null, 2));
    await group.getByRole('button', { name: '获取上游模型', exact: true }).click();
    const dialog = desktop.getByRole('dialog', { name: '获取模型 — Image source', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.locator('tbody tr').count(), 1);
    await dialog.getByRole('combobox', { name: '模型来源', exact: true }).click();
    assert.equal(await desktop.getByRole('option', { name: 'Disabled account', exact: true }).count(), 0);
    await desktop.getByRole('option', { name: 'Backup account', exact: true }).click();
    const refreshed = desktop.waitForResponse(response => response.url().endsWith('/api/models/refresh') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '获取模型', exact: true }).click();
    const response = await refreshed;
    assert.deepEqual(response.request().postDataJSON(), { providers: [imageProvider], accounts: { [imageProvider]: pluginAccounts.find(account => account.name === 'Backup account').id } });
    await dialog.getByText('已刷新', { exact: true }).waitFor();
    const rateCatalog = (await api('/api/routing/groups')).catalog;
    assert.equal(rateCatalog.find(model => model.model === 'Fetched-Builtin')?.credits, 'x0.00 credits');
    assert.equal(rateCatalog.find(model => model.model === 'Wire-Image')?.credits, 'x0.25 credits');
    await screenshot(desktop, 'account-upstream-models');
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await group.getByRole('button', { name: '获取上游模型', exact: true }).click();
    assert.match(await dialog.getByRole('combobox', { name: '模型来源', exact: true }).innerText(), /Backup account/);
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await desktop.locator('#btn-fetch-upstream-models').click();
    const allDialog = desktop.getByRole('dialog', { name: '获取模型 — 内置提供商', exact: true });
    assert.equal(await allDialog.locator('tbody tr').count(), 1, 'Only credentialed built-in providers belong in this refresh scope');
    await allDialog.getByRole('button', { name: '完成', exact: true }).click();
  });
  await step('custom account group fetches and confirms models within its existing Key group', async () => {
    await desktop.locator(`.grp-band[data-provider="${sources[0]}"]`).getByRole('button', { name: '获取上游模型', exact: true }).click();
    const dialog = desktop.getByRole('dialog', { name: '编辑渠道', exact: true });
    await dialog.getByRole('button', { name: '获取模型', exact: true }).click();
    const panel = dialog.locator('[data-channel-panel="models"]');
    const model = panel.getByRole('checkbox', { name: /^Fetched-Custom(?:\s|$)/ });
    await model.waitFor();
    assert.equal(await model.isChecked(), false, 'Discovery must not implicitly widen a Key group');
    await model.check();
    await panel.getByRole('button', { name: /确认选择/ }).click();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const provider = (await api('/api/custom-providers')).providers.find(item => item.id === sources[0]);
    assert(provider.keyGroups[0].models.includes('Fetched-Custom'));
    assert.equal(provider.keyGroups[0].accountIds.length, 1);
  });
  await step('newly fetched upstream models appear in an already visited routing page', async () => {
    await desktop.locator('.nav-item[data-page="routing"]').click();
    await desktop.getByRole('button', { name: '新建路由组', exact: true }).first().click();
    const dialog = desktop.getByRole('dialog', { name: '新建路由组', exact: true });
    await dialog.getByRole('checkbox', { name: /^Image source · Fetched-Builtin(?:\s|$)/ }).waitFor();
    await dialog.getByRole('combobox', { name: '选择提供商', exact: true }).click();
    await desktop.getByRole('option', { name: /North source/ }).click();
    await dialog.getByRole('checkbox', { name: /^North source · Fetched-Custom(?:\s|$)/ }).waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  });
  await step('desktop model navigation opens the upstream directory without an independent public catalog', async () => {
    assert.equal(await desktop.locator('.nav-item[data-page="gateway"]').count(), 1, 'Upstream model management must remain accessible');
    await desktop.evaluate(() => window.wbApp.showPage('gateway'));
    await desktop.locator('.page.active[data-page="gateway"] #models').waitFor();
    assert.equal(await desktop.getByRole('button', { name: '返回对外模型', exact: true }).count(), 0);
    assert.equal(await desktop.getByRole('button', { name: '压缩路由', exact: true }).count(), 0);
    assert.equal(await desktop.getByRole('button', { name: '＋ 映射', exact: true }).count(), 0);
    await desktop.locator(`#prov-rail [data-provider="${sources[0]}"]`).click();
    await desktop.locator('#models').getByText('Fetched-Custom', { exact: true }).waitFor();
    await desktop.locator('#btn-refresh-models').click();
    const dialog = desktop.getByRole('dialog', { name: '编辑渠道', exact: true });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    const beforeEnable = (await api('/api/custom-providers')).providers.find(provider => provider.id === sources[0]);
    await api('/api/custom-providers/models', { providerId: sources[0], models: beforeEnable.models.map(model => ({ ...model, enabled: model.id === 'gpt-4.1' ? false : model.enabled })), mappings: beforeEnable.mappings || [] });
    await api('/api/custom-providers/models', { providerId: sources[0], models: beforeEnable.models.map(model => ({ ...model, enabled: model.id === 'gpt-4.1' ? false : model.enabled })),
      mappings: [...(beforeEnable.mappings || []), { alias: 'gpt-4.1', target: 'gpt-4.1-mini', enabled: true }] });
    await desktop.reload();
    await desktop.evaluate(() => window.wbApp.showPage('gateway'));
    await desktop.locator(`#prov-rail [data-provider="${sources[0]}"]`).click();
    const customEnabled = desktop.locator('#models').getByRole('switch', { name: '启用上游模型 gpt-4.1', exact: true });
    assert.equal(await customEnabled.count(), 1, 'Previously disabled custom sources need an enable control');
    assert.equal(await customEnabled.isChecked(), false);
    const customSaved = desktop.waitForResponse(response => response.url().endsWith('/api/custom-providers/models') && response.request().method() === 'POST');
    await customEnabled.click();
    assert.equal((await customSaved).status(), 200, 'Source re-enable must resolve retired same-ID aliases');
    const afterEnable = (await api('/api/custom-providers')).providers.find(provider => provider.id === sources[0]);
    assert.equal(afterEnable.models.find(model => model.id === 'gpt-4.1').enabled, true);
    assert.equal(afterEnable.mappings.find(mapping => mapping.alias === 'gpt-4.1').enabled, false);
    assert.deepEqual(afterEnable.keyGroups, beforeEnable.keyGroups, 'Source enable must preserve Key-group restrictions');
    await desktop.locator(`#prov-rail [data-provider="${imageProvider}"]`).click();
    await desktop.locator('#btn-refresh-models').click();
    const refreshDialog = desktop.getByRole('dialog', { name: '获取模型 — Image source', exact: true });
    await refreshDialog.waitFor();
    assert.equal(await refreshDialog.locator('tbody tr').count(), 1);
    assert.match(await refreshDialog.getByRole('combobox', { name: '模型来源', exact: true }).innerText(), /Backup account/);
    await refreshDialog.getByRole('button', { name: '完成', exact: true }).click();
    const enabled = desktop.getByRole('switch', { name: '启用上游模型 Fetched-Builtin', exact: true });
    const changed = desktop.waitForResponse(response => response.url().endsWith('/api/models/state'));
    await enabled.click();
    assert.equal((await changed).status(), 200);
    const builtin = (await api('/api/models/manage')).models.find(model => model.id === 'Fetched-Builtin');
    assert.equal(builtin.enabled, false);
    assert.equal((await api('/api/routing/groups')).catalog.some(model => model.model === 'Fetched-Builtin' && model.enabled !== false), false);
    const restored = desktop.waitForResponse(response => response.url().endsWith('/api/models/state'));
    await enabled.click(); await restored;
    assert.deepEqual(await api('/v1/models'), [], 'Upstream directory selection must not publish public model IDs');
    await screenshot(desktop, 'upstream-directory');
    const sourceState = await api('/api/routing/groups');
    const child = sourceState.groups.find(row => row.group.id === 'chat-child');
    await api('/api/routing/groups', { id: child.group.id, revision: child.revision, group: { ...child.group, model: 'Public/Chat', enabled: true } });
    await api('/api/keys', { name: 'Source test scoped Key', allowedProviders: [sources[0]], allowedModels: ['Public/Chat'] });
    await desktop.locator(`#prov-rail [data-provider="${sources[0]}"]`).click();
    await desktop.locator('#models tr[data-model-id="gpt-4.1"]').getByRole('button', { name: '测试', exact: true }).click();
    const test = desktop.getByRole('dialog', { name: /^测试模型/ });
    await test.locator('#model-test-api-key').click();
    await desktop.getByRole('option', { name: /^Source test scoped Key/ }).click();
    assert.equal(await test.getByRole('button', { name: '开始测试', exact: true }).isEnabled(), true, 'A Key for a public group must permit testing its differently named upstream');
    await test.getByRole('switch').click();
    const tested = desktop.waitForResponse(response => response.url().endsWith('/api/models/test'));
    await test.getByRole('button', { name: '开始测试', exact: true }).click();
    const testResponse = await tested;
    const testResult = await testResponse.json();
    assert.equal(testResponse.status(), 200);
    assert.equal((testResult.data || testResult).success, true, JSON.stringify(testResult));
    assert.equal(upstreamRequests.at(-1).model, 'gpt-4.1');
    await desktop.keyboard.press('Escape');
    await test.getByRole('button', { name: '关闭', exact: true }).first().click();
    const testedChild = (await api('/api/routing/groups')).groups.find(row => row.group.id === 'chat-child');
    await api('/api/routing/groups', { id: child.group.id, revision: testedChild.revision, group: child.group });
    await desktop.getByRole('button', { name: '管理路由组', exact: true }).click();
    await desktop.locator('[data-routing-dashboard]').waitFor();
  });
  await step('one create flow offers chat and image groups without independent model routes', async () => {
    await desktop.getByRole('button', { name: '新建路由组', exact: true }).first().click();
    const dialog = desktop.getByRole('dialog', { name: '新建路由组', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('radio', { name: '模型独立路由', exact: true }).count(), 0);
    await dialog.getByRole('radio', { name: '对话', exact: true }).waitFor();
    await dialog.getByRole('radio', { name: '图像', exact: true }).waitFor();
    await dialog.locator('.routing-model-rate').filter({ hasText: '0.00x' }).waitFor();
    await screenshot(desktop, 'create-route-free-rate');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await desktop.getByRole('button', { name: '全局网关设置', exact: true }).click();
    assert.equal(await desktop.getByText('模型路由', { exact: true }).count(), 0);
    await desktop.getByRole('radio', { name: '请求回放', exact: true }).click();
    await desktop.getByText('历史只读，不影响当前配置', { exact: true }).waitFor();
  });
  await desktop.getByRole('radio', { name: '路由配置', exact: true }).click();
  await desktop.getByRole('button', { name: '路由组概览', exact: true }).click();
  await step('raw upstream IDs can publish groups and provider selections survive switching', async () => {
    await desktop.getByRole('button', { name: '新建路由组', exact: true }).click();
    const dialog = desktop.getByRole('dialog', { name: '新建路由组', exact: true });
    const source = dialog.getByRole('combobox', { name: '选择提供商', exact: true });
    await source.click();
    assert.deepEqual(await desktop.getByRole('option').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), ['Image source', 'North source', 'South source']);
    await desktop.getByRole('option', { name: 'North source', exact: true }).click();
    assert.equal(await dialog.locator('.routing-model-rate').count(), 0, 'Unknown rates must not be presented as free');
    await dialog.getByRole('checkbox', { name: /^North source · gpt-4\.1(?:\s|$)/ }).check();
    await source.click();
    await desktop.getByRole('option', { name: 'South source', exact: true }).click();
    await dialog.getByRole('checkbox', { name: /^South source · gpt-4\.1-mini(?:\s|$)/ }).check();
    await dialog.getByRole('button', { name: '移除 North source · gpt-4.1', exact: true }).waitFor();
    await source.click();
    await desktop.getByRole('option', { name: 'North source', exact: true }).click();
    assert.equal(await dialog.getByRole('checkbox', { name: /^North source · gpt-4\.1(?:\s|$)/ }).isChecked(), true);
    await dialog.getByRole('textbox', { name: '组名', exact: true }).fill('Raw-name route');
    await dialog.getByRole('textbox', { name: '对外模型 ID', exact: true }).fill('gpt-4.1');
    await screenshot(desktop, 'create-chat-group');
    await dialog.getByRole('button', { name: '创建草稿', exact: true }).click();
    await desktop.getByRole('switch', { name: '路由组启用', exact: true }).click();
    const saved = desktop.waitForResponse(response => response.url().endsWith('/api/routing/groups') && response.request().method() === 'PUT');
    await desktop.getByRole('button', { name: '保存路由', exact: true }).click();
    assert.equal((await saved).status(), 200);
    const group = (await api('/api/routing/groups')).groups.find(row => row.group.model === 'gpt-4.1').group;
    assert.equal(group.kind, 'chat');
    assert.deepEqual(group.members.map(member => [member.provider, member.model]), [[sources[0], 'gpt-4.1'], [sources[1], 'gpt-4.1-mini']]);
    await desktop.getByRole('button', { name: '路由组概览', exact: true }).click();
  });
  await step('duplicate errors identify saved groups and unsaved drafts', async () => {
    await desktop.getByRole('button', { name: '新建路由组', exact: true }).click();
    let dialog = desktop.getByRole('dialog', { name: '新建路由组', exact: true });
    await dialog.getByRole('textbox', { name: '组名', exact: true }).fill('Local draft');
    await dialog.getByRole('textbox', { name: '对外模型 ID', exact: true }).fill('GPT-4.1');
    await dialog.getByRole('button', { name: '创建草稿', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Raw-name route' }).waitFor();
    await dialog.getByRole('textbox', { name: '对外模型 ID', exact: true }).fill('Reserved/Draft');
    await dialog.getByRole('button', { name: '创建草稿', exact: true }).click();
    await desktop.getByRole('button', { name: '路由组概览', exact: true }).click();
    await desktop.getByRole('button', { name: '新建路由组', exact: true }).click();
    dialog = desktop.getByRole('dialog', { name: '新建路由组', exact: true });
    await dialog.getByRole('textbox', { name: '组名', exact: true }).fill('Another draft');
    await dialog.getByRole('textbox', { name: '对外模型 ID', exact: true }).fill('reserved/draft');
    await dialog.getByRole('button', { name: '创建草稿', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Local draft' }).waitFor();
    await screenshot(desktop, 'duplicate-draft-source');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  });
  await step('image groups filter upstream and nested choices and retain public ID casing', async () => {
    await desktop.getByRole('button', { name: '新建路由组', exact: true }).click();
    const dialog = desktop.getByRole('dialog', { name: '新建路由组', exact: true });
    await dialog.getByRole('radio', { name: '图像', exact: true }).check();
    await dialog.getByRole('combobox', { name: '选择提供商', exact: true }).click();
    assert.deepEqual(await desktop.getByRole('option').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), ['Image source']);
    await desktop.getByRole('option', { name: 'Image source', exact: true }).click();
    await dialog.getByRole('checkbox', { name: /^Image source · Wire-Image(?:\s|$)/ }).check();
    await dialog.locator('.routing-model-rate').filter({ hasText: '0.25x' }).waitFor();
    await screenshot(desktop, 'create-route-paid-rate');
    assert.equal(await dialog.getByRole('checkbox', { name: /gpt-4/ }).count(), 0);
    await dialog.getByRole('textbox', { name: '组名', exact: true }).fill('Image route');
    await dialog.getByRole('textbox', { name: '对外模型 ID', exact: true }).fill('Public/Image');
    await dialog.getByRole('button', { name: '创建草稿', exact: true }).click();
    await desktop.locator('.routing-config-provider .routing-model-rate').filter({ hasText: '0.25x' }).waitFor();
    assert.equal(await desktop.locator('summary').filter({ hasText: '推理与模型信息' }).count(), 0);
    await desktop.getByRole('button', { name: '添加模型', exact: true }).click();
    const members = desktop.getByRole('dialog', { name: '添加参与模型', exact: true });
    await members.getByRole('radio', { name: '嵌套路由组', exact: true }).check();
    assert.equal(await members.getByText('Chat child', { exact: true }).count(), 0);
    await members.getByText('Image child', { exact: true }).click();
    await members.getByRole('button', { name: /^添加 · 1$/ }).click();
    const saved = desktop.waitForResponse(response => response.url().endsWith('/api/routing/groups') && response.request().method() === 'PUT');
    await desktop.getByRole('button', { name: '保存路由', exact: true }).click();
    assert.equal((await saved).status(), 200);
    const group = (await api('/api/routing/groups')).groups.find(row => row.group.model === 'Public/Image').group;
    assert.equal(group.kind, 'image');
    assert.equal(group.members[0].model, 'Wire-Image');
    assert.equal(group.members[1].group, 'image-child');
    await screenshot(desktop, 'image-group-editor');
  });
  await step('mobile restores source models and keeps public model editing in routing groups', async () => {
    const scoped = (await api('/api/custom-providers', { name: 'Mobile scoped source', protocol: 'chat_completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [
        { id: 'allowed', name: 'Allowed', enabled: true, apiKeys: ['mobile-allowed'], models: ['gpt-4.1'] },
        { id: 'disabled', name: 'Disabled', enabled: false, apiKeys: ['mobile-disabled'], models: ['gpt-4.1-mini'] },
      ] })).provider;
    const mobileSourceBefore = (await api('/api/custom-providers')).providers.find(provider => provider.id === scoped.id);
    await api('/api/custom-providers/models', { providerId: scoped.id,
      models: mobileSourceBefore.models.map(model => ({ ...model, enabled: false })), mappings: mobileSourceBefore.mappings || [] });
    const mobile = await newContext(true);
    await mobile.goto(`${base}/m#models`, { waitUntil: 'domcontentloaded' });
    await mobile.locator('[data-screen="models"]').waitFor();
    const source = mobile.locator(`[data-model-provider="${scoped.id}"]`);
    const mobileEnabled = source.getByRole('switch', { name: '启用上游模型 gpt-4.1', exact: true });
    await mobileEnabled.waitFor();
    assert.equal(await mobileEnabled.isChecked(), false);
    const enabledResponse = mobile.waitForResponse(response => response.url().endsWith('/api/custom-providers/models') && response.request().method() === 'POST');
    await mobileEnabled.click(); await enabledResponse;
    await source.getByRole('button', { name: '选择模型', exact: true }).first().click();
    const selection = mobile.getByRole('dialog', { name: '编辑渠道', exact: true });
    await selection.locator('[data-channel-model-group="0"]').getByRole('button', { name: '获取模型', exact: true }).click();
    const panel = selection.locator('[data-channel-panel="models"]');
    await panel.getByRole('checkbox', { name: /^Fetched-Custom(?:\s|$)/ }).check();
    await panel.getByRole('button', { name: '确认选择', exact: true }).click();
    await selection.getByRole('button', { name: '保存', exact: true }).click();
    await selection.waitFor({ state: 'hidden' });
    const updated = (await api('/api/custom-providers')).providers.find(provider => provider.id === scoped.id);
    assert.deepEqual(updated.keyGroups.map(group => ({ id: group.id, enabled: group.enabled, models: group.models })), [
      { id: 'allowed', enabled: true, models: ['gpt-4.1', 'Fetched-Custom'] },
      { id: 'disabled', enabled: false, models: ['gpt-4.1-mini'] },
    ]);
    assert.deepEqual(updated.keyGroups.map(group => group.accountIds), mobileSourceBefore.keyGroups.map(group => group.accountIds));
    assert.equal(updated.models.find(model => model.id === 'gpt-4.1').enabled, true);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(mobile, 'mobile-upstream-models');
    await mobile.getByRole('button', { name: '管理路由组', exact: true }).click();
    await mobile.locator('[data-routing-dashboard]').waitFor();
    assert.equal(await mobile.locator('[data-screen="routing"]').count(), 1);
    await mobile.getByRole('button', { name: '新建路由组', exact: true }).click();
    const dialog = mobile.getByRole('dialog', { name: '新建路由组', exact: true });
    await dialog.getByRole('radio', { name: '图像', exact: true }).check();
    await dialog.getByRole('checkbox', { name: /^Image source · Wire-Image(?:\s|$)/ }).check();
    await dialog.locator('.routing-model-rate').filter({ hasText: '0.25x' }).waitFor();
    await dialog.getByRole('textbox', { name: '组名', exact: true }).fill('Mobile image');
    await dialog.getByRole('textbox', { name: '对外模型 ID', exact: true }).fill('Mobile/Image');
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(mobile, 'mobile-create-image-group');
    await dialog.getByRole('button', { name: '创建草稿', exact: true }).click();
    await mobile.locator('[data-mobile-routing-editor] .routing-model-rate').filter({ hasText: '0.25x' }).waitFor();
    await mobile.getByRole('textbox', { name: '组名', exact: true }).fill('Mobile edited');
    await mobile.getByRole('textbox', { name: '对外模型 ID', exact: true }).fill('Mobile/Edited');
    const saved = mobile.waitForResponse(response => response.url().endsWith('/api/routing/groups') && response.request().method() === 'PUT');
    await mobile.getByRole('button', { name: '保存路由', exact: true }).click();
    assert.equal((await saved).status(), 200);
    const group = (await api('/api/routing/groups')).groups.find(row => row.group.model === 'Mobile/Edited').group;
    assert.equal(group.name, 'Mobile edited'); assert.equal(group.kind, 'image');
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(mobile, 'mobile-image-group-editor');
    await mobile.goto(`${base}/m#more`, { waitUntil: 'domcontentloaded' });
    await mobile.reload({ waitUntil: 'domcontentloaded' });
    await mobile.getByRole('button', { name: '模型管理', exact: true }).waitFor();
    await mobile.getByRole('button', { name: '网关 Key', exact: true }).waitFor();
  });
} catch (error) { results.fatalError = String(error); console.error(error); process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  server.kill();
  await new Promise(resolve => upstream.close(resolve));
  fs.closeSync(log);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`RESULTS ${path.join(out, 'results.json')}`);
  if (results.errors.length) process.exitCode = 1;
}
