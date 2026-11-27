import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

function sidebar() {
  const context = vm.createContext({ window: {}, wbI18n: { t: value => value }, localStorage: { getItem: () => null } })
  vm.runInContext(readFileSync(new URL('../ui/sidebar-layout.js', import.meta.url), 'utf8'), context)
  return context.window.wbSidebarLayout
}

test('default desktop navigation keeps public routes and network proxies visible', () => {
  const api = sidebar()
  const layout = api.normalizeLayout(api.defaultLayout())
  for (const key of ['routing', 'gateway', 'proxies', 'keys', 'scheduled', 'plugins']) {
    assert.equal(api.isVisible(layout, key), true, key)
  }
  assert.equal(api.isVisible(layout, 'agent'), false)
})

test('old saved layouts retain route management without bringing back Agent configuration', () => {
  const api = sidebar()
  const layout = api.normalizeLayout({ groups: [{ id: 'legacy', items: ['agent', 'gateway', 'routing', 'proxies', 'keys', 'settings'] }], hidden: [] })
  assert.equal(api.isVisible(layout, 'routing'), true)
  assert.equal(api.isVisible(layout, 'proxies'), true)
  assert.equal(api.isVisible(layout, 'agent'), false)
})
