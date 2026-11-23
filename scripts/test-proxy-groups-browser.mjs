import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'

// Invoked by test-proxy-subscriptions with an isolated server and synthetic nodes.
export async function checkGroupBrowser(base, adminKey, outputDir) {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    await isolateUpdateNotice(context)
    await context.addInitScript(key => {
      localStorage.setItem('agent2api.webKey', key)
      localStorage.setItem('agent2api.webKey.origin', key)
    }, adminKey)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base)
    await page.waitForFunction(() => typeof window.wbApp?.showPage === 'function')
    await page.evaluate(() => window.wbApp.showPage('proxies'))
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
    await page.screenshot({ path: path.join(outputDir, 'proxy-groups-narrow.png'), fullPage: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No horizontal overflow')
    assert.deepEqual(errors, [])
    console.log('PASS: group cards collapsed/lazy members, search, selected state, click selection, responsive layout')
  } finally { await browser.close() }
}
