import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const typescript = createRequire(new URL('../mobile/package.json', import.meta.url))('typescript')
const source = await readFile(new URL('../mobile/src/core/api-images.ts', import.meta.url), 'utf8')
const compiled = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } }).outputText

function harness() {
  let identity = 'original-server'
  const calls = [], downloads = []
  let afterRefresh = () => {}
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, DOMException,
    fetch: async (path, init) => { calls.push({ path, init }); return { ok: true, blob: async () => 'image-blob' } },
    require: name => {
      if (name === './servers') return { serverIdentity: () => identity }
      if (name.endsWith('tools-image-history')) return { downloadToolImageBlob: (file, blob) => downloads.push({ file, blob }) }
      return {
        apiCall: async (path, init) => { calls.push({ path, init }); return {} },
        resolveUrl: path => `https://original.test${path}`,
        authHeaders: () => ({ 'x-panel-token': 'panel-session' }),
        refreshPanelAuthIfExpiring: async () => afterRefresh(),
      }
    },
  })
  return { api: module.exports.imageToolApi(), calls, downloads,
    switchServer() { identity = 'next-server' }, onRefresh(callback) { afterRefresh = callback } }
}

test('mobile image settings preserve complete group and fixed-account targets without write replay', async () => {
  const state = harness()
  const config = { generation: { provider: '@routing-group', model: 'Public/Image', account_id: '' },
    editing: { provider: 'upstream', model: 'wire-edit', account_id: 'fixed-account' }, max_images: 1, max_concurrency: 2, retention_hours: 24, storage_mb: 512 }
  await state.api.load()
  await state.api.save(config)
  await state.api.remove('job/one')
  assert.equal(state.calls[0].path, '/api/tools/image-generation/config')
  assert.equal(state.calls[1].init.body, config)
  assert.equal(state.calls[1].init.noAuthReplay, true)
  assert.equal(state.calls[2].path, '/api/tools/image-generation/jobs/job%2Fone')
  assert.equal(state.calls[2].init.noAuthReplay, true)
})

test('downloads use the authenticated current server file endpoint and never a supplied external URL', async () => {
  const state = harness()
  const file = { id: 'file/one', url: 'https://untrusted.test/image.png' }
  await state.api.download(file)
  assert.equal(state.calls[0].path, 'https://original.test/api/tools/image-generation/files/file%2Fone')
  assert.equal(state.calls[0].init.headers['x-panel-token'], 'panel-session')
  assert.equal(state.downloads[0].file, file)
  assert.equal(state.downloads[0].blob, 'image-blob')
})

test('a server switch before a write or during auth refresh blocks stale image actions', async () => {
  const state = harness()
  state.onRefresh(() => state.switchServer())
  await assert.rejects(state.api.download({ id: 'old-file' }), { name: 'AbortError' })
  assert.throws(() => state.api.save({}), { name: 'AbortError' })
  assert.throws(() => state.api.remove('old-job'), { name: 'AbortError' })
  assert.equal(state.calls.length, 0)
  assert.equal(state.downloads.length, 0)
})
