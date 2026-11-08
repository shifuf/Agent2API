import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as catalogHelpers from './public-model-catalog.ts'
const { filterPublicModels, selectPublicModel } = catalogHelpers

const providers = [
  { id: 'maker-a', name: 'Maker A', models: [{ id: 'Alpha/Latest', name: 'Alpha Latest', kind: 'chat' }, { id: 'shared', name: 'Shared A', kind: 'chat' }] },
  { id: 'maker-b', name: '厂商 B', models: [{ id: 'shared', name: 'Shared B', kind: 'image' }] },
]

test('manufacturer and search filters keep a single candidate for each exact model ID', () => {
  assert.equal(filterPublicModels(providers, '', '').length, 2)
  assert.deepEqual(filterPublicModels(providers, 'maker-b', 'shared').map(row => row.model.name), ['Shared B'])
  assert.equal(filterPublicModels(providers, 'maker-a', '  ALPHA/latest  ')[0].model.id, 'Alpha/Latest')
  assert.equal(filterPublicModels(providers, '', '厂商 B')[0].provider.id, 'maker-b')
  assert.deepEqual(filterPublicModels(providers, 'deleted-maker', ''), [])
})

test('picker combines directory, configured upstreams and saved custom IDs without duplicate rows', () => {
  const sources = [
    { id: 'channel-a', name: 'Channel A', accountCount: 1, models: [{ id: 'Alpha/Latest', name: 'Upstream Alpha' }, { id: 'Private/Model', name: 'Private model' }] },
    { id: 'empty', name: 'No accounts', accountCount: 0, models: [{ id: 'ghost' }] },
  ]
  const saved = [{ id: 'my-custom', name: 'My custom alias', enabled: true, bindings: [{ provider: 'channel-a', model: 'Private/Model' }] }]
  const rows = catalogHelpers.modelCandidates(providers, sources, saved, { origin: '', manufacturer: '', search: '' })
  assert.deepEqual(rows.map(row => row.model.id).sort(), ['Alpha/Latest', 'Private/Model', 'my-custom', 'shared'].sort())
  assert.deepEqual(rows.find(row => row.model.id === 'Alpha/Latest').origins, ['directory', 'upstream'])
  assert.deepEqual(catalogHelpers.modelCandidates(providers, sources, saved, { origin: 'upstream', manufacturer: '', search: 'private' }).map(row => row.model.id), ['Private/Model'])
  const custom = catalogHelpers.modelCandidates(providers, sources, saved, { origin: 'custom', manufacturer: '', search: 'alias' })
  assert.equal(custom[0].existing.id, 'my-custom')
  assert.deepEqual(catalogHelpers.modelCandidates([], sources, saved, { origin: '', manufacturer: '', search: '' }).map(row => row.model.id).sort(), ['Alpha/Latest', 'Private/Model', 'my-custom'].sort())
})

test('choosing a directory model fills its exact ID and display name without granting or losing upstream bindings', () => {
  const draft = { id: 'custom', name: 'Custom', enabled: false, bindings: [{ provider: 'channel-a', model: 'wire-model' }] }
  const chosen = selectPublicModel(draft, providers[0].models[0])
  assert.deepEqual(chosen, { id: 'Alpha/Latest', name: 'Alpha Latest', enabled: false, bindings: draft.bindings })
  assert.equal(draft.id, 'custom')
  assert.deepEqual(selectPublicModel({ ...draft, bindings: [] }, providers[1].models[0]).bindings, [])
})

test('published candidates retain their existing editor in every source and manufacturer filter', () => {
  const saved = [{ id: 'shared', name: 'Saved public name', enabled: true, bindings: [{ provider: 'channel-a', model: 'shared' }] }]
  const sources = [{ id: 'channel-a', name: 'Channel A', accountCount: 1, models: [{ id: 'shared' }] }]
  for (const filter of [
    { origin: '', manufacturer: '' }, { origin: 'directory', manufacturer: '' },
    { origin: 'directory', manufacturer: 'maker-b' }, { origin: 'upstream', manufacturer: '' },
  ]) {
    const row = catalogHelpers.modelCandidates(providers, sources, saved, { ...filter, search: 'shared' })[0]
    assert.equal(row.existing, saved[0], JSON.stringify(filter))
  }
})

test('deduplicated candidates remain searchable by provider IDs and all associated names', () => {
  const directory = [...providers, { id: 'zai', name: '智谱', models: [{ id: 'shared', name: 'Secondary searchable name', kind: 'chat' }] }]
  const sources = [{ id: 'channel-a', name: 'Channel A', accountCount: 1, models: [{ id: 'shared', name: 'Upstream saved name' }] }]
  const saved = [{ id: 'shared', name: 'Saved public name', enabled: true, bindings: [] }]
  for (const search of ['zai', 'Secondary searchable name', 'Saved public name', 'channel-a', 'Upstream saved name']) {
    assert.deepEqual(catalogHelpers.modelCandidates(directory, sources, saved, { origin: '', manufacturer: '', search }).map(row => row.model.id), ['shared'], search)
  }
  assert.equal(catalogHelpers.modelCandidates(directory, sources, saved, { origin: 'directory', manufacturer: 'maker-b', search: 'Saved public name' })[0].existing, saved[0])
})

test('the custom developer offers configured upstreams and saved models without including the public directory', () => {
  const saved = [{ id: 'my-custom', name: 'Saved alias', enabled: true, bindings: [{ provider: 'channel-a', model: 'private' }] }]
  const sources = [
    { id: 'channel-a', name: 'Channel A', accountCount: 1, models: [{ id: 'private' }, { id: 'my-custom' }, { id: 'Private' }] },
    { id: 'empty', name: 'No accounts', accountCount: 0, models: [{ id: 'ghost' }] },
  ]
  const filter = { origin: '', manufacturer: 'custom', search: '' }
  const rows = catalogHelpers.modelCandidates(providers, sources, saved, filter)
  assert.deepEqual(rows.map(row => row.model.id), ['private', 'my-custom', 'Private'])
  assert.deepEqual(rows[1].origins, ['upstream', 'custom'])
  assert.equal(rows[1].existing, saved[0])
  assert.deepEqual(catalogHelpers.modelCandidates(providers, sources, saved, { ...filter, search: 'SAVED alias' }).map(row => row.model.id), ['my-custom'])
  assert.deepEqual(catalogHelpers.modelCandidates(providers, sources, saved, { ...filter, manufacturer: 'maker-b' }).map(row => row.model.name), ['Shared B'])
})
