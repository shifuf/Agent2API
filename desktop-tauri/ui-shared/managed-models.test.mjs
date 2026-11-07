import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { validateManagedModel, upsertBinding } from './managed-models.ts'

test('a public model must have an ID and explicit upstream associations', () => {
  assert.equal(validateManagedModel({ id: '', name: '', enabled: true, bindings: [] }), 'id')
  assert.equal(validateManagedModel({ id: 'chosen', name: '', enabled: true, bindings: [] }), 'bindings')
  assert.equal(validateManagedModel({ id: 'chosen', name: '', enabled: true, bindings: [{ provider: 'a', model: '' }] }), 'bindings')
  assert.equal(validateManagedModel({ id: 'chosen', name: '', enabled: true, bindings: [{ provider: 'a', model: 'upstream' }] }), '')
})

test('changing a channel association replaces its upstream without changing other channels', () => {
  assert.deepEqual(upsertBinding([{ provider: 'a', model: 'old' }, { provider: 'b', model: 'other' }], 'a', 'new'),
    [{ provider: 'a', model: 'new' }, { provider: 'b', model: 'other' }])
  assert.deepEqual(upsertBinding([{ provider: 'a', model: 'old' }], 'a', ''), [])
})
