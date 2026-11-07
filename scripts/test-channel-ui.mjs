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
  { id: 'maker-a', name: 'Maker A', models: [{ id: 'Alpha/Latest', name: 'Alpha Latest', kind: 'chat' }, { id: 'shared', name: 'Shared A', kind: 'chat' }] },
  { id: 'maker-b', name: 'Maker B', models: [{ id: 'shared', name: 'Shared B', kind: 'chat' }] },
], sourceUrl: 'https://raw.githubusercontent.com/ThinkInAIXYZ/PublicProviderConf/refs/heads/dev/dist/all.json', fetchedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stale: false };
let directoryRequests = 0;
const mockCatalog = async context => context.route('**/api/models/public-catalog', route => {
  directoryRequests++;
  const refreshed = route.request().method() === 'POST';
  return route.fulfill({ json: { success: true, data: { ...publicCatalog, stale: refreshed, ...(refreshed ? { error: 'upstream unavailable' } : {}) } } });
});
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
      await screenshot(page, `failed-${results.steps.length}`).catch(() => {});
      fs.writeFileSync(path.join(out, `failed-${results.steps.length}.txt`), await page.locator('body').innerText().catch(() => ''));
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

  await step('desktop manual model catalog starts empty', async () => {
    await nav('gateway');
    await desktop.locator('[data-model-workspace]').waitFor();
    await desktop.getByText('尚未添加模型。可从厂商目录或账号上游选择，也可填写自定义模型。', { exact: true }).waitFor();
    const catalog = await api('/api/models/catalog');
    assert.deepEqual(catalog.models, []);
    await screenshot(desktop, 'desktop-models-empty');
  });

  await step('desktop add-model dialog exposes manual model ID and separate association guidance', async () => {
    await desktop.getByRole('button', { name: '添加模型', exact: true }).click();
    await desktop.locator('#managed-model-id').waitFor();
    await desktop.getByRole('button', { name: '从目录或上游选择', exact: true }).waitFor();
    await desktop.getByText('先创建模型，再独立关联渠道。新模型默认停用。', { exact: true }).waitFor();
    assert.equal(await desktop.locator('[data-model-editor] .models-basic-fields').getByRole('checkbox').count(), 0, 'Basic model editor must not mutate channel associations');
    await screenshot(desktop, 'desktop-model-editor-empty');
    await desktop.getByRole('button', { name: '取消', exact: true }).click();
  });

  await step('preloaded manufacturer catalog fills model IDs and preserves draft on refresh failure', async () => {
    try {
      await desktop.getByRole('button', { name: '添加模型', exact: true }).click();
      await desktop.getByRole('button', { name: '从目录或上游选择', exact: true }).click();
      await desktop.getByRole('button', { name: 'Maker A / Alpha/Latest', exact: true }).waitFor();
      assert.equal(await desktop.getByRole('button', { name: / \/ shared$/ }).count(), 1, 'Duplicate model IDs appear more than once across manufacturers');
      await desktop.getByRole('combobox', { name: '模型厂商', exact: true }).selectOption('maker-a');
      await desktop.getByRole('button', { name: 'Maker A / Alpha/Latest', exact: true }).click();
      assert.equal(await desktop.locator('#managed-model-id').inputValue(), 'Alpha/Latest');
      assert.equal(await desktop.locator('#managed-model-name').inputValue(), 'Alpha Latest');
      await desktop.getByRole('button', { name: '从目录或上游选择', exact: true }).click();
      await desktop.getByRole('button', { name: '更新模型目录', exact: true }).click();
      await desktop.getByText('目录更新失败，继续使用已缓存的模型。', { exact: true }).waitFor();
      assert.equal(await desktop.locator('#managed-model-id').inputValue(), 'Alpha/Latest');
      await desktop.getByRole('combobox', { name: '模型厂商', exact: true }).selectOption('maker-b');
      assert.equal(await desktop.getByRole('button', { name: 'Maker A / Alpha/Latest', exact: true }).count(), 0);
      await desktop.getByRole('button', { name: 'Maker B / shared', exact: true }).click();
      assert.equal(await desktop.locator('#managed-model-id').inputValue(), 'shared');
      assert(directoryRequests >= 2, 'Model page did not preload and refresh the directory');
      assert.deepEqual((await api('/api/models/catalog')).models, []);
      await screenshot(desktop, 'desktop-public-model-catalog');
    } finally {
      // A failed assertion may leave either the nested picker or the model form open.
      await desktop.keyboard.press('Escape');
      await desktop.keyboard.press('Escape');
      await desktop.locator('[data-model-editor]').waitFor({ state: 'hidden' });
    }
  });

  await step('API template channel shows independent Key groups and selectable models', async () => {
    await nav('accounts');
    await desktop.getByRole('button', { name: /添加账号/ }).first().click();
    await desktop.locator('[data-provider="preset:openai"]').click();
    await desktop.locator('#custom-name-input').fill('Browser smoke template');
    await desktop.locator('#custom-baseurl-input').fill(upstreamBase);
    await desktop.locator('#create-channel-0-keys').fill('smoke-key-a\nsmoke-key-b');
    const modelGroup = desktop.locator('[data-channel-model-group="0"]:visible');
    await modelGroup.getByRole('button', { name: '获取模型', exact: true }).click();
    const modelsPanel = desktop.locator('[data-channel-panel="models"]');
    await modelsPanel.getByRole('checkbox', { name: 'upstream-a', exact: true }).waitFor();
    assert.deepEqual(await modelGroup.locator('code').allTextContents(), []);
    await modelsPanel.getByRole('button', { name: '关闭', exact: true }).click();
    await modelGroup.getByRole('combobox', { name: '用于获取模型的 Key' }).selectOption('new:1');
    await modelGroup.getByRole('button', { name: '获取模型', exact: true }).click();
    await modelsPanel.getByRole('checkbox', { name: 'upstream-b', exact: true }).check();
    await modelsPanel.getByRole('button', { name: '确认选择', exact: true }).click();
    await modelsPanel.waitFor({ state: 'hidden' });
    assert.deepEqual(await modelGroup.locator('code').allTextContents(), ['upstream-b']);
    await desktop.getByRole('button', { name: '添加分组', exact: true }).click();
    await desktop.locator('#create-channel-1-keys').waitFor();
    await screenshot(desktop, 'desktop-channel-key-groups');
    await desktop.keyboard.press('Escape');
    await desktop.keyboard.press('Escape');
  });

  let providerId;
  await step('test channel can be added without automatically publishing models', async () => {
    const channel = await api('/api/custom-providers', { name: 'Browser smoke channel', protocol: 'chat_completions', baseUrl: upstreamBase,
      keyGroups: [ { id: 'group-a', name: 'A', enabled: true, apiKeys: ['smoke-key-a'], accountIds: [], models: ['upstream-a'] },
        { id: 'group-b', name: 'B', enabled: true, apiKeys: ['smoke-key-b'], accountIds: [], models: ['upstream-b'] } ] });
    providerId = channel.provider.id;
    const catalog = await api('/api/models/catalog');
    assert.deepEqual(catalog.models, []);
    assert(catalog.sources.some(source => source.id === providerId));
  });

  await step('desktop publishes a chosen upstream model through the editor', async () => {
    await desktop.goto(base, { waitUntil: 'domcontentloaded' });
    await nav('gateway');
    await desktop.getByRole('button', { name: '添加模型', exact: true }).click();
    await desktop.getByRole('button', { name: '从目录或上游选择', exact: true }).click();
    await desktop.getByRole('combobox', { name: '模型来源', exact: true }).selectOption('upstream');
    await desktop.getByRole('button', { name: 'Browser smoke channel / upstream-a', exact: true }).click();
    assert.equal(await desktop.locator('#managed-model-id').inputValue(), 'upstream-a');
    await desktop.locator('#managed-model-id').fill('browser-public-model');
    await desktop.locator('#managed-model-name').fill('Browser published model');
    await screenshot(desktop, 'desktop-model-editor-selected');
    await desktop.getByRole('button', { name: '保存', exact: true }).click();
    await desktop.getByRole('cell', { name: 'browser-public-model', exact: true }).waitFor();
    let catalog = await api('/api/models/catalog');
    assert.equal(catalog.models[0].id, 'browser-public-model');
    assert.equal(catalog.models[0].enabled, false, 'Creating a model must not publish it');
    assert.deepEqual(catalog.models[0].bindings, [], 'Choosing an upstream candidate must not silently associate it');
    await desktop.getByRole('button', { name: '关联渠道 browser-public-model', exact: true }).click();
    const association = desktop.locator('[data-model-association]');
    await association.getByRole('checkbox', { name: 'Browser smoke channel / upstream-a', exact: true }).check();
    await association.getByRole('button', { name: '保存关联', exact: true }).click();
    await association.waitFor({ state: 'hidden' });
    await desktop.getByRole('switch', { name: '启用 browser-public-model', exact: true }).click();
    await desktop.locator('[data-model-row="browser-public-model"]').getByText('已启用', { exact: true }).waitFor();
    assert.equal(await desktop.getByRole('switch', { name: '启用 browser-public-model', exact: true }).getAttribute('aria-checked'), 'true');
    catalog = await api('/api/models/catalog');
    assert.equal(catalog.models[0].enabled, true);
    assert.equal(catalog.models[0].bindings[0].model, 'upstream-a');
  });

  await step('existing custom models can be found and opened without creating a duplicate', async () => {
    await desktop.getByRole('button', { name: '添加模型', exact: true }).click();
    await desktop.getByRole('button', { name: '从目录或上游选择', exact: true }).click();
    await desktop.getByRole('combobox', { name: '模型来源', exact: true }).selectOption('custom');
    await desktop.getByRole('button', { name: '已有自定义模型 / browser-public-model', exact: true }).click();
    await desktop.getByRole('heading', { name: '编辑模型', exact: true }).waitFor();
    assert.equal(await desktop.locator('#managed-model-id').inputValue(), 'browser-public-model');
    await desktop.getByRole('button', { name: '保存', exact: true }).click();
    await desktop.getByRole('cell', { name: 'browser-public-model', exact: true }).waitFor();
    assert.equal((await api('/api/models/catalog')).models.length, 1);
  });

  await step('gateway Key editor exposes channel and published-model restrictions', async () => {
    await nav('keys');
    await desktop.getByRole('button', { name: '＋ 新建 Key', exact: true }).click();
    await desktop.getByRole('button', { name: '选择渠道', exact: true }).waitFor();
    await desktop.getByRole('button', { name: '选择模型', exact: true }).click();
    const models = desktop.locator('[data-key-selection="models"]');
    await models.getByRole('checkbox', { name: 'browser-public-model', exact: true }).waitFor();
    assert.equal(await models.getByRole('checkbox', { name: 'upstream-b', exact: true }).count(), 0);
    await screenshot(desktop, 'desktop-gateway-key-models');
    await desktop.keyboard.press('Escape');
    await desktop.keyboard.press('Escape');
  });

  await step('disabled models disappear from Key choices while saved restrictions survive', async () => {
    const created = await api('/api/keys', { name: 'Retained browser key', allowedProviders: [providerId], allowedModels: ['browser-public-model'] });
    let catalog = await api('/api/models/catalog');
    const model = catalog.models.find(row => row.id === 'browser-public-model');
    await api('/api/models/catalog', { previousId: model.id, revision: catalog.revision, model: { ...model, enabled: false } });
    await desktop.goto(base, { waitUntil: 'domcontentloaded' });
    await nav('keys');
    await desktop.getByRole('row').filter({ hasText: 'Retained browser key' }).getByRole('button', { name: '可用范围', exact: true }).click();
    await desktop.getByRole('button', { name: '选择模型', exact: true }).click();
    await desktop.getByText('以下已保存的限制当前不可用，仍会保留；可手动移除。', { exact: true }).waitFor();
    assert.equal(await desktop.locator('[data-key-selection="models"]').getByRole('checkbox', { name: 'browser-public-model', exact: true }).count(), 0);
    await desktop.keyboard.press('Escape');
    await desktop.locator('[data-key-selection="models"]').waitFor({ state: 'hidden' });
    await screenshot(desktop, 'desktop-key-unavailable-restriction');
    await desktop.getByRole('button', { name: '保存范围', exact: true }).click();
    await desktop.getByRole('heading', { name: /可用范围/ }).waitFor({ state: 'hidden' });
    const savedKey = (await api('/api/keys')).keys.find(key => key.id === created.created.id);
    assert.deepEqual(savedKey.allowedModels, ['browser-public-model']);
    assert.deepEqual(savedKey.allowedProviders, [providerId]);
    catalog = await api('/api/models/catalog');
    await api('/api/models/catalog', { previousId: model.id, revision: catalog.revision, model });
  });

  await step('proxy subscriptions and subscription editor are accessible', async () => {
    await desktop.goto(base, { waitUntil: 'domcontentloaded' });
    await nav('proxies');
    await desktop.getByRole('button', { name: '订阅管理', exact: true }).click();
    await desktop.getByRole('button', { name: '＋ 新增订阅', exact: true }).last().click();
    await desktop.getByRole('heading', { name: '新增订阅', exact: true }).waitFor();
    await screenshot(desktop, 'desktop-proxy-subscription-editor');
    await desktop.keyboard.press('Escape');
    await desktop.keyboard.press('Escape');
  });

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  await mockCatalog(mobileContext);
  await mobileContext.addInitScript(key => {
    localStorage.setItem('agent2api.webKey', key);
    localStorage.setItem('agent2api.webKey.origin', key);
  }, apiKey);
  mobile = await mobileContext.newPage();
  mobile.setDefaultTimeout(20000);
  attach(mobile, 'mobile');
  await step('mobile model editor saves published model changes', async () => {
    await mobile.goto(`${base}/m#models`, { waitUntil: 'domcontentloaded' });
    await mobile.getByText('browser-public-model', { exact: true }).waitFor();
    await screenshot(mobile, 'mobile-models');
    await mobile.getByRole('button', { name: '编辑 browser-public-model', exact: true }).click();
    await mobile.getByRole('button', { name: '从目录或上游选择', exact: true }).click();
    await mobile.getByRole('combobox', { name: '模型厂商', exact: true }).selectOption('maker-a');
    await mobile.getByRole('button', { name: 'Maker A / Alpha/Latest', exact: true }).click();
    assert.equal(await mobile.locator('#managed-model-id').inputValue(), 'Alpha/Latest');
    await mobile.locator('#managed-model-id').fill('browser-public-model');
    await mobile.locator('#managed-model-name').fill('Edited from mobile smoke');
    await screenshot(mobile, 'mobile-model-editor');
    await mobile.getByRole('button', { name: '保存', exact: true }).click();
    await mobile.getByText('Edited from mobile smoke', { exact: true }).waitFor();
    const catalog = await api('/api/models/catalog');
    assert.equal(catalog.models.find(model => model.id === 'browser-public-model').name, 'Edited from mobile smoke');
    assert.deepEqual(catalog.models.find(model => model.id === 'browser-public-model').bindings, [{ provider: providerId, model: 'upstream-a' }]);
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'Mobile page horizontally overflows');
  }, mobile);
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
