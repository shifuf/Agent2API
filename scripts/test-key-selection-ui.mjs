import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Real browser + API, with a fresh temporary database and synthetic credentials.
// Build the UI/server beforehand; this script never accesses the installed data directory.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/test-key-selection-ui.mjs --server PATH [--browser PATH] [--output DIR] [--ui-dir DIR]');
  console.log('Set PLAYWRIGHT_MODULE to an externally installed Playwright package when needed.');
  process.exit(0);
}
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return '';
  assert(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value for ${name}`);
  return args[index + 1];
};
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.resolve(option('--server') || process.env.AGENT2API_SERVER_BIN || path.join(repository, 'target/debug', process.platform === 'win32' ? 'agent2api-server.exe' : 'agent2api-server'));
const uiDirectory = path.resolve(option('--ui-dir') || path.join(repository, 'desktop-tauri/ui'));
assert(fs.existsSync(binary), `Server executable not found: ${binary}`);
assert(fs.existsSync(path.join(uiDirectory, 'index.html')), `Built UI not found: ${uiDirectory}`);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browserCandidates = process.platform === 'win32'
  ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const browserPath = option('--browser') || process.env.BROWSER_EXECUTABLE || browserCandidates.find(candidate => fs.existsSync(candidate));
const outputRoot = path.resolve(option('--output') || path.join(os.tmpdir(), 'agent2api-key-selection-ui'));
fs.mkdirSync(outputRoot, { recursive: true });
const out = fs.mkdtempSync(path.join(outputRoot, 'run-'));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const adminKey = `test-admin-${randomUUID()}`;
const env = { ...process.env, AGENT2API_PROXY_HOME: path.join(out, 'data'), AGENT2API_PROXY_API_KEY: adminKey,
  AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port), AGENT2API_UI_DIR: uiDirectory,
  AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0' };
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name];
const log = fs.openSync(path.join(out, 'server.log'), 'a');
const server = spawn(binary, [], { cwd: path.dirname(binary), env, windowsHide: true, stdio: ['ignore', log, log] });
const result = { steps: [], errors: [], screenshots: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const api = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(`${base}${url}`, { method, headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  assert(response.ok && payload.success !== false, `${method} ${url}: ${JSON.stringify(payload)}`);
  return payload.data ?? payload;
};
let browser;
let page;
let currentStep = 'startup';
const step = async (name, run) => {
  currentStep = name;
  await run();
  result.steps.push(name);
  console.log(`PASS ${name}`);
};
const shot = async name => {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  result.screenshots.push(file);
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`);
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
    await pause(500);
  }
  assert(ready, 'Isolated server did not become ready');
  const createChannel = name => api('/api/custom-providers', { name, protocol: 'chat_completions', baseUrl: 'http://127.0.0.1:1/v1',
    keyGroups: [{ id: 'test-group', name: 'Test', enabled: true, apiKeys: ['synthetic-upstream-key'], accountIds: [], models: ['upstream-a', 'upstream-b'] }] });
  const live = (await createChannel('Selectable channel')).provider.id;
  const retired = (await createChannel('Retired channel')).provider.id;
  for (const [id, enabled] of [['public-a', true], ['public-b', true], ['disabled-model', false]]) {
    const catalog = await api('/api/models/catalog');
    await api('/api/models/catalog', { previousId: '', revision: catalog.revision, model: { id, name: id, enabled, bindings: [{ provider: live, model: 'upstream-a' }] } });
  }
  const retained = (await api('/api/keys', { name: 'Retained key', allowedProviders: [retired], allowedModels: ['obsolete-model'] })).created;
  await api('/api/custom-providers/remove', { id: retired });
  browser = await chromium.launch({ ...(browserPath ? { executablePath: browserPath } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(key => {
    localStorage.setItem('agent2api.webKey', key);
    localStorage.setItem('agent2api.webKey.origin', key);
  }, adminKey);
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(String(error)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.nav-item[data-page="keys"]').click();
  await page.locator('.page[data-page="keys"].active').waitFor();
  let created;

  await step('selection drafts cancel without changing the Key form', async () => {
    await page.getByRole('button', { name: '＋ 新建 Key', exact: true }).click();
    await page.locator('#key-name').fill('Selection workflow key');
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    const picker = page.locator('[data-key-selection="models"]');
    await picker.waitFor();
    assert.equal(await picker.getByRole('checkbox', { name: 'public-a', exact: true }).count(), 1, await picker.ariaSnapshot());
    await picker.getByRole('checkbox', { name: 'public-a', exact: true }).check();
    assert.equal(await picker.getByRole('checkbox', { name: 'disabled-model', exact: true }).count(), 0);
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[data-key-scope="models"]').getByText('public-a', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    assert.equal(await picker.getByRole('checkbox', { name: 'public-a', exact: true }).isChecked(), false);
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#key-name').inputValue(), 'Selection workflow key');
  });

  await step('search select-all clear and confirmation produce exact restrictions', async () => {
    await page.getByRole('button', { name: '选择渠道', exact: true }).click();
    const channels = page.locator('[data-key-selection="channels"]');
    await channels.getByRole('textbox', { name: '搜索渠道', exact: true }).fill('Selectable');
    await channels.getByRole('button', { name: '全选结果', exact: true }).click();
    await channels.getByRole('button', { name: '确认选择', exact: true }).click();
    await channels.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    const models = page.locator('[data-key-selection="models"]');
    await models.getByRole('button', { name: '全选结果', exact: true }).click();
    await models.getByRole('button', { name: '清空可选项', exact: true }).click();
    assert.equal(await models.getByRole('checkbox', { name: 'public-a', exact: true }).isChecked(), false);
    await models.getByRole('textbox', { name: '搜索模型', exact: true }).fill('public-b');
    await models.getByRole('button', { name: '全选结果', exact: true }).click();
    await models.getByRole('button', { name: '确认选择', exact: true }).click();
    await models.waitFor({ state: 'hidden' });
    await shot('create-selection');
    await page.locator('[data-key-editor="create"]').getByRole('button', { name: '创建', exact: true }).click();
    await page.locator('[data-key-view]').waitFor();
    created = (await api('/api/keys')).keys.find(key => key.name === 'Selection workflow key');
    assert(created?.key, 'Creation did not generate a usable key');
    assert.deepEqual(created.allowedProviders, [live]);
    assert.deepEqual(created.allowedModels, ['public-b']);
  });

  await step('credential view masks reveals copies and hides the generated Key', async () => {
    const view = page.locator('[data-key-view]');
    assert.equal(await page.locator('#key-credential').getAttribute('type'), 'password');
    await view.getByRole('button', { name: '显示', exact: true }).click();
    assert.equal(await page.locator('#key-credential').getAttribute('type'), 'text');
    assert.equal(await page.locator('#key-credential').inputValue(), created.key);
    await view.getByRole('button', { name: '复制 Key', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), created.key);
    await view.getByRole('button', { name: '隐藏', exact: true }).click();
    assert.equal(await page.locator('#key-credential').getAttribute('type'), 'password');
    await shot('credential-view');
    await view.getByRole('button', { name: '完成', exact: true }).click();
    await view.waitFor({ state: 'hidden' });
  });

  await step('editing names and status filtering preserve the credential and scope', async () => {
    const row = page.locator(`.keys-table tr[data-id="${created.id}"]`);
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('#key-name').fill('Renamed key');
    await page.locator('[data-key-editor="edit"]').getByRole('button', { name: '保存', exact: true }).click();
    await row.getByText('Renamed key', { exact: true }).waitFor();
    await row.getByRole('switch').click();
    await row.getByText('已停用', { exact: true }).waitFor();
    assert.equal(await row.getByRole('switch').getAttribute('aria-checked'), 'false');
    await page.getByRole('textbox', { name: '搜索 Key', exact: true }).fill('RENAMED');
    await page.getByRole('combobox', { name: 'Key 状态', exact: true }).click();
    await page.getByRole('option', { name: '已启用', exact: true }).click();
    await page.getByText('没有匹配的 Key', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Key 状态', exact: true }).click();
    await page.getByRole('option', { name: '已停用', exact: true }).click();
    await row.waitFor();
    const saved = (await api('/api/keys')).keys.find(key => key.id === created.id);
    assert.equal(saved.key, created.key);
    assert.equal(saved.enabled, false);
    assert.deepEqual(saved.allowedModels, ['public-b']);
    assert.deepEqual(saved.allowedProviders, [live]);
    await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  });

  await step('clearing available choices retains unavailable saved restrictions', async () => {
    await page.locator(`.keys-table tr[data-id="${retained.id}"]`).getByRole('button', { name: '可用范围', exact: true }).click();
    for (const [kind, trigger, hidden] of [['channels', '选择渠道', retired], ['models', '选择模型', 'obsolete-model']]) {
      await page.getByRole('button', { name: trigger, exact: true }).click();
      const picker = page.locator(`[data-key-selection="${kind}"]`);
      await picker.locator('[data-key-hidden-restrictions]').getByText(hidden, { exact: true }).waitFor();
      assert.equal(await picker.getByRole('checkbox', { name: hidden, exact: true }).count(), 0);
      await picker.getByRole('button', { name: '清空可选项', exact: true }).click();
      await picker.getByRole('button', { name: '确认选择', exact: true }).click();
      await picker.waitFor({ state: 'hidden' });
    }
    await shot('hidden-restrictions');
    await page.getByRole('button', { name: '保存范围', exact: true }).click();
    await page.locator('[data-key-editor="scope"]').waitFor({ state: 'hidden' });
    const saved = (await api('/api/keys')).keys.find(key => key.id === retained.id);
    assert.deepEqual(saved.allowedProviders, [retired]);
    assert.deepEqual(saved.allowedModels, ['obsolete-model']);
  });

  await step('custom Key creation still validates minimum length and keeps the supplied value', async () => {
    await page.getByRole('button', { name: '＋ 新建 Key', exact: true }).click();
    await page.locator('#key-name').fill('Custom credential');
    await page.getByText('高级选项', { exact: true }).click();
    await page.locator('#key-value').fill('short');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('alert').getByText('Key 至少需要 8 个字符', { exact: true }).waitFor();
    await page.locator('#key-value').fill('custom-synthetic-test-key');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.locator('[data-key-view]').waitFor();
    const saved = (await api('/api/keys')).keys.find(key => key.name === 'Custom credential');
    assert.equal(saved.key, 'custom-synthetic-test-key');
  });
  assert.deepEqual(result.errors, [], 'Browser raised unhandled errors');
} catch (error) {
  result.failure = { step: currentStep, error: String(error), stack: error.stack };
  console.error(error);
  if (page) await shot('failure').catch(() => {});
  if (page) fs.writeFileSync(path.join(out, 'failure-aria.txt'), await page.locator('body').ariaSnapshot().catch(() => ''));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  fs.closeSync(log);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  console.log(`RESULTS ${path.join(out, 'results.json')}`);
}
