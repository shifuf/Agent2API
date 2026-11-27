import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const typescript = createRequire(new URL('../ui-islands/package.json', import.meta.url))('typescript')
const source = await readFile(new URL('./tools-image-config.tsx', import.meta.url), 'utf8')
const compiled = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, jsx: typescript.JsxEmit.ReactJSX } }).outputText
const view = {
  models: [
    { id: 'Public/Image', provider: '@routing-group', provider_label: '路由组', generation: true, editing: true },
    { id: 'wire-image', provider: 'upstream', provider_label: 'Upstream', generation: true, editing: true },
    { id: 'generate-only', provider: '@routing-group', provider_label: '路由组', generation: true, editing: false },
  ],
  accounts: [{ id: 'fixed-account', name: 'Fixed account', provider: 'upstream', enabled: true }],
}

function selectors(target, editing = false) {
  const module = { exports: {} }
  vm.runInNewContext(`${compiled}\nmodule.exports.fields = TargetFields; module.exports.resolveTarget = resolveImageTarget`, {
    module, exports: module.exports,
    require: name => {
      if (name === 'react') return {}
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      if (name === '@ui') return new Proxy({}, { get: (_target, name) => name })
      if (name === './searchable-select') return { SearchableSelect: 'SearchableSelect' }
      if (name === '../ui-kit/src/i18n') return { t: value => value }
      if (name === './tools-image-types') return { emptyImageTarget: () => ({ provider: '', model: '', account_id: '' }) }
      if (name === './tools-image-history') return { ToolImageHistory: 'ToolImageHistory' }
      throw Error(`Unexpected image configuration dependency: ${name}`)
    },
  })
  const changes = []
  const tree = module.exports.fields({ target, view, editing, disabled: false, onChange: value => changes.push(value) })
  return { fields: tree.props.children.map(field => field.props.children.find(child => child.type === 'SearchableSelect').props), changes,
    resolveTarget: module.exports.resolveTarget }
}

test('image routing groups remain selectable beside upstream providers and delegate account choice to the group', () => {
  const { fields, changes } = selectors({ provider: '@routing-group', model: 'Public/Image', account_id: '' })
  assert.deepEqual(Array.from(fields[0].options, row => row.value), ['@routing-group', 'upstream'])
  assert.equal(fields[2].disabled, true)
  assert.match(fields[2].displayValue, /路由组/)
  fields[0].onValueChange('upstream')
  assert.equal(JSON.stringify(changes[0]), JSON.stringify({ provider: 'upstream', model: '', account_id: '' }))
})

test('direct upstream model targets retain fixed-account selection', () => {
  const { fields, changes } = selectors({ provider: 'upstream', model: 'wire-image', account_id: 'fixed-account' })
  assert.equal(fields[2].disabled, false)
  assert.equal(fields[2].value, 'fixed-account')
  assert.equal(fields[2].displayValue, 'Fixed account')
  fields[2].onValueChange('__auto__')
  assert.equal(changes[0].account_id, '')
  assert.equal(changes[0].provider, 'upstream')
  fields[0].onValueChange('@routing-group')
  assert.equal(JSON.stringify(changes[1]), JSON.stringify({ provider: '@routing-group', model: '', account_id: '' }))
})

test('legacy public model targets show their routing group and editing excludes generation-only groups', () => {
  const { fields, changes } = selectors({ provider: '', model: 'Public/Image', account_id: '' }, true)
  assert.equal(fields[0].value, '@routing-group')
  assert.equal(fields[1].disabled, false)
  assert.deepEqual(Array.from(fields[1].options, row => row.value), ['Public/Image'])
  fields[1].onValueChange('Public/Image')
  assert.equal(changes[0].provider, '@routing-group')
  assert.equal(changes[0].account_id, '')
})

test('saving a legacy or explicit group target clears fixed accounts while preserving direct provider bindings', () => {
  const { resolveTarget } = selectors({ provider: 'upstream', model: 'wire-image', account_id: 'fixed-account' })
  const direct = { provider: 'upstream', model: 'wire-image', account_id: 'fixed-account' }
  assert.equal(resolveTarget(direct, view), direct)
  for (const provider of ['', '@routing-group']) {
    const normalized = resolveTarget({ provider, model: 'Public/Image', account_id: 'stale-account' }, view)
    assert.equal(normalized.provider, '@routing-group')
    assert.equal(normalized.account_id, '')
    assert.equal(normalized.model, 'Public/Image')
  }
  assert.equal(resolveTarget({ provider: '', model: 'unknown-model', account_id: '' }, view).provider, '')
})
