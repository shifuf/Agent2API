import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

function fixture(category) {
  const calls = []
  const window = {
    dispatchEvent() {},
    wbApp: { currentPage: 'settings' },
    wbSystemInfoPane: { load: async () => { calls.push('system') } },
    wbUpdatePanel: { load: async () => { calls.push('update') } },
    workbuddyDesktop: new Proxy({ platform: 'web' }, { get: (target, key) => key in target ? target[key] : async () => { calls.push(key); return {} } }),
  }
  const modules = new Map()
  const load = file => {
    if (modules.has(file)) return modules.get(file)
    const exports = {}
    modules.set(file, exports)
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    vm.runInNewContext(compiled, {
      exports, window, console, Event, setTimeout, clearTimeout,
      localStorage: { getItem: key => key === 'workbuddy-desktop-settings-cat' ? category : null, setItem() {} },
      require: id => id === 'react' ? {} : id === '../i18n' ? { t: text => text }
        : load(path.resolve(path.dirname(file), id + '.ts')),
    }, { filename: file })
    return exports
  }
  return { api: load(fileURLToPath(new URL('./settings-state.ts', import.meta.url))), calls }
}

test('opening version information does not load hidden settings, storage or updates', async () => {
  const { api, calls } = fixture('system')
  await api.load()
  assert.deepEqual(calls, ['system'])
})

test('switching to version information loads it once without reloading hidden panels', async () => {
  const { api, calls } = fixture('display')
  await api.load()
  calls.length = 0
  api.selectCategory('system')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['system'])
})

test('opening update settings does not calculate system diagnostics', async () => {
  const { api, calls } = fixture('about')
  await api.load()
  assert.deepEqual(calls, ['update'])
})

test('an explicit update check does not restore the installer or load hidden settings', async () => {
  const { api, calls } = fixture('gateway')
  await api.load({ checkUpdate: true })
  assert.deepEqual(calls, [])
  assert.equal(api.getSnapshot().category, 'about')
})

test('upstream category placement loads network access, privacy and currency where they are shown', async () => {
  const gateway = fixture('gateway')
  await gateway.api.load()
  assert.ok(gateway.calls.includes('getAppSettings'))
  assert.ok(gateway.calls.includes('getBackendStatus'))
  assert.ok(!gateway.calls.includes('getPrivacy'))
  const security = fixture('security')
  await security.api.load()
  assert.ok(security.calls.includes('getPrivacy'))
  assert.ok(!security.calls.includes('getStorage'))
  const general = fixture('general')
  await general.api.load()
  assert.ok(general.calls.includes('getModelPricing'))
  assert.ok(!general.calls.includes('getStorage'))
})

test('switching categories preserves configuration drafts until the next settings load', async () => {
  const { api, calls } = fixture('gateway')
  await api.load()
  assert.ok(calls.includes('getClineHeaders'))
  calls.length = 0
  api.selectCategory('display')
  api.selectCategory('gateway')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [])
  await api.load()
  assert.ok(calls.includes('getClineHeaders'))
})

test('concurrent version refreshes share one backend request', async () => {
  let count = 0
  let finish
  const response = new Promise(resolve => { finish = resolve })
  const window = { workbuddyDesktop: { getSystemInfo: () => { count++; return response } } }
  const file = fileURLToPath(new URL('./system-info-pane.tsx', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(compiled, { exports: {}, window, console,
    require: id => id === './settings-model' ? { shared: () => window }
      : id === '../island-lazy' ? { mountOnPage() {} }
        : id === '../i18n' ? { t: text => text } : {},
  })
  const a = window.wbSystemInfoPane.load()
  const b = window.wbSystemInfoPane.load()
  finish({ app: { version: 'test' } })
  await Promise.all([a, b])
  assert.equal(count, 1)
})

test('stale unmasked version responses cannot replace a newer masked response', async () => {
  const pending = []
  const window = { workbuddyDesktop: { getSystemInfo: options => new Promise(resolve => pending.push({ options, resolve })) } }
  const file = fileURLToPath(new URL('./system-info-pane.tsx', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const context = vm.createContext({ exports: {}, window, console,
    require: id => id === './settings-model' ? { shared: () => window }
      : id === '../island-lazy' ? { mountOnPage() {} }
        : id === '../i18n' ? { t: text => text } : {},
  })
  vm.runInContext(compiled, context)
  const original = window.wbSystemInfoPane.load()
  vm.runInContext('toggleHideUsername(true)', context)
  assert.equal(vm.runInContext('getSnapshot().info', context), null)
  pending[1].resolve({ deployment: { configDir: '~/data' } })
  await window.wbSystemInfoPane.load()
  pending[0].resolve({ deployment: { configDir: '/home/private/data' } })
  await original
  assert.equal(vm.runInContext('getSnapshot().info.deployment.configDir', context), '~/data')
})
