import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import ts from 'typescript'

// Exercise the page's real pure selectors without mounting React or a browser.
const source = readFileSync(new URL('./keys-data.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText
const context = {
  exports: {}, window: {},
  require: id => id === '../island-lazy' ? { mountOnPage() {} }
    : id === '../i18n' ? { t: (text, args = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(args[key] ?? key)) } : {},
}
vm.runInNewContext(compiled, context)
const { modelOptions, pickedFromOptions, channelOptions, retainHiddenSelections } = context.exports
const plain = value => JSON.parse(JSON.stringify(value))

test('name search and status filters combine without losing enabled legacy records', () => {
  assert.equal(typeof context.exports.filterKeys, 'function', 'Key list needs a combined name/status filter')
  const rows = [
    { id: 'alpha', name: 'Office ALPHA', enabled: true },
    { id: 'beta', name: 'Office Beta', enabled: false },
    { id: 'legacy', name: 'Office Legacy' },
    { id: 'home', name: 'Home', enabled: true },
  ]
  const filter = context.exports.filterKeys
  assert.deepEqual(plain(filter(rows, ' office ', 'enabled').map(item => item.id)), ['alpha', 'legacy'])
  assert.deepEqual(plain(filter(rows, 'OFFICE', 'disabled').map(item => item.id)), ['beta'])
  assert.deepEqual(plain(filter(rows, 'absent', 'all')), [])
  assert.deepEqual(plain(filter(rows, '', 'all').map(item => item.id)), ['alpha', 'beta', 'legacy', 'home'])
})

test('selecting or clearing available results keeps hidden permissions unchanged', () => {
  const options = [{ value: 'public-a', label: 'A' }, { value: 'public-b', label: 'B' }]
  assert.deepEqual(plain(retainHiddenSelections(['deleted-model'], ['public-a', 'public-b'], options)), ['public-a', 'public-b', 'deleted-model'])
  assert.deepEqual(plain(retainHiddenSelections(['public-a', 'deleted-model'], [], options)), ['deleted-model'])
})

test('saving a missing selected channel never clears the last channel restriction', () => {
  assert.deepEqual(plain(pickedFromOptions(['custom-deleted'], [{ value: 'live', label: 'Live' }])), ['custom-deleted'])
})

test('an explicit empty selection still clears restrictions', () => {
  assert.deepEqual(plain(pickedFromOptions([], [{ value: 'custom-deleted', label: 'Deleted' }])), [])
})

test('selected spelling is canonicalized and duplicates do not multiply permissions', () => {
  assert.deepEqual(plain(pickedFromOptions(['LIVE', 'live', 'deleted', 'DELETED'], [{ value: 'live', label: 'Live' }])), ['live', 'deleted'])
})

test('no selected channel offers all manually published models', () => {
  assert.deepEqual(plain(modelOptions({ a: ['public-a'], b: ['public-b'] }, [], []).map(item => item.value)), ['public-a', 'public-b'])
  assert.deepEqual(plain(modelOptions({}, [], [])), [])
})

test('unavailable saved models are not offered as available model choices', () => {
  assert.deepEqual(plain(modelOptions({ a: ['public-a'], b: ['public-b'] }, ['a'], ['old-model']).map(item => item.value)), ['public-a'])
})

test('unavailable channels never enter the usable channel dropdown', () => {
  const providers = [{ id: 'live', label: 'Live' }, { id: 'deleted', removed: true }, { id: 'disabled', enabled: false }, { id: 'empty', count: 0 }]
  assert.deepEqual(plain(channelOptions(providers, []).map(item => item.value)), ['live'])
  const options = plain(channelOptions(providers, ['DELETED', 'missing-from-response']))
  assert.deepEqual(options.map(item => item.value), ['live'])
})

test('editing visible choices retains hidden restrictions until explicitly removed', () => {
  assert.deepEqual(plain(retainHiddenSelections(['old-model', 'public-a'], ['public-b'], [
    { value: 'public-a', label: 'A' }, { value: 'public-b', label: 'B' },
  ])), ['public-b', 'old-model'])
  assert.deepEqual(plain(retainHiddenSelections(['old-model'], [], [])), ['old-model'])
  assert.deepEqual(plain(retainHiddenSelections(['PUBLIC-A'], [], [{ value: 'public-a', label: 'A' }])), [])
})
