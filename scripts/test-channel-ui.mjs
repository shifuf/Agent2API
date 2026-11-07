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
    await desktop.getByText('手动添加对外模型，并选择渠道中的上游模型。获取上游清单不会自动发布模型。', { exact: true }).waitFor();
    await desktop.getByText('尚未添加对外模型。点击「添加模型」，选择渠道和上游模型后即可使用。', { exact: true }).waitFor();
    const catalog = await api('/api/models/catalog');
    assert.deepEqual(catalog.models, []);
    await screenshot(desktop, 'desktop-models-empty');
  });

  await step('desktop add-model dialog exposes manual model ID and bindings', async () => {
    await desktop.getByRole('button', { name: '添加模型', exact: true }).click();
    await desktop.locator('#managed-model-id').waitFor();
    await desktop.getByText('选择渠道 / 上游模型', { exact: true }).waitFor();
    await screenshot(desktop, 'desktop-model-editor-empty');
    await desktop.getByRole('button', { name: '取消', exact: true }).click();
  });

  await step('API template channel shows independent Key groups and selectable models', async () => {
    await nav('accounts');
    await desktop.getByRole('button', { name: /添加账号/ }).first().click();
    await desktop.locator('[data-provider="preset:openai"]').click();
    await desktop.locator('#custom-name-input').fill('Browser smoke template');
    await desktop.locator('#custom-baseurl-input').fill(upstreamBase);
    await desktop.locator('#create-channel-0-keys').fill('smoke-key-a\nsmoke-key-b');
    const group = desktop.locator('section').filter({ has: desktop.locator('#create-channel-0-keys') });
    await group.getByRole('button', { name: '获取模型', exact: true }).click();
    await group.getByText('upstream-a', { exact: true }).waitFor();
    assert.equal(await group.locator('#create-channel-0-models').inputValue(), '');
    await group.getByRole('combobox', { name: '用于获取模型的 Key' }).selectOption('new:1');
    await group.getByRole('button', { name: '获取模型', exact: true }).click();
    await group.getByText('upstream-b', { exact: true }).waitFor();
    await group.locator('label').filter({ hasText: /^upstream-b$/ }).click();
    assert.equal(await group.locator('#create-channel-0-models').inputValue(), 'upstream-b');
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
    await desktop.locator('#managed-model-id').fill('browser-public-model');
    await desktop.locator('#managed-model-name').fill('Browser published model');
    await desktop.getByRole('checkbox', { name: 'Browser smoke channel / upstream-a', exact: true }).check();
    await screenshot(desktop, 'desktop-model-editor-selected');
    await desktop.getByRole('button', { name: '保存', exact: true }).click();
    await desktop.getByRole('cell', { name: 'browser-public-model', exact: true }).waitFor();
    const catalog = await api('/api/models/catalog');
    assert.equal(catalog.models[0].id, 'browser-public-model');
    assert.equal(catalog.models[0].bindings[0].model, 'upstream-a');
  });

  await step('gateway Key editor exposes channel and published-model restrictions', async () => {
    await nav('keys');
    await desktop.getByRole('button', { name: '＋ 新建 Key', exact: true }).click();
    await desktop.getByLabel('可用渠道', { exact: true }).waitFor();
    await desktop.getByLabel('可用模型', { exact: true }).click();
    await desktop.getByText('browser-public-model', { exact: true }).filter({ visible: true }).waitFor();
    assert.equal(await desktop.getByText('upstream-b', { exact: true }).filter({ visible: true }).count(), 0);
    await screenshot(desktop, 'desktop-gateway-key-models');
    await desktop.keyboard.press('Escape');
    await desktop.keyboard.press('Escape');
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
    await mobile.getByRole('button', { name: '编辑', exact: true }).click();
    await mobile.locator('#mobile-model-name').fill('Edited from mobile smoke');
    await screenshot(mobile, 'mobile-model-editor');
    await mobile.getByRole('button', { name: '保存', exact: true }).click();
    await mobile.getByText('Edited from mobile smoke', { exact: true }).waitFor();
    const catalog = await api('/api/models/catalog');
    assert.equal(catalog.models.find(model => model.id === 'browser-public-model').name, 'Edited from mobile smoke');
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
