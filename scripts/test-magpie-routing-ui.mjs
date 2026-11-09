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
const out = path.join(path.resolve(option('--output') || path.join(os.tmpdir(), 'agent2api-magpie-ui')), new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browserPath = option('--browser') || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => fs.existsSync(file));
const results = { steps: [], errors: [], screenshots: [] };
const upstream = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model' }, { id: 'gpt-4.1-mini', object: 'model' }] }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const key = `routing-ui-${randomUUID()}`;
const log = fs.openSync(path.join(out, 'server.log'), 'a');
const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_HOME: path.join(out, 'data'),
  AGENT2API_PROXY_API_KEY: key, AGENT2API_UI_DIR: uiDirectory, AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0' };
for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name];
const server = spawn(binary, [], { cwd: path.dirname(binary), env, windowsHide: true, stdio: ['ignore', log, log] });
let browser;
let desktop;
let dynamicMemberId;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const api = async (url, body) => {
  const response = await fetch(`${base}${url}`, { method: body ? url === '/api/routing/groups' ? 'PUT' : 'POST' : 'GET', headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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
  const sources = [];
  for (const name of ['North source', 'South source']) {
    const result = await api('/api/custom-providers', { name, protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      keyGroups: [{ id: 'main', name: 'Main', enabled: true, apiKeys: [`key-${name}`], accountIds: [], models: ['gpt-4.1', 'gpt-4.1-mini'] }] });
    sources.push(result.provider.id);
  }
  const unavailable = await api('/api/custom-providers', { name: 'No logged-in account', protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` });
  await api('/api/custom-providers/models', { providerId: unavailable.provider.id, models: [{ id: 'unavailable-model' }], mappings: [] });
  await api('/api/custom-providers', { name: 'No fetched models', protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    keyGroups: [{ id: 'empty', apiKeys: ['no-models'], models: [] }] });
  for (const [id, name] of [['primary-route', 'Primary route'], ['child-route', 'Child route']]) {
    const state = await api('/api/routing/groups');
    const workspace = await api('/api/routing/workspace');
    await api('/api/routing/groups', { id, revision: state.newRevision, group: { id, name, model: id, description: '', strategy: 'order', sticky: 'auto',
      members: sources.map((provider, index) => ({ id: `${id}-${index}`, provider, model: 'gpt-4.1', included: true,
        accounts: workspace.accounts.filter(account => account.provider === provider).map(account => account.id) })) } });
  }
  browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  desktop = await newContext(false);
  await desktop.goto(base, { waitUntil: 'domcontentloaded' });
  await desktop.locator('.nav-item[data-page="routing"]').click();
  await step('routing dashboard searches connected sources and shows automatic suggestions', async () => {
    await desktop.locator('[data-routing-dashboard]').waitFor();
    assert.equal(await desktop.locator('[data-routing-dashboard]').count(), 1);
    await desktop.getByRole('textbox', { name: '搜索路由组、厂商或模型', exact: true }).fill('North source');
    await desktop.locator('[data-routing-group="primary-route"]').waitFor();
    await desktop.getByRole('textbox', { name: '搜索路由组、厂商或模型', exact: true }).fill('');
    await desktop.getByRole('switch', { name: '启用自动同模型路由', exact: true }).waitFor();
    await screenshot(desktop, 'routing-dashboard');
  });
  await step('new group offers only connected providers and keeps selections across provider changes', async () => {
    await desktop.getByRole('button', { name: '新建路由组', exact: true }).click();
    const dialog = desktop.getByRole('dialog', { name: '新建路由组', exact: true });
    const source = dialog.getByRole('combobox', { name: '选择提供商', exact: true });
    await source.click();
    assert.deepEqual(await desktop.getByRole('option').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), ['North source', 'South source']);
    await desktop.getByRole('option', { name: 'North source', exact: true }).click();
    const north = dialog.getByRole('checkbox', { name: /^North source · gpt-4\.1(?: |$)/ });
    await north.check();
    await source.click();
    await desktop.getByRole('option', { name: 'South source', exact: true }).click();
    assert.equal(await dialog.getByRole('checkbox', { name: /^North source/ }).count(), 0);
    await dialog.getByRole('textbox', { name: '搜索模型', exact: true }).fill('mini');
    assert.equal(await dialog.getByRole('checkbox').count(), 1);
    await dialog.getByRole('checkbox', { name: /^South source · gpt-4\.1-mini(?: |$)/ }).check();
    await dialog.getByRole('button', { name: '移除 North source · gpt-4.1', exact: true }).waitFor();
    await source.click();
    await desktop.getByRole('option', { name: 'North source', exact: true }).click();
    assert.equal(await north.isChecked(), true);
    assert.equal(await dialog.getByRole('textbox', { name: '搜索模型', exact: true }).inputValue(), '');
    await dialog.getByRole('textbox', { name: '组名', exact: true }).fill('日常路由');
    await dialog.getByRole('textbox', { name: '对外模型 ID', exact: true }).fill('daily-route');
    await screenshot(desktop, 'routing-create-group');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api('/api/routing/groups')).groups.length, 2);
  });
  await step('overview refresh updates available sources while retaining saved routes', async () => {
    await api('/api/custom-providers/update', { id: sources[0], enabled: false });
    const refresh = desktop.waitForResponse(response => response.url().endsWith('/api/routing/groups') && response.request().method() === 'GET', { timeout: 10000 });
    await desktop.getByRole('button', { name: '重新读取', exact: true }).click();
    assert.equal((await refresh).status(), 200);
    await desktop.locator('[data-routing-group="primary-route"]').waitFor();
    await desktop.getByRole('button', { name: '新建路由组', exact: true }).click();
    const dialog = desktop.getByRole('dialog', { name: '新建路由组', exact: true });
    await dialog.getByRole('combobox', { name: '选择提供商', exact: true }).click();
    assert.deepEqual(await desktop.getByRole('option').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), ['South source']);
    await desktop.getByRole('option', { name: 'South source', exact: true }).click();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await api('/api/custom-providers/update', { id: sources[0], enabled: true });
    const restored = desktop.waitForResponse(response => response.url().endsWith('/api/routing/groups') && response.request().method() === 'GET');
    await desktop.getByRole('button', { name: '重新读取', exact: true }).click();
    assert.equal((await restored).status(), 200);
  });
  await step('discovery toggle uses the collection revision and keeps saved groups', async () => {
    const response = desktop.waitForResponse(response => response.url().endsWith('/api/routing/groups/actions') && response.request().method() === 'POST');
    await desktop.getByRole('switch', { name: '启用自动同模型路由', exact: true }).click();
    assert.equal((await response).status(), 200);
    const state = await api('/api/routing/groups');
    assert.equal(state.autoGroupsEnabled, true);
    assert.equal(state.groups.length, 2);
  });
  await step('group editor saves strategies timeouts metadata member options and conditional rules', async () => {
    await desktop.locator('[data-routing-group="primary-route"]').getByRole('button', { name: '编辑路由组', exact: true }).click();
    await desktop.getByRole('combobox', { name: '路由策略', exact: true }).selectOption('weight');
    await desktop.getByRole('combobox', { name: '会话粘滞', exact: true }).selectOption('strict');
    await openDetails(desktop, '超时与故障回退');
    await desktop.getByRole('spinbutton', { name: '首内容超时（秒）', exact: true }).fill('12');
    await desktop.getByRole('spinbutton', { name: '短暂失败等待（秒）', exact: true }).fill('45');
    await openDetails(desktop, '推理与模型信息');
    assert.deepEqual(await desktop.getByRole('combobox', { name: '默认推理等级', exact: true }).locator('option').evaluateAll(options => options.map(option => option.value)), ['', 'auto']);
    await desktop.getByRole('spinbutton', { name: '上下文窗口', exact: true }).fill('128000');
    await desktop.getByRole('textbox', { name: '模型系列', exact: true }).fill('GPT');
    await openDetails(desktop, '动态模型匹配');
    await desktop.getByRole('textbox', { name: '匹配表达式（每行一条）', exact: true }).fill(`${sources[0]}/gpt-4.1-mini`);
    await desktop.getByRole('combobox', { name: '路由策略', exact: true }).selectOption('manual');
    const manualPick = desktop.getByRole('combobox', { name: '手动指定成员', exact: true });
    const dynamicOption = manualPick.locator('option').filter({ hasText: `${sources[0]} / gpt-4.1-mini` });
    await dynamicOption.waitFor({ state: 'attached' });
    dynamicMemberId = await dynamicOption.getAttribute('value');
    assert(dynamicMemberId && !['primary-route-0', 'primary-route-1'].includes(dynamicMemberId));
    await manualPick.selectOption(dynamicMemberId);
    await desktop.getByRole('combobox', { name: '路由策略', exact: true }).selectOption('weight');
    await desktop.getByRole('button', { name: '展开全部', exact: true }).click();
    const member = desktop.locator('[data-route-node="primary-route-0"]');
    await member.getByRole('spinbutton', { name: '成员权重', exact: true }).fill('3');
    await member.getByRole('combobox', { name: '账号范围', exact: true }).selectOption('all');
    await member.getByRole('combobox', { name: '成员推理等级', exact: true }).selectOption('high');
    await member.getByRole('checkbox', { name: '快速模式', exact: true }).check();
    await openDetails(desktop, '条件规则与意图分类');
    await desktop.getByRole('button', { name: '添加条件规则', exact: true }).click();
    await desktop.getByRole('combobox', { name: '目标成员', exact: true }).selectOption(dynamicMemberId);
    await desktop.getByRole('spinbutton', { name: '输入 Token 阈值', exact: true }).fill('10000');
    await screenshot(desktop, 'routing-advanced-editor');
    const saved = desktop.waitForResponse(response => response.url().endsWith('/api/routing/groups') && response.request().method() === 'PUT');
    await desktop.getByRole('button', { name: '保存路由', exact: true }).click();
    assert.equal((await saved).status(), 200);
    const group = (await api('/api/routing/groups')).groups.find(row => row.group.id === 'primary-route').group;
    assert.equal(group.strategy, 'weight'); assert.equal(group.sticky, 'strict'); assert.equal(group.firstToken, 12); assert.equal(group.patience, 45);
    assert.equal(group.context, 128000); assert.equal(group.members[0].weight, 3); assert.equal(group.members[0].accountScope, 'all');
    assert.equal(group.members[0].fast, true); assert.equal(group.rules[0].tokens, 10000);
    assert.equal(group.rules[0].use, dynamicMemberId); assert.equal(group.pick, dynamicMemberId);
    assert.deepEqual(group.members.map(member => member.id), ['primary-route-0', 'primary-route-1']);
  });
  await step('rule preview accepts request facts and simulated classification without saving the group', async () => {
    const before = (await api('/api/routing/groups')).groups.find(row => row.group.id === 'primary-route').group;
    await openDetails(desktop, '规则预演输入');
    await desktop.getByRole('spinbutton', { name: '预演输入 Token 数', exact: true }).fill('20000');
    await desktop.getByRole('combobox', { name: '预演请求推理等级', exact: true }).selectOption('high');
    await desktop.getByRole('textbox', { name: '预演客户端', exact: true }).fill('codex');
    await desktop.getByLabel('预演时间（本地时间）', { exact: true }).fill('2026-11-08T13:30');
    await desktop.getByRole('checkbox', { name: '预演包含图片', exact: true }).check();
    await desktop.getByRole('checkbox', { name: '预演上下文压缩', exact: true }).check();
    await desktop.getByRole('textbox', { name: '预演工作目录', exact: true }).fill('~/project');
    await desktop.getByRole('textbox', { name: '预演用户目录', exact: true }).fill('/home/test');
    await desktop.getByRole('checkbox', { name: '提供模拟分类结果', exact: true }).check();
    await desktop.getByRole('textbox', { name: '模拟分类意图', exact: true }).fill('complex task');
    const previewResponse = desktop.waitForResponse(response => response.url().endsWith('/api/routing/preview')
      && response.request().postDataJSON()?.classification?.effort === 'medium');
    await desktop.getByRole('combobox', { name: '模拟分类推理等级', exact: true }).selectOption('medium');
    const response = await previewResponse;
    assert.equal(response.status(), 200);
    const request = response.request().postDataJSON();
    assert.equal(request.facts.tokens, 20000); assert.equal(request.facts.agent, 'codex');
    assert.equal(request.facts.images, true); assert.equal(request.facts.compact, true);
    assert.equal(request.facts.folder, '~/project'); assert.equal(request.facts.home, '/home/test');
    assert.equal(request.facts.effort, 'high'); assert(Number.isFinite(request.facts.atMs));
    assert.deepEqual(request.classification, { intent: 'complex task', effort: 'medium' });
    await openDetails(desktop, '规则命中记录');
    const trace = desktop.locator('[data-rule-trace-group="primary-route"]');
    await trace.locator('[data-rule-match="0"]').waitFor();
    await trace.getByText('使用模拟分类结果', { exact: true }).waitFor();
    await screenshot(desktop, 'routing-rule-preview');
    await desktop.getByRole('spinbutton', { name: '预演输入 Token 数', exact: true }).fill('0');
    await trace.getByText('没有命中规则', { exact: true }).waitFor();
    await desktop.getByRole('button', { name: '重置预演输入', exact: true }).click();
    await trace.getByText('预演未调用分类器', { exact: true }).waitFor();
    assert.deepEqual((await api('/api/routing/groups')).groups.find(row => row.group.id === 'primary-route').group, before);
  });
  await step('template is an unpublished local draft and legacy configuration and replay stay reachable', async () => {
    await desktop.getByRole('button', { name: '路由组概览', exact: true }).click();
    await desktop.getByRole('button', { name: '路由模板', exact: true }).click();
    await desktop.getByRole('button', { name: '均衡分担', exact: true }).click();
    assert.equal(await desktop.getByRole('switch', { name: '路由组启用', exact: true }).getAttribute('aria-checked'), 'false');
    assert.equal((await api('/api/routing/groups')).groups.length, 2);
    await desktop.getByRole('button', { name: '全局网关设置', exact: true }).click();
    await desktop.getByText('全局默认', { exact: true }).first().waitFor();
    await desktop.getByRole('radio', { name: '请求回放', exact: true }).click();
    await desktop.getByText('历史只读，不影响当前配置', { exact: true }).waitFor();
  });
  await step('mobile uses the same advanced fields and persists a group without overflow', async () => {
    const mobile = await newContext(true);
    await mobile.goto(`${base}/m#routing`, { waitUntil: 'domcontentloaded' });
    await mobile.locator('[data-routing-dashboard]').waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(mobile, 'mobile-routing-dashboard');
    await mobile.getByRole('button', { name: '新建路由组', exact: true }).click();
    const createDialog = mobile.getByRole('dialog', { name: '新建路由组', exact: true });
    await createDialog.getByRole('combobox', { name: '选择提供商', exact: true }).waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(mobile, 'mobile-routing-create');
    await createDialog.getByRole('button', { name: '取消', exact: true }).click();
    await mobile.locator('[data-routing-group="primary-route"]').getByRole('button', { name: '编辑路由组', exact: true }).click();
    await openDetails(mobile, '规则预演输入');
    await mobile.getByRole('spinbutton', { name: '预演输入 Token 数', exact: true }).fill('20000');
    await openDetails(mobile, '规则命中记录');
    await mobile.locator('[data-rule-trace-group="primary-route"] [data-rule-match="0"]').waitFor();
    await mobile.getByRole('combobox', { name: '路由策略', exact: true }).selectOption('manual');
    await mobile.getByRole('combobox', { name: '手动指定成员', exact: true }).selectOption(dynamicMemberId);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(mobile, 'mobile-routing-editor');
    const saved = mobile.waitForResponse(response => response.url().endsWith('/api/routing/groups') && response.request().method() === 'PUT');
    await mobile.getByRole('button', { name: '保存路由', exact: true }).click();
    assert.equal((await saved).status(), 200);
    const group = (await api('/api/routing/groups')).groups.find(row => row.group.id === 'primary-route').group;
    assert.equal(group.strategy, 'manual'); assert.equal(group.pick, dynamicMemberId); assert.equal(group.rules[0].tokens, 10000);
    assert.deepEqual(group.members.map(member => member.id), ['primary-route-0', 'primary-route-1']);
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
