import test from 'node:test'
import assert from 'node:assert/strict'
import { balanceWalletOf, usageSupplementReadingsOf } from './usage-readings.ts'

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

test('New API detail keeps wallets separate, units visible, and reset distinct from expiry', () => {
  const t = (key, params = {}) => key.replace(/\{(\w+)\}/g, (_, name) => params[name])
  const data = { billingPreference: 'subscription_only', subscription: { planName: 'Fixture', resetsAt: 4100000000000 },
    wallets: [{ type: 'remaining', displayName: '剩余配额', balance: 3, unit: 'USD' },
      { type: 'subscription', displayName: '订阅额度', balance: 0, unit: 'USD' }] }
  const lines = usageSupplementReadingsOf(data, t, String, String)
  assert.ok(lines.includes('剩余配额 3 USD'))
  assert.ok(lines.includes('订阅额度 0 USD'))
  assert.ok(lines.includes('重置 4100000000000'))
  assert.equal(lines.some(line => line.includes('到期')), false)
})
