import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import ts from 'typescript'

// Exercise the page's real pure selectors without mounting React or a browser.
const source = readFileSync(new URL('./keys-page.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(`${source}\nexport { modelOptions, pickedFromOptions, channelOptions };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText
const context = {
  exports: {}, window: {},
  require: id => id === '../island-lazy' ? { mountOnPage() {} }
    : id === '../i18n' ? { t: (text, args = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(args[key] ?? key)) } : {},
}
vm.runInNewContext(compiled, context)
const { modelOptions, pickedFromOptions, channelOptions } = context.exports
const plain = value => JSON.parse(JSON.stringify(value))

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

test('channel selection narrows model options and preserves existing model restrictions', () => {
  assert.deepEqual(plain(modelOptions({ a: ['public-a'], b: ['public-b'] }, ['a'], ['old-model']).map(item => item.value)), ['old-model', 'public-a'])
})

test('deleted channels are visible only for keys that already retained them', () => {
  const providers = [{ id: 'live', label: 'Live' }, { id: 'deleted', removed: true }]
  assert.deepEqual(plain(channelOptions(providers, []).map(item => item.value)), ['live'])
  const options = plain(channelOptions(providers, ['DELETED', 'missing-from-response']))
  assert.deepEqual(options.map(item => item.value), ['live', 'deleted', 'missing-from-response'])
  assert.match(options[1].label, /已移除渠道/)
  assert.match(options[2].label, /已移除渠道/)
})
