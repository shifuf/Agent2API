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
 * End-to-end centered channel dialog and contextual panel smoke with isolated data.
 * Build the UI and server first. Playwright is an optional external dependency:
 *   npm install --prefix /tmp/browser-tools playwright
 *   NODE_PATH=/tmp/browser-tools/node_modules node scripts/test-channel-drawer.mjs --server /path/to/agent2api-server
 * Or set PLAYWRIGHT_MODULE to the absolute path of the installed playwright package.
 * All browser sessions are headless and isolated from the user's profile.
 */
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/test-channel-drawer.mjs --server PATH [--browser PATH] [--output DIR] [--ui-dir DIR] [--fail-fast]');
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
const root = path.resolve(option('--output') || path.join(os.tmpdir(), 'agent2api-channel-drawer-smoke'));
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
const api = async (url, body) => {
  const response = await fetch(`${base}${url}`, { method: body ? 'POST' : 'GET', headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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
      results.steps.at(-1).activeElement = await page.evaluate(() => document.activeElement?.outerHTML).catch(() => '');
      await screenshot(page, `failed-${results.steps.length}`).catch(() => {});
      fs.writeFileSync(path.join(out, `failed-${results.steps.length}.txt`), await page.locator('body').innerText().catch(() => ''));
      fs.writeFileSync(path.join(out, `failed-${results.steps.length}.html`), await page.content().catch(() => ''));
    }
    console.error(`FAIL ${name}: ${error}`);
    if (args.includes('--fail-fast')) throw error;
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
  await context.addInitScript(key => {
    localStorage.setItem('agent2api.webKey', key);
    localStorage.setItem('agent2api.webKey.origin', key);
  }, apiKey);
  desktop = await context.newPage();
  desktop.setDefaultTimeout(20000);
  attach(desktop, 'desktop');
  // An isolated install has no provider plugins. Supply only the runtime listing
  // needed to exercise the real built-in login UI; no login request is submitted.
  await desktop.route('**/api/session', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    const state = payload.data || payload;
    if (Array.isArray(state.accounts?.providers) && !state.accounts.providers.some(item => item.id === 'deepseek-web')) {
      state.accounts.providers.push({ id: 'deepseek-web', label: 'DeepSeek 网页', category: 'web', count: 0, source: 'plugin', capabilities: {}, loginMethods: [] });
    }
    await route.fulfill({ response, json: payload });
  });
  await desktop.goto(base, { waitUntil: 'domcontentloaded' });


  await nav('accounts');
  await desktop.getByRole('button', { name: /添加账号/ }).first().click();
  await desktop.locator('[data-provider="preset:openai"]').click();

  const form = desktop.locator('[role="dialog"]').filter({ has: desktop.locator('#custom-name-input') }).last();
  const modelPanel = desktop.locator('[data-channel-panel="models"]:visible');
  const keyPanel = desktop.locator('[data-channel-panel="keys"]:visible');
  const group = index => form.locator(`[data-channel-group="${index}"]:visible`);
  const assertCentered = async locator => {
    await locator.waitFor();
    await pause(300);
    const bounds = await locator.boundingBox();
    assert(bounds, 'Channel form has no visible bounds');
    const viewport = desktop.viewportSize();
    assert(bounds.x >= 12 && bounds.y >= 12, 'Channel form must leave viewport margins: ' + JSON.stringify(bounds));
    assert(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) <= 2, 'Channel form must be horizontally centered');
    assert(bounds.height <= viewport.height - 24, 'Channel form must retain vertical margins');
    assert(bounds.width < viewport.width, 'Channel form must leave surrounding context');
  };

  await step('channel creation opens centered without a contextual panel', async () => {
    await assertCentered(form);
    assert.equal(await form.locator('[data-channel-panel]:visible').count(), 0);
    await form.getByRole('heading', { name: '添加渠道', exact: true }).waitFor();
    await screenshot(desktop, 'channel-dialog-create');
  });

  await step('channel inputs accept keyboard edits and retain Key drafts after closing', async () => {
    await desktop.locator('#custom-name-input').fill('Panel smoke channel');
    await desktop.locator('#custom-baseurl-input').fill(upstreamBase);
    const keys = desktop.locator('#create-channel-0-keys');
    await keys.click();
    await keys.pressSequentially('smoke-key-a');
    await keys.press('Enter');
    await keys.pressSequentially('smoke-key-b');
    assert.equal(await keys.inputValue(), 'smoke-key-a\nsmoke-key-b');
    await desktop.getByRole('button', { name: '添加分组', exact: true }).click();
    await desktop.locator('#create-channel-1-keys').fill('smoke-key-c');
    await desktop.keyboard.press('Escape');
    await desktop.locator('[data-provider="preset:openai"]').waitFor({ state: 'visible' });
    await desktop.locator('[data-provider="preset:openai"]').click();
    assert.equal(await keys.inputValue(), 'smoke-key-a\nsmoke-key-b');
    assert.equal(await desktop.locator('#create-channel-1-keys').inputValue(), 'smoke-key-c');
    assert.equal(await desktop.locator('#custom-name-input').inputValue(), 'Panel smoke channel');
    assert.equal(await desktop.locator('#custom-baseurl-input').inputValue(), upstreamBase);
  });

  await step('group Key inspection expands beside the centered form and Escape returns focus', async () => {
    const initial = await form.boundingBox();
    const trigger = group(0).getByRole('button', { name: '查看分组 Key', exact: true });
    await trigger.click();
    await keyPanel.getByText('smoke-key-a', { exact: true }).waitFor();
    await keyPanel.getByText('smoke-key-b', { exact: true }).waitFor();
    await assertCentered(form);
    const expanded = await form.boundingBox();
    const details = await form.locator('.channel-dialog-form').boundingBox();
    const panelBounds = await keyPanel.boundingBox();
    assert(expanded.width > initial.width + 200, 'Key inspection must expand its form');
    assert(panelBounds.x >= details.x + details.width, 'Key panel must be adjacent to the form');
    await screenshot(desktop, 'channel-dialog-keys');
    await desktop.keyboard.press('Escape');
    await keyPanel.waitFor({ state: 'hidden' });
    assert.equal(await desktop.locator('#custom-name-input').isVisible(), true);
    await desktop.waitForFunction(node => node === document.activeElement, await trigger.elementHandle(), { timeout: 3000 });
  });

  await step('fetched models require confirmation and search actions leave canceled drafts unchanged', async () => {
    await group(0).getByRole('button', { name: '获取模型', exact: true }).click();
    await modelPanel.getByRole('checkbox', { name: 'upstream-a', exact: true }).waitFor();
    assert.equal(await desktop.locator('#create-channel-0-models').inputValue(), '');
    assert.equal(await modelPanel.getByRole('checkbox', { checked: true }).count(), 0, 'Fetching must not select models');
    await modelPanel.getByRole('textbox', { name: '搜索模型', exact: true }).fill('shared');
    assert.equal(await modelPanel.getByRole('checkbox').count(), 1);
    await modelPanel.getByRole('button', { name: '全选', exact: true }).click();
    assert.equal(await modelPanel.getByRole('checkbox', { checked: true }).count(), 1);
    await modelPanel.getByRole('button', { name: '清空', exact: true }).click();
    assert.equal(await modelPanel.getByRole('checkbox', { checked: true }).count(), 0);
    await modelPanel.getByRole('textbox', { name: '搜索模型', exact: true }).fill('');
    await modelPanel.getByRole('checkbox', { name: 'upstream-a', exact: true }).click();
    await modelPanel.getByRole('button', { name: '取消', exact: true }).click();
    await modelPanel.waitFor({ state: 'hidden' });
    assert.equal(await desktop.locator('#create-channel-0-models').inputValue(), '');
  });

  await step('late model discovery cannot replace another group selection or reopen a dismissed panel', async () => {
    const delayDiscovery = async () => {
      let release;
      let started;
      const gate = new Promise(resolve => { release = resolve; });
      const received = new Promise(resolve => { started = resolve; });
      await desktop.route('**/api/custom-providers/fetch-models', async route => {
        started();
        await gate;
        await route.continue();
      }, { times: 1 });
      await group(0).getByRole('button', { name: '获取模型', exact: true }).click();
      await received;
      return async () => {
        release();
        await group(0).getByRole('button', { name: '获取模型', exact: true }).waitFor();
      };
    };
    let finish = await delayDiscovery();
    await group(1).getByRole('button', { name: '选择模型', exact: true }).click();
    await modelPanel.getByRole('textbox', { name: '自定义模型 ID', exact: true }).fill('Pending/B-draft');
    await modelPanel.getByRole('button', { name: '添加', exact: true }).click();
    await finish();
    assert.equal(await modelPanel.getByRole('checkbox', { name: 'Pending/B-draft', exact: true, checked: true }).count(), 1,
      'Late discovery must preserve the other group\'s tentative selection');
    assert.equal(await modelPanel.getByRole('checkbox', { name: 'upstream-a', exact: true }).count(), 0);
    await modelPanel.getByRole('button', { name: '取消', exact: true }).click();
    await group(1).getByRole('button', { name: '选择模型', exact: true }).click();
    finish = await delayDiscovery();
    await modelPanel.getByRole('textbox', { name: '自定义模型 ID', exact: true }).fill('Active/B-draft');
    await modelPanel.getByRole('button', { name: '添加', exact: true }).click();
    await finish();
    assert.equal(await modelPanel.getByRole('checkbox', { name: 'Active/B-draft', exact: true, checked: true }).count(), 1,
      'Editing an already-open panel must supersede an unrelated pending discovery');
    await modelPanel.getByRole('button', { name: '取消', exact: true }).click();
    finish = await delayDiscovery();
    await group(0).getByRole('button', { name: '选择模型', exact: true }).click();
    await desktop.keyboard.press('Escape');
    await finish();
    assert.equal(await modelPanel.count(), 0, 'Late discovery must not reopen a dismissed panel');
    assert.equal(await desktop.locator('#custom-name-input').isVisible(), true);
  });

  await step('each credential retains its own fetched candidates after closing and reopening', async () => {
    await group(0).getByRole('combobox', { name: '用于获取模型的 Key' }).selectOption('new:1');
    await group(0).getByRole('button', { name: '获取模型', exact: true }).click();
    await modelPanel.getByRole('checkbox', { name: 'upstream-b', exact: true }).waitFor();
    assert.equal(await modelPanel.getByRole('checkbox', { name: 'upstream-a', exact: true }).count(), 0);
    await desktop.keyboard.press('Escape');
    await desktop.keyboard.press('Escape');
    await desktop.locator('[data-provider="preset:openai"]').waitFor({ state: 'visible' });
    await desktop.keyboard.press('Escape');
    await desktop.getByRole('button', { name: /添加账号/ }).first().click();
    await desktop.locator('[data-provider="preset:openai"]').click();
    assert.equal(await group(0).getByRole('combobox', { name: '用于获取模型的 Key' }).inputValue(), 'new:1');
    await group(0).getByRole('button', { name: '选择模型', exact: true }).click();
    await modelPanel.getByRole('checkbox', { name: 'upstream-b', exact: true }).waitFor();
    assert.equal(await modelPanel.getByRole('checkbox', { checked: true }).count(), 0);
    await modelPanel.getByRole('button', { name: '取消', exact: true }).click();
    await group(0).getByRole('combobox', { name: '用于获取模型的 Key' }).selectOption('new:0');
    await group(0).getByRole('button', { name: '选择模型', exact: true }).click();
    await modelPanel.getByRole('checkbox', { name: 'upstream-a', exact: true }).waitFor();
    assert.equal(await modelPanel.getByRole('checkbox', { name: 'upstream-b', exact: true }).count(), 0);
    await modelPanel.getByRole('button', { name: '取消', exact: true }).click();
  });

  await step('refresh failure preserves fetched candidates and leaves selection unchanged', async () => {
    await desktop.route('**/api/custom-providers/fetch-models', route => route.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Expected discovery failure' }) }), { times: 1 });
    await group(0).getByRole('button', { name: '获取模型', exact: true }).click();
    await form.getByText('Expected discovery failure', { exact: true }).waitFor();
    assert.equal(await desktop.locator('#create-channel-0-models').inputValue(), '');
    await group(0).getByRole('button', { name: '选择模型', exact: true }).click();
    await modelPanel.getByRole('checkbox', { name: 'upstream-a', exact: true }).waitFor();
    await modelPanel.getByRole('button', { name: '取消', exact: true }).click();
  });

  await step('changing the endpoint invalidates an open model selection before it is applied', async () => {
    await group(0).getByRole('button', { name: '选择模型', exact: true }).click();
    await modelPanel.getByRole('checkbox', { name: 'upstream-a', exact: true }).click();
    await desktop.locator('#custom-baseurl-input').fill(`${upstreamBase}/changed`);
    await modelPanel.getByRole('button', { name: '确认选择', exact: true }).click();
    await form.getByText('Base URL、协议或 Key 已变化，请重新获取模型。', { exact: true }).waitFor();
    assert.equal(await desktop.locator('#create-channel-0-models').inputValue(), '');
    await desktop.locator('#custom-baseurl-input').fill(upstreamBase);
  });

  await step('creation saves explicitly selected group models and exact custom IDs without publishing them', async () => {
    await group(0).getByRole('combobox', { name: '用于获取模型的 Key' }).selectOption('new:1');
    await group(0).getByRole('button', { name: '选择模型', exact: true }).click();
    await modelPanel.getByRole('checkbox', { name: 'upstream-b', exact: true }).click();
    await modelPanel.getByRole('button', { name: '确认选择', exact: true }).click();
    assert.equal(await desktop.locator('#create-channel-0-models').inputValue(), 'upstream-b');
    await group(1).getByRole('button', { name: '获取模型', exact: true }).click();
    await modelPanel.getByRole('checkbox', { name: 'upstream-a', exact: true }).waitFor();
    assert.equal(await modelPanel.getByRole('checkbox', { name: 'upstream-b', exact: true }).count(), 0);
    await modelPanel.getByRole('checkbox', { name: 'upstream-a', exact: true }).click();
    await modelPanel.getByRole('textbox', { name: '自定义模型 ID', exact: true }).fill('Custom/Case-v1');
    await modelPanel.getByRole('button', { name: '添加', exact: true }).click();
    await screenshot(desktop, 'channel-dialog-models');
    await modelPanel.getByRole('button', { name: '确认选择', exact: true }).click();
    assert.equal(await desktop.locator('#create-channel-1-models').inputValue(), 'upstream-a\nCustom/Case-v1');
    await desktop.locator('#custom-create-button').click();
    await desktop.locator('#custom-name-input').waitFor({ state: 'hidden' });
    const saved = await api('/api/custom-providers');
    const provider = saved.providers.find(item => item.name === 'Panel smoke channel');
    assert(provider, 'Channel creation did not persist');
    results.providerId = provider.id;
    assert.equal(provider.keyGroups.length, 2);
    assert.deepEqual(provider.keyGroups[0].models, ['upstream-b']);
    assert.equal(provider.keyGroups[0].accountIds.length, 2);
    assert.deepEqual(provider.keyGroups[1].models, ['upstream-a', 'Custom/Case-v1']);
    assert.equal(provider.keyGroups[1].accountIds.length, 1);
    assert.deepEqual((await api('/api/models/catalog')).models, []);
  });

  await step('existing channel group editor opens above its parent and saves edits', async () => {
    assert(results.providerId, 'Creation must complete before editing');
    await desktop.getByRole('button', { name: /添加账号/ }).first().click();
    await desktop.locator('button[data-provider="' + results.providerId + '"]').click();
    await desktop.getByRole('button', { name: '管理渠道 Key 分组与模型', exact: true }).click();
    const editor = desktop.locator('[role="dialog"]').filter({ has: desktop.locator('[id="edit-channel-' + results.providerId + '-0-models"]') }).last();
    await assertCentered(editor);
    await editor.getByRole('heading', { name: /编辑渠道/ }).waitFor();
    const models = desktop.locator('[id="edit-channel-' + results.providerId + '-0-models"]');
    await models.fill('upstream-b\nshared-model');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await models.waitFor({ state: 'hidden' });
    await desktop.getByRole('button', { name: '管理渠道 Key 分组与模型', exact: true }).waitFor();
    const provider = (await api('/api/custom-providers')).providers.find(item => item.id === results.providerId);
    assert.deepEqual(provider.keyGroups[0].models, ['upstream-b', 'shared-model']);
    assert.equal(provider.keyGroups[0].accountIds.length, 2);
    await screenshot(desktop, 'channel-dialog-edit-return');
  });

  await step('nested editor preserves drafts and its backdrop closes only its own layer', async () => {
    await desktop.getByRole('button', { name: '管理渠道 Key 分组与模型', exact: true }).click();
    await desktop.getByRole('heading', { name: /编辑渠道/ }).waitFor();
    const models = desktop.locator('[id="edit-channel-' + results.providerId + '-0-models"]');
    await models.fill('upstream-b\nshared-model\nCustom/Edit-draft');
    await desktop.mouse.click(1350, 500);
    await desktop.getByRole('button', { name: '管理渠道 Key 分组与模型', exact: true }).waitFor();
    await desktop.getByRole('button', { name: '管理渠道 Key 分组与模型', exact: true }).click();
    assert.equal(await models.inputValue(), 'upstream-b\nshared-model\nCustom/Edit-draft');
    const editor = desktop.locator('[role="dialog"]').filter({ has: models }).last();
    await editor.locator('[data-channel-group="0"]').getByRole('button', { name: '查看分组 Key', exact: true }).click();
    assert.equal(await keyPanel.getByRole('combobox', { name: '移动到分组' }).count(), 2);
    await desktop.keyboard.press('Escape');
    await keyPanel.waitFor({ state: 'hidden' });
    assert.equal(await models.isVisible(), true);
    await desktop.keyboard.press('Escape');
    const append = desktop.locator('[id="append-channel-' + results.providerId + '-0-keys"]');
    await append.fill('smoke-appended-key');
    assert.equal(await append.inputValue(), 'smoke-appended-key');
    await desktop.keyboard.press('Escape');
    await desktop.locator('[data-provider="preset:openai"]').waitFor({ state: 'visible' });
    await desktop.locator('[data-provider="deepseek-web"]').click();
    const login = desktop.locator('[role="dialog"]').filter({ has: desktop.getByRole('heading', { name: '添加 DeepSeek 账号', exact: true }) }).last();
    const bounds = await login.boundingBox();
    assert(bounds.x > 100, 'Existing account login should retain its centered dialog');
    const loginName = login.getByPlaceholder('留空使用账号默认名称', { exact: true });
    await loginName.fill('Kept login draft');
    await desktop.keyboard.press('Escape');
    await desktop.locator('[data-provider="preset:openai"]').click();
    await desktop.locator('#custom-name-input').waitFor();
    await desktop.keyboard.press('Escape');
    await desktop.locator('[data-provider="deepseek-web"]').click();
    assert.equal(await loginName.inputValue(), 'Kept login draft');
    await desktop.keyboard.press('Escape');
    await desktop.keyboard.press('Escape');
  });

  await step('channel dialog and contextual selection fit a narrow desktop window', async () => {
    await desktop.setViewportSize({ width: 600, height: 800 });
    await desktop.getByRole('button', { name: /添加账号/ }).first().click();
    await desktop.locator('[data-provider="preset:openai"]').click();
    await desktop.locator('#custom-name-input').fill('Narrow window draft');
    await pause(300);
    await assertCentered(form);
    await group(0).getByRole('button', { name: '选择模型', exact: true }).click();
    await modelPanel.waitFor();
    await assertCentered(form);
    assert.equal(await form.evaluate(node => node.scrollWidth > node.clientWidth), false, 'Dialog horizontally overflows');
    assert.equal(await form.locator('.channel-dialog-form').evaluate(node => node.scrollWidth > node.clientWidth), false, 'Form horizontally overflows');
    assert.equal(await modelPanel.evaluate(node => node.scrollWidth > node.clientWidth), false, 'Model panel horizontally overflows');
    await modelPanel.getByRole('textbox', { name: '自定义模型 ID', exact: true }).fill('Narrow/Custom-ID');
    await modelPanel.getByRole('button', { name: '添加', exact: true }).click();
    await modelPanel.getByRole('button', { name: '确认选择', exact: true }).click();
    assert.equal(await desktop.locator('#create-channel-0-models').inputValue(), 'Narrow/Custom-ID');
    await screenshot(desktop, 'channel-dialog-narrow');
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
