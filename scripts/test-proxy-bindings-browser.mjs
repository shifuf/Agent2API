// Imported by test-proxy-bindings after the real isolated management API cases.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'
import { installFixturePanelSession } from './fixtures/panel-session.mjs'

export async function checkBindingBrowser(base, administrator, outputDirectory, forbiddenGatewayKeys = []) {
  assert.equal(forbiddenGatewayKeys.length, 3, 'Pass the unrestricted, restricted and environment Gateway Key fixtures')
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
  await mkdir(outputDirectory, { recursive: true })
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    await isolateUpdateNotice(context)
    await installFixturePanelSession(context, base, administrator, administrator.gatewayKey)
    const errors = []
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
    const desktop = await context.newPage()
    await desktop.goto(base)
    await desktop.waitForFunction(() => typeof window.wbApp?.showPage === 'function')
    await desktop.evaluate(() => window.wbApp.showPage('proxies'))
    const panel = desktop.locator('.page[data-page="proxies"]')
    await panel.getByRole('button', { name: '管理绑定', exact: true }).waitFor()
    assert.equal(await panel.getByRole('region', { name: '订阅代理组' }).count(), 0, 'Group selection is contained in a subscription expansion, not a second top panel')

    async function api(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + endpoint, { method, headers: { 'x-panel-token': administrator.accessToken, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) })
      const value = await response.json()
      assert.equal(response.status, 200, JSON.stringify(value))
      return value.data || value
    }
    const initial = await api('/api/proxies/bindings')
    const first = initial.items.find(item => item.name === 'Binding exit A').id
    const second = initial.items.find(item => item.name === 'Binding exit B').id
    const configOf = (payload, id) => payload.accounts.find(account => account.id === id).proxy?.config || null

    // A separate context has no administrator cookie or localStorage token.
    // This exercises the browser's x-api-key transport without a panel session
    // silently granting a gateway Key management authority.
    const gatewayContext = await browser.newContext()
    try {
      assert.deepEqual(await gatewayContext.cookies(), [], 'Gateway Key negative cases must have no panel cookie')
      for (const { label, key } of forbiddenGatewayKeys) {
        for (const method of ['GET', 'POST']) {
          const before = (await api('/api/proxies/bindings')).accounts
          const response = await gatewayContext.request.fetch(base + '/api/proxies/bindings', {
            method, headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
            ...(method === 'POST' ? { data: { accountIds: ['retained-0'], proxyIds: [second] } } : {}),
          })
          assert.equal(response.status(), 403, label + ' browser ' + method + ' must be denied')
          const denied = await response.json()
          assert.ok(!denied.accounts && !denied.data?.accounts)
          assert.deepEqual((await api('/api/proxies/bindings')).accounts, before, label + ' browser ' + method + ' must not change bindings')
        }
      }
    } finally { await gatewayContext.close() }
    console.log('PASS cookie-free browser gateway Keys cannot read or write proxy bindings')

    const search = panel.getByRole('searchbox', { name: '搜索节点' })
    await search.fill('Fixture channel login')
    await panel.getByText('Fixture channel', { exact: true }).waitFor()
    assert.equal(await panel.locator('tbody tr[data-id]').count(), 1, 'Bound account names filter the exit list')
    assert.ok(await panel.locator(`tr[data-id="${second}"]`).count())
    await search.fill('')

    async function selectAccount(dialog, name) {
      await dialog.getByRole('searchbox', { name: '搜索渠道 / 账号' }).fill(name)
      await dialog.locator('label').filter({ hasText: name }).getByRole('checkbox').check()
    }
    async function selectExit(dialog, name) {
      await dialog.getByRole('searchbox', { name: '搜索出口' }).fill(name)
      await dialog.locator('label').filter({ hasText: name }).getByRole('checkbox').check()
    }
    async function save(page, dialog, label = '保存绑定') {
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/proxies/bindings') && response.request().method() === 'POST'),
        dialog.getByRole('button', { name: label, exact: true }).click(),
      ])
      assert.equal(response.status(), 200)
      await dialog.waitFor({ state: 'hidden' })
      const value = await response.json()
      return value.data || value
    }

    await panel.getByRole('button', { name: '管理绑定', exact: true }).click()
    let dialog = desktop.getByRole('dialog', { name: '管理代理绑定' })
    await selectAccount(dialog, 'Retained account 200')
    await selectAccount(dialog, 'Retained account 201')
    await selectExit(dialog, 'Binding exit A')
    await selectExit(dialog, 'Binding exit B')
    const saved = await save(desktop, dialog)
    for (const id of ['retained-200', 'retained-201']) assert.deepEqual(configOf(saved, id), { source: 'rotate', all: false, proxyIds: [first, second] })
    console.log('PASS desktop binding dialog selects multiple retained accounts and multiple exits')

    // Account edits remain the authority; returning to proxies reads their new binding.
    await api('/api/accounts/retained-200', { proxy: { source: 'pool', proxyId: first } }, 'PATCH')
    await desktop.evaluate(() => { window.wbApp.showPage('accounts'); window.wbApp.showPage('proxies') })
    await search.fill('Retained account 200')
    await panel.locator(`tr[data-id="${first}"]`).waitFor()
    await desktop.waitForFunction(second => !document.querySelector(`.page[data-page="proxies"] tbody tr[data-id="${second}"]`), second)
    await search.fill('')
    await panel.getByRole('button', { name: '管理绑定', exact: true }).click()
    dialog = desktop.getByRole('dialog', { name: '管理代理绑定' })
    await selectAccount(dialog, 'Retained account 200')
    const unbound = await save(desktop, dialog, '解除所选账号绑定')
    assert.equal(configOf(unbound, 'retained-200'), null)
    assert.equal(configOf(unbound, 'retained-201').source, 'rotate', 'Unbind does not touch another selected account from an earlier batch')
    await desktop.screenshot({ path: path.join(outputDirectory, 'proxy-bindings-desktop.png'), fullPage: true })
    await desktop.setViewportSize({ width: 390, height: 844 })
    assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await desktop.screenshot({ path: path.join(outputDirectory, 'proxy-bindings-narrow.png'), fullPage: true })
    console.log('PASS inverse account edit resync, scoped desktop unbind, and narrow desktop layout')

    const mobile = await context.newPage()
    await mobile.setViewportSize({ width: 390, height: 844 })
    await mobile.goto(`${base}/m#proxies`)
    await mobile.getByRole('button', { name: '管理绑定', exact: true }).waitFor()
    assert.equal(await mobile.getByRole('region', { name: '订阅代理组' }).count(), 0)
    await mobile.getByRole('button', { name: '管理绑定', exact: true }).click()
    dialog = mobile.getByRole('dialog', { name: '管理代理绑定' })
    await selectAccount(dialog, 'Retained account 200')
    await selectAccount(dialog, 'Retained account 202')
    await selectExit(dialog, 'Binding exit A')
    await selectExit(dialog, 'Binding exit B')
    const mobileSaved = await save(mobile, dialog)
    for (const id of ['retained-200', 'retained-202']) assert.deepEqual(configOf(mobileSaved, id), { source: 'rotate', all: false, proxyIds: [first, second] })
    await mobile.getByRole('searchbox', { name: '搜索代理' }).fill('Retained account 202')
    await mobile.getByText('Retained account 202', { exact: true }).first().waitFor()
    assert.equal(await mobile.getByText('Retained account 202', { exact: true }).count(), 2)
    await mobile.getByRole('button', { name: '订阅管理', exact: true }).click()
    const subscriptions = mobile.getByRole('dialog', { name: '订阅管理' })
    await subscriptions.getByText('Binding subscription', { exact: true }).waitFor()
    await subscriptions.locator('[data-slot="dialog-footer"]').getByRole('button', { name: '关闭', exact: true }).click()
    await subscriptions.waitFor({ state: 'hidden' })
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await mobile.screenshot({ path: path.join(outputDirectory, 'proxy-bindings-mobile.png'), fullPage: true })
    assert.deepEqual(errors, [])
    console.log('PASS mobile multi-account/multi-exit binding, account search, subscription management and layout')
  } finally { await browser.close() }
}
