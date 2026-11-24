import test from 'node:test'
import assert from 'node:assert/strict'
import { accountBindingIds, bindingAccountGroups, bindingTargetError } from './proxy-bindings.ts'

const exits = [
  { id: 'first', name: 'First exit', source: 'manual', enabled: true, port: 8080 },
  { id: 'disabled', name: 'Disabled exit', source: 'manual', enabled: false, port: 8081 },
  { id: 'second', name: 'Second exit', source: 'subscription', enabled: true, providerId: 'sub-a', node: 'exit', port: null },
]
const row = proxy => ({ id: 'account-1', name: 'Account', provider: 'channel-1', providerLabel: 'Channel', enabled: true, proxy })

test('bindings are derived from account proxy fields including explicit rotate order', () => {
  assert.deepEqual(accountBindingIds(row({ config: { source: 'pool', proxyId: 'first' } }), exits), ['first'])
  assert.deepEqual(accountBindingIds(row({ config: { source: 'rotate', all: false, proxyIds: ['second', 'first'] } }), exits), ['second', 'first'])
  assert.deepEqual(accountBindingIds(row({ config: { source: 'rotate', all: true } }), exits), ['first', 'second'])
  assert.deepEqual(accountBindingIds(row(null), exits), [])
  assert.deepEqual(accountBindingIds(row({ config: { source: 'pool', proxyId: 'deleted' }, error: 'removed' }), exits), ['deleted'])
})

test('binding account grouping keeps disabled accounts and can find a channel label', () => {
  const accounts = [row(null), { ...row(null), id: 'account-2', name: 'Paused login', enabled: false },
    { ...row(null), id: 'account-3', provider: 'other-channel', providerLabel: 'Other channel' }]
  assert.deepEqual(bindingAccountGroups(accounts, 'channel').map(group => group.accounts.map(account => account.id)), [['account-1', 'account-2'], ['account-3']])
  assert.deepEqual(bindingAccountGroups(accounts, 'paused').map(group => group.accounts.map(account => account.id)), [['account-2']])
  assert.equal(bindingAccountGroups(accounts, 'missing').length, 0)
})

test('unused subscription nodes may bind before their listener is allocated, but unavailable targets cannot', () => {
  assert.equal(bindingTargetError(exits[2]), '')
  assert.ok(bindingTargetError(exits[1]))
  assert.ok(bindingTargetError({ ...exits[2], orphan: true }))
  assert.ok(bindingTargetError({ ...exits[2], bindingError: 'Group was removed' }))
  assert.ok(bindingTargetError({ ...exits[0], resolveError: 'Invalid address' }))
})
