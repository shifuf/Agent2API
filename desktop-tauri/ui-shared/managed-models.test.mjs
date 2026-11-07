import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as models from './managed-models.ts'
const { validateManagedModel, upsertBinding } = models

test('a model can be created before associating channels while malformed bindings stay invalid', () => {
  assert.equal(validateManagedModel({ id: '', name: '', enabled: true, bindings: [] }), 'id')
  assert.equal(validateManagedModel({ id: 'chosen', name: '', enabled: false, bindings: [] }), '')
  assert.equal(validateManagedModel({ id: 'chosen', name: '', enabled: true, bindings: [{ provider: 'a', model: '' }] }), 'bindings')
  assert.equal(validateManagedModel({ id: 'chosen', name: '', enabled: true, bindings: [{ provider: 'a', model: 'upstream' }] }), '')
})

test('new model drafts are disabled and directory metadata fills without publishing or changing bindings', () => {
  const draft = models.blankManagedModel()
  assert.equal(draft.enabled, false)
  const binding = { provider: 'custom-first', model: 'upstream' }
  const next = models.modelFromCandidate({ ...draft, bindings: [binding] }, {
    provider: { id: 'maker', name: 'Maker' }, origins: ['directory'], labels: ['Maker'],
    model: { id: 'Exact/Case', name: 'Readable', kind: 'chat', family: 'Family', type: 'chat',
      modelCard: { limit: { context: 12000, output: 3000 }, toolCall: true } },
  })
  assert.equal(next.id, 'Exact/Case')
  assert.equal(next.developer, 'maker')
  assert.equal(next.group, 'Family')
  assert.equal(next.modelCard.limit.context, 12000)
  assert.equal(next.enabled, false)
  assert.deepEqual(next.bindings, [binding])
  assert.equal(draft.id, '')
})

test('model grouping and lifecycle filters distinguish unavailable, disabled and archived models', () => {
  const rows = [
    { id: 'a', name: 'Alpha', enabled: false, bindings: [], developer: 'one' },
    { id: 'b', name: 'Beta', enabled: true, bindings: [], developer: 'two', archived: true },
    { id: 'c', name: 'Gamma', enabled: true, bindings: [{ provider: 'channel', model: 'upstream' }], developer: 'one' },
  ]
  assert.equal(models.managedModelStatus(rows[1]), 'archived')
  assert.deepEqual(models.filterManagedModels(rows, { query: '', developer: '', status: 'disabled' }).map(row => row.id), ['a'])
  assert.deepEqual(models.filterManagedModels(rows, { query: '', developer: 'one', status: '' }).map(row => row.id), ['a', 'c'])
  assert.deepEqual(models.filterManagedModels(rows, { query: 'UPSTREAM', developer: '', status: '' }).map(row => row.id), ['c'])
  const enriched = { ...rows[0], modelCard: { cost: { input: 1, output: 2 } }, remark: 'Keep this' }
  const restored = models.withModelStatus(enriched, 'disabled')
  assert.equal(restored.archived, false)
  assert.equal(restored.enabled, false)
  assert.deepEqual(restored.modelCard, enriched.modelCard)
})

test('changing a channel association replaces its upstream without changing other channels', () => {
  assert.deepEqual(upsertBinding([{ provider: 'a', model: 'old' }, { provider: 'b', model: 'other' }], 'a', 'new'),
    [{ provider: 'a', model: 'new' }, { provider: 'b', model: 'other' }])
  assert.deepEqual(upsertBinding([{ provider: 'a', model: 'old' }], 'a', ''), [])
})
