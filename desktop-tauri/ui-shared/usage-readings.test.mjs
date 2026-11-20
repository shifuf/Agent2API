import test from 'node:test'
import assert from 'node:assert/strict'
import { balanceWalletOf } from './usage-readings.ts'

test('SOLO concurrency, package status and monthly requests are not a credit balance', () => {
  for (const type of ['solo_parallel', 'solo_package', 'fast_request_per']) {
    assert.equal(balanceWalletOf([{ type, balance: 2 }]), null, type)
  }
})

test('a real balance wins over earlier runtime dimensions and snapshots', () => {
  const wallet = { type: 'credits', balance: '12.5', unit: 'credits' }
  assert.equal(balanceWalletOf([
    { type: 'solo_parallel', balance: 2 },
    { type: 'magicubes', balance: 100 },
    { type: 'daily', balance: 50, snapshot: true },
    wallet,
  ]), wallet)
})

test('a real zero balance remains different from missing or invalid readings', () => {
  const empty = { type: 'credits', balance: 0 }
  assert.equal(balanceWalletOf([null, {}, { balance: '' }, { balance: 'unknown' }, empty]), empty)
  assert.equal(balanceWalletOf([false, [], { balance: null }, { balance: Infinity }]), null)
})
