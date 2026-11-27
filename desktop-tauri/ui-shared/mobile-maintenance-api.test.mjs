import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const typescript = createRequire(new URL('../mobile/package.json', import.meta.url))('typescript')
const source = await readFile(new URL('../mobile/src/core/api-maintenance.ts', import.meta.url), 'utf8')
const compiled = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } }).outputText

function harness() {
  let identity = 'first-server'
  const calls = []
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, URLSearchParams, DOMException,
    require: name => name === './servers' ? { serverIdentity: () => identity } : {
      apiCall: async (path, init) => { calls.push({ path, init }); return { fixture: true } },
    },
  })
  return { api: module.exports.maintenanceApi(), calls, switchServer() { identity = 'other-server' } }
}

test('maintenance filters preserve task/source/result/search and pagination', async () => {
  const state = harness()
  await state.api.overview({ taskId: 'credentialMaintenance', source: 'manual', status: 'failed', keyword: '账号 & name', offset: 20, limit: 10 })
  const query = new URL(state.calls[0].path, 'https://panel.test').searchParams
  assert.equal(query.get('taskId'), 'credentialMaintenance')
  assert.equal(query.get('source'), 'manual')
  assert.equal(query.get('status'), 'failed')
  assert.equal(query.get('keyword'), '账号 & name')
  assert.equal(query.get('offset'), '20')
  assert.equal(query.get('limit'), '10')
})

test('manual runs and retries forbid replay after a management-session change', async () => {
  const state = harness()
  await state.api.run('credentialMaintenance')
  await state.api.retry('run/one', 'account-one')
  assert.equal(state.calls[0].path, '/api/maintenance/run/credentialMaintenance')
  assert.equal(state.calls[1].path, '/api/maintenance/records/run%2Fone/retry')
  for (const call of state.calls) {
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.noAuthReplay, true)
  }
  assert.equal(state.calls[1].init.body.itemId, 'account-one')
})

test('detail identifiers are encoded and plugin schedule fields survive saving', async () => {
  const state = harness()
  await state.api.detail('run/one')
  assert.equal(state.calls[0].path, '/api/maintenance/records/run%2Fone')
  const patch = { checkMode: 'custom', enabled: false, interval: 30, autoUpdate: false }
  await state.api.save('pluginCatalogCheck', patch)
  assert.equal(state.calls[1].path, '/api/scheduled-tasks/pluginCatalogCheck')
  assert.equal(state.calls[1].init.body, patch)
  assert.equal(state.calls[1].init.noAuthReplay, true)
})

test('a detached server panel cannot dispatch later actions to the new server', async () => {
  const state = harness()
  state.switchServer()
  await assert.rejects(state.api.run('credentialMaintenance'), { name: 'AbortError' })
  await assert.rejects(state.api.retry('old-run'), { name: 'AbortError' })
  await assert.rejects(state.api.save('pluginCatalogCheck', { enabled: true }), { name: 'AbortError' })
  assert.equal(state.calls.length, 0)
})
