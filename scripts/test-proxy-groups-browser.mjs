import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'
import { installFixturePanelSession } from './fixtures/panel-session.mjs'

// Invoked by test-proxy-subscriptions with an isolated server and synthetic nodes.
export async function checkGroupBrowser(base, adminKey, outputDir, administrator) {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
  await mkdir(outputDir, { recursive: true })
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    await isolateUpdateNotice(context)
    await installFixturePanelSession(context, base, administrator, adminKey)
    const errors = []
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
    const page = await context.newPage()
    await page.goto(base)
    await page.waitForFunction(() => typeof window.wbApp?.showPage === 'function')
    await page.evaluate(() => window.wbApp.showPage('proxies'))
    assert.equal(await page.getByRole('region', { name: '订阅代理组' }).count(), 0, 'Group cards are not duplicated above the pool')
    await page.getByRole('button', { name: '订阅选路：Imported YAML', exact: true }).click()
    const section = page.getByRole('region', { name: '订阅代理组' })
    await section.getByText('exit-group', { exact: true }).waitFor()
    assert.equal(await section.getByPlaceholder('搜索名称 / 地址').count(), 0, 'Groups start collapsed')
    await section.getByRole('button', { name: 'exit-group 展开', exact: true }).click()
    await section.getByPlaceholder('搜索名称 / 地址').fill('second-exit')
    const selected = section.getByRole('button', { name: /second-exit.*http/ })
    await selected.waitFor()
    assert.equal(await selected.getAttribute('aria-pressed'), 'true')
    assert.equal(await section.getByRole('button', { name: '测速', exact: true }).count(), 1)
    await section.getByPlaceholder('搜索名称 / 地址').fill('local-imported-node')
    const first = section.getByRole('button', { name: /local-imported-node.*http/ })
    await first.click()
    await page.waitForFunction(() => [...document.querySelectorAll('button[aria-pressed="true"]')].some(b => b.textContent.includes('local-imported-node')))
    await page.screenshot({ path: path.join(outputDir, 'proxy-groups-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await first.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(outputDir, 'proxy-groups-narrow.png'), fullPage: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No horizontal overflow')

    const mobile = await context.newPage()
    await mobile.setViewportSize({ width: 390, height: 844 })
    await mobile.goto(`${base}/m#proxies`)
    const subscription = mobile.getByRole('button', { name: '订阅选路：Imported YAML', exact: true })
    await subscription.waitFor()
    assert.equal(await mobile.getByRole('region', { name: '订阅代理组' }).count(), 0, 'Mobile groups also start inside a collapsed subscription')
    await subscription.click()
    const mobileSection = mobile.getByRole('region', { name: '订阅代理组' })
    await mobileSection.getByRole('button', { name: 'exit-group 展开', exact: true }).click()
    await mobileSection.getByPlaceholder('搜索名称 / 地址').fill('second-exit')
    const mobileChoice = mobileSection.getByRole('button', { name: /second-exit.*http/ })
    await mobileChoice.waitFor()
    assert.equal(await mobileChoice.getAttribute('aria-pressed'), 'false', 'Mobile reads the actual selection made on desktop')
    const [selection] = await Promise.all([
      mobile.waitForResponse(response => response.url().endsWith('/api/subscriptions/groups/select') && response.request().method() === 'POST'),
      mobileChoice.click(),
    ])
    assert.equal(selection.status(), 200, 'Mobile selection must be confirmed by the actual kernel API')
    const persistedChoice = mobileSection.getByRole('button', { name: /second-exit.*http/, pressed: true })
    await persistedChoice.waitFor()
    await subscription.click()
    await mobileSection.waitFor({ state: 'hidden' })
    await subscription.click()
    await mobileSection.getByRole('button', { name: 'exit-group 展开', exact: true }).click()
    await mobileSection.getByPlaceholder('搜索名称 / 地址').fill('second-exit')
    await persistedChoice.waitFor()
    await persistedChoice.scrollIntoViewIfNeeded()
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Mobile group controls stay within the viewport')
    await mobile.screenshot({ path: path.join(outputDir, 'proxy-groups-mobile.png'), fullPage: true })
    assert.deepEqual(errors, [])
    console.log('PASS: desktop/mobile subscription expansion, lazy members, search, confirmed selection, remount resync and responsive layout')
  } finally { await browser.close() }
}
