import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { filterPublicModels, selectPublicModel } from './public-model-catalog.ts'

const providers = [
  { id: 'maker-a', name: 'Maker A', models: [{ id: 'Alpha/Latest', name: 'Alpha Latest', kind: 'chat' }, { id: 'shared', name: 'Shared A', kind: 'chat' }] },
  { id: 'maker-b', name: '厂商 B', models: [{ id: 'shared', name: 'Shared B', kind: 'image' }] },
]

test('manufacturer and model search jointly filter candidates without merging identical IDs from different manufacturers', () => {
  assert.equal(filterPublicModels(providers, '', '').length, 3)
  assert.deepEqual(filterPublicModels(providers, 'maker-b', 'shared').map(row => row.model.name), ['Shared B'])
  assert.equal(filterPublicModels(providers, 'maker-a', '  ALPHA/latest  ')[0].model.id, 'Alpha/Latest')
  assert.equal(filterPublicModels(providers, '', '厂商 B')[0].provider.id, 'maker-b')
  assert.deepEqual(filterPublicModels(providers, 'deleted-maker', ''), [])
})

test('choosing a directory model fills its exact ID and display name without granting or losing upstream bindings', () => {
  const draft = { id: 'custom', name: 'Custom', enabled: false, bindings: [{ provider: 'channel-a', model: 'wire-model' }] }
  const chosen = selectPublicModel(draft, providers[0].models[0])
  assert.deepEqual(chosen, { id: 'Alpha/Latest', name: 'Alpha Latest', enabled: false, bindings: draft.bindings })
  assert.equal(draft.id, 'custom')
  assert.deepEqual(selectPublicModel({ ...draft, bindings: [] }, providers[1].models[0]).bindings, [])
})
