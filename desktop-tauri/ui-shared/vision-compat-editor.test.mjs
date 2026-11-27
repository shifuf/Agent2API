import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const typescript = createRequire(new URL('../ui-islands/package.json', import.meta.url))('typescript')
const source = await readFile(new URL('../ui-islands/src/islands/routing-vision-dialog.tsx', import.meta.url), 'utf8')
const compiled = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, jsx: typescript.JsxEmit.ReactJSX } }).outputText

function harness(api) {
  let adapter
  const module = { exports: {} }
  const editor = { saving: false, dirty: false, discard() {} }
  const panel = () => null
  const elements = new Proxy({}, { get: (_target, name) => name })
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: name => {
      if (name === 'react') return { useState: value => [value, () => {}], useMemo: factory => factory() }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      if (name === '@ui') return elements
      if (name === '../i18n') return { t: value => value }
      if (name === './routing-special-panels') return { VisionSpecialPanel: panel }
      if (name === './routing-special-state') return { useSpecialEditor: value => { adapter = value; return editor } }
      throw Error(`Unexpected editor dependency: ${name}`)
    },
  })
  module.exports.VisionAssistSettings({ api })
  return adapter
}

test('the shared desktop/mobile editor preserves complete multi-rule revisions and group references', async () => {
  const calls = []
  const view = { revision: 'current-revision', config: { enabled: true, rules: [
    { mode: 'assist', models: [{ provider: '@routing-group', model: 'Public/Text' }], target: { provider: '@routing-group', model: 'Public/Vision', reasoning: '' }, reuseResults: true },
    { mode: 'reroute', models: [{ provider: 'upstream', model: 'wire-text' }], preferCurrentRoute: false, targets: [{ provider: 'other', model: 'wire-vision' }] },
  ] } }
  const adapter = harness(async (method, path, body) => { calls.push({ method, path, body }); return view })
  assert.equal(await adapter.load(), view)
  assert.equal(await adapter.save({ config: view.config, revision: view.revision }), view)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[1].method, 'PUT')
  assert.equal(calls[1].path, '/api/vision-compatibility')
  assert.equal(calls[1].body.config, view.config)
  assert.equal(calls[1].body.revision, view.revision)
  assert.equal(calls[1].body.consent, true)
  assert.equal(calls[1].body.config.rules.length, 2)
})

test('revision conflicts reach the shared editor without retrying a reduced legacy configuration', async () => {
  let requests = 0
  const conflict = new Error('revision conflict')
  const adapter = harness(async () => { requests++; throw conflict })
  await assert.rejects(adapter.save({ config: { enabled: true, rules: [] }, revision: 'old-revision' }), error => error === conflict)
  assert.equal(requests, 1)
})
