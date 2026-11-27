// Headless software acceptance against a disposable loopback panel. No personal browser or external authorization.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { createFixturePanelSession, installFixturePanelSession } from './fixtures/panel-session.mjs'

const output = path.resolve(process.env.UI_OUTPUT || 'F:/tmp/agent2api-full-sync-20261127')
const fixture = JSON.parse(await readFile(path.join(output, 'panel-fixture.json'), 'utf8'))
assert.equal(new URL(fixture.url).hostname, '127.0.0.1')
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true })
const status = (await (await fetch(fixture.url + '/api/panel/status')).json()).data
const session = await createFixturePanelSession(fixture.url, { username: fixture.username, password: fixture.password }, status.registered ? 'login' : 'setup')
const results = [], screenshots = [], pageErrors = [], failedResponses = []
const auth = { 'x-panel-token': session.accessToken, 'Content-Type': 'application/json' }
async function call(route, method = 'GET', body) {
  const response = await fetch(fixture.url + route, { method, headers: auth,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
  const value = await response.json()
  assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(value)}`)
  return value.data ?? value
}
async function check(name, action) {
  if (process.argv.includes('--local-direct-only') && !name.includes('local-direct')) return
  try { await action(); results.push({ name, passed: true }); console.log('PASS', name) }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message) }
}
async function screenshot(page, name) {
  const file = path.join(output, `ui-${name}.png`)
  // Capture the settled UI rather than an exiting Select/Dialog transition.
  await page.evaluate(async () => {
    const animations = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    await Promise.race([Promise.all(animations.map(animation => animation.finished.catch(() => {}))), new Promise(resolve => setTimeout(resolve, 500))])
  })
  await page.screenshot({ path: file, fullPage: false })
  screenshots.push(file)
}
async function context(mobile) {
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile })
  await installFixturePanelSession(context, fixture.url, session, process.env.UI_FIXTURE_KEY || '')
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', error => pageErrors.push({ mobile, error: error.message }))
  page.on('response', response => {
    if (response.status() >= 400 && response.url().startsWith(fixture.url)) failedResponses.push({ mobile, path: new URL(response.url()).pathname, status: response.status() })
  })
  return { context, page }
}
async function closeDialogs(page) {
  for (let attempt = 0; attempt < 3 && await page.locator('[role="dialog"]:visible').count(); attempt++) {
    const dialog = page.locator('[role="dialog"]:visible').last()
    const done = dialog.getByRole('button', { name: /^(完成|取消)$/ }).first()
    const close = dialog.getByRole('button', { name: '关闭', exact: true }).first()
    if (await done.count()) await done.click()
    else if (await close.count()) await close.click()
    else await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden', timeout: 5_000 })
  }
}
async function pluginsReady(page, mobile) {
  await page.locator('.plugins-page-layout').waitFor()
  if (mobile) {
    await page.getByRole('combobox', { name: '插件分类' }).waitFor()
    await page.getByRole('combobox', { name: '插件分类' }).click()
    await page.getByRole('option', { name: /Magpie 官方/ }).waitFor({ timeout: 30_000 })
    await page.keyboard.press('Escape')
  } else await page.locator('.plugins-category-rail').getByRole('button', { name: /Magpie 官方/ }).waitFor({ timeout: 30_000 })
}
async function selectCategory(page, mobile, label) {
  if (mobile) {
    await page.getByRole('combobox', { name: '插件分类' }).click()
    await page.getByRole('option', { name: new RegExp('^' + label) }).click()
  } else await page.locator('.plugins-category-rail').getByRole('button', { name: new RegExp('^' + label) }).click()
}
async function openTools(page, label) {
  await page.locator('.plugins-toolbar').getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('button', { name: label, exact: true }).click()
}
async function verifyLocalDirectControls(page, mobile) {
  const state = await call('/api/agents/local-direct')
  const prefix = path.resolve(fixture.home).toLowerCase() + path.sep
  assert.ok(state.agents.length, 'The actual collector registry must be available')
  for (const agent of state.agents) {
    assert.equal(agent.customPaths.length, 0, 'Disposable fixture must start without custom paths')
    for (const root of agent.detectedRoots || []) assert.ok(path.resolve(root.path).toLowerCase().startsWith(prefix), 'Only synthetic fixture data directories may be scanned')
  }
  const toggle = page.locator('[role="switch"][aria-label="本机直连采集"]')
  await toggle.waitFor()
  await screenshot(page, mobile ? 'mobile-local-direct' : 'desktop-local-direct')
  if (await toggle.getAttribute('aria-checked') !== 'false') await toggle.click()
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="本机直连采集"]')?.getAttribute('aria-checked') === 'false')
  assert.equal((await call('/api/agents/local-direct')).enabled, false)
  await page.getByRole('button', { name: /^自定义路径/ }).first().click()
  const dialog = page.getByRole('dialog').last()
  await dialog.waitFor()
  const customPath = path.join(fixture.home, mobile ? 'mobile-empty-local-records' : 'desktop-empty-local-records')
  await mkdir(customPath, { recursive: true })
  await dialog.getByRole('textbox').fill(customPath)
  await screenshot(page, mobile ? 'mobile-local-direct-paths' : 'desktop-local-direct-paths')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const saved = await call('/api/agents/local-direct')
  assert.ok(saved.agents.some(agent => agent.customPaths.includes(customPath)), 'The actual collector must persist the selected custom path')
  if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click()
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="本机直连采集"]')?.getAttribute('aria-checked') === 'true')
  await page.getByRole('button', { name: '立即同步', exact: true }).waitFor({ state: 'visible' })
  const synced = page.waitForResponse(response => response.url() === fixture.url + '/api/agents/local-direct/sync' && response.request().method() === 'POST')
  await page.getByRole('button', { name: '立即同步', exact: true }).click()
  assert.equal((await synced).status(), 200)
  await screenshot(page, mobile ? 'mobile-local-direct-synced' : 'desktop-local-direct-synced')
  const rescanned = page.waitForResponse(response => response.url() === fixture.url + '/api/agents/local-direct/sync' && response.request().postDataJSON()?.forceRescan === true)
  await page.getByRole('button', { name: '重扫全部历史', exact: true }).click()
  assert.equal((await rescanned).status(), 200)
  // Restore the only synthetic settings changed by this screen acceptance.
  await call('/api/agents/local-direct', 'PUT', { enabled: state.enabled, agents: Object.fromEntries(state.agents.map(agent => [agent.id, { enabled: agent.enabled, customPaths: agent.customPaths }])) })
}
let installed
try {
  if (process.argv.includes('--seed-public')) {
    await check('public pinned package seeds real installed/settings UI without account authorization', async () => {
      const pin = JSON.parse(await readFile(new URL('./fixtures/full-script-magpie-pin.json', import.meta.url), 'utf8'))
      let state = (await call('/api/plugins')).scripts
      installed = state.packages.find(item => item.name === pin.name)
      if (!installed) {
        const started = await call('/api/plugins/scripts/install', 'POST', { source: 'magpie:' + pin.name, version: pin.version, trusted: true })
        assert.ok(started.operation?.operationId)
        const deadline = Date.now() + 300_000
        while (Date.now() < deadline) {
          state = (await call('/api/plugins')).scripts
          if (!state.operation.active && state.operation.operationId === started.operation.operationId) {
            assert.equal(state.operation.error, null)
            state = (await call('/api/plugins')).scripts
            installed = state.packages.find(item => item.name === pin.name)
            break
          }
          await wait(250)
        }
      }
      assert.equal(installed?.version, pin.version)
      assert.equal(installed.source.integrity, pin.integrity)
      assert.equal(installed.running, true)
    })
  }
  const desktop = await context(false)
  const page = desktop.page
  await page.goto(fixture.url)
  await check('desktop reports expose local-direct switch, custom paths and actual sync while Agent stays hidden', async () => {
    assert.equal(await page.locator('.nav-item[data-page="agent"]:visible').count(), 0)
    await page.locator('.nav-item[data-page="overview"]').click()
    await verifyLocalDirectControls(page, false)
  })
  await check('desktop retains routing entry and hides retired Agent configuration', async () => {
    const routing = page.locator('.nav-item[data-page="routing"]')
    await routing.waitFor({ state: 'visible' })
    assert.equal(await page.locator('.nav-item[data-page="agent"]:visible').count(), 0)
    await routing.click()
    await page.locator('.routing-dashboard-heading').waitFor()
    await page.locator('.routing-dashboard-empty').getByText(/^加载中(?:…|\.{3})$/).waitFor({ state: 'hidden' })
    await screenshot(page, 'desktop-routing')
  })
  await check('desktop plugin category rail exposes installed/update/community/Magpie/task categories', async () => {
    await page.locator('.nav-item[data-page="plugins"]').click()
    await pluginsReady(page, false)
    for (const label of ['已安装', '可更新', 'Agent2API 社区', 'Magpie 官方', 'Magpie 推荐', 'Magpie 第三方', '定时任务']) {
      await selectCategory(page, false, label)
      await screenshot(page, 'desktop-' + label)
    }
  })
  await check('desktop plugin install and settings dialogs open', async () => {
    await selectCategory(page, false, '已安装')
    await openTools(page, '从 npm / GitHub 安装')
    await page.getByRole('dialog', { name: '安装脚本插件' }).waitFor()
    await screenshot(page, 'desktop-install')
    await closeDialogs(page)
    await openTools(page, '插件设置')
    await page.getByRole('dialog', { name: '插件设置' }).waitFor()
    await screenshot(page, 'desktop-plugin-settings')
    await closeDialogs(page)
  })
  await check('desktop actual installed package details and declared settings open', async () => {
    await closeDialogs(page)
    assert.ok(installed, 'Run --seed-public to verify a real installed plugin')
    await selectCategory(page, false, '已安装')
    const card = page.locator('[data-plugin-card], [data-plugin-row]').filter({ hasText: /Antigravity|opencode-antigravity-auth/i }).first()
    await card.waitFor()
    await card.getByRole('button', { name: /设置/ }).click()
    await page.getByRole('dialog').last().waitFor()
    await page.getByRole('dialog').last().getByText('更新／重装', { exact: true }).waitFor()
    await screenshot(page, 'desktop-installed-settings')
    await page.getByRole('dialog').last().getByRole('radio', { name: '插件介绍', exact: true }).click()
    await screenshot(page, 'desktop-installed-details')
    await closeDialogs(page)
  })
  await check('desktop add-account login UI opens without starting authorization', async () => {
    await closeDialogs(page)
    await page.locator('.nav-item[data-page="accounts"]').click()
    await page.getByRole('button', { name: /添加账号/ }).first().click()
    await page.getByRole('dialog').last().waitFor()
    await screenshot(page, 'desktop-account-login')
    await closeDialogs(page)
  })
  await desktop.context.close()

  const mobile = await context(true)
  const mp = mobile.page
  await mp.goto(fixture.url + '/m')
  const settings = () => mp.locator('nav[aria-label="主导航"]').getByRole('button', { name: '设置', exact: true }).click()
  const mobileEntry = async label => {
    // Each entry is exercised from the real default navigation independently.
    await mp.goto(fixture.url + '/m')
    await settings()
    await mp.getByText(label, { exact: true }).first().click()
  }
  for (const label of ['网络代理', '路由', '模型', 'Key', '云同步', '工具服务', '定时任务']) {
    await check(`mobile retained ${label} entry opens and provides return navigation`, async () => {
      await mobileEntry(label)
      await screenshot(mp, 'mobile-entry-' + label)
      assert.ok(await mp.locator('.fc-scroll-body').count(), 'Actual page scaffold must open')
      assert.ok(await mp.locator('nav[aria-label="主导航"]:visible').count() || await mp.getByRole('button', { name: '返回', exact: true }).count(), 'A hidden navigation entry must expose a visible return control')
      const back = mp.getByRole('button', { name: '返回', exact: true })
      if (await back.count()) await back.click()
      await mp.locator('nav[aria-label="主导航"]').getByRole('button', { name: '设置', exact: true }).waitFor()
    })
  }
  await check('mobile compact plugin categories include upstream Magpie and task groups', async () => {
    await mobileEntry('插件')
    await pluginsReady(mp, true)
    for (const label of ['已安装', '可更新', 'Agent2API 社区', 'Magpie 官方', 'Magpie 推荐', 'Magpie 第三方', '定时任务']) {
      await selectCategory(mp, true, label)
      await screenshot(mp, 'mobile-plugin-' + label)
    }
    assert.ok(await mp.locator('nav[aria-label="主导航"]:visible').count() || await mp.getByRole('button', { name: '返回', exact: true }).count(), 'Plugin subpage must expose a visible return control')
    if (await mp.getByRole('button', { name: '返回', exact: true }).count()) {
      await mp.getByRole('button', { name: '返回', exact: true }).click()
      await mp.locator('nav[aria-label="主导航"]').getByRole('button', { name: '设置', exact: true }).waitFor()
      await mobileEntry('插件')
      await pluginsReady(mp, true)
    }
    const widths = await mp.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
    assert.ok(widths.document <= widths.viewport + 2, `Mobile plugin layout overflows: ${JSON.stringify(widths)}`)
  })
  await check('mobile plugin install dialog opens', async () => {
    await selectCategory(mp, true, '已安装')
    await openTools(mp, '从 npm / GitHub 安装')
    await mp.getByRole('dialog', { name: '安装脚本插件' }).waitFor()
    await screenshot(mp, 'mobile-install')
    await closeDialogs(mp)
  })
  await check('mobile plugin settings dialog opens', async () => {
    await closeDialogs(mp)
    await openTools(mp, '插件设置')
    await mp.getByRole('dialog', { name: '插件设置' }).waitFor()
    await screenshot(mp, 'mobile-plugin-settings')
    await closeDialogs(mp)
  })
  await check('mobile actual installed package details and declared settings open', async () => {
    await closeDialogs(mp)
    assert.ok(installed, 'Run --seed-public to verify a real installed plugin')
    await selectCategory(mp, true, '已安装')
    const card = mp.locator('[data-plugin-card], [data-plugin-row]').filter({ hasText: /Antigravity|opencode-antigravity-auth/i }).first()
    await card.waitFor()
    await card.getByRole('button', { name: /设置/ }).click()
    await mp.getByRole('dialog').last().waitFor()
    await mp.getByRole('dialog').last().getByText('更新／重装', { exact: true }).waitFor()
    await screenshot(mp, 'mobile-installed-settings')
    await mp.getByRole('dialog').last().getByRole('radio', { name: '插件介绍', exact: true }).click()
    await screenshot(mp, 'mobile-installed-details')
    await closeDialogs(mp)
  })
  await check('mobile add-account login UI opens without starting authorization', async () => {
    await closeDialogs(mp)
    await mp.goto(fixture.url + '/m')
    await mp.locator('nav[aria-label="主导航"]').getByRole('button', { name: '账号', exact: true }).click()
    await mp.getByRole('button', { name: '添加第一个账号', exact: true }).click()
    await mp.getByRole('dialog').last().waitFor()
    await screenshot(mp, 'mobile-account-login')
    await closeDialogs(mp)
  })
  await check('mobile reports expose local-direct switch, custom paths and actual sync', async () => {
    await mobileEntry('报表')
    await verifyLocalDirectControls(mp, true)
  })
  await mobile.context.close()
} finally {
  await browser.close()
  const reportName = process.argv.includes('--local-direct-only') ? 'ui-local-direct-acceptance.json' : 'ui-acceptance.json'
  await writeFile(path.join(output, reportName), JSON.stringify({ base: fixture.url, results, screenshots, pageErrors, failedResponses,
    externalAuthorization: 'not performed; no personal browser or account credentials read' }, null, 2))
  console.log('REPORT', path.join(output, reportName))
}
if (results.some(result => !result.passed) || pageErrors.length) process.exitCode = 1
