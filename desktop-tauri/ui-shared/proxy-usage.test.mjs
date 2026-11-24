import test from 'node:test'
import assert from 'node:assert/strict'
import { hasProxyUsage, proxyServiceLabels } from './proxy-usage.ts'
import * as usage from './proxy-usage.ts'

test('subscription kernel download references count as proxy usage and retain their label', () => {
  const item = { usedByServices: ['kernelDownload', 'update', 'kernelDownload'] }
  assert.equal(hasProxyUsage(item), true)
  assert.deepEqual(proxyServiceLabels(item, text => text), ['代理内核下载', '软件 / 插件更新'])
})

test('unknown service references are not displayed as software updates', () => {
  assert.deepEqual(proxyServiceLabels({ usedByServices: ['unknown'] }, text => text), [])
})

test('a node can be found by its bound channel or account name', () => {
  const item = { usedBy: [{ id: 'account-1', name: 'Secondary login', provider: 'custom-channel', providerLabel: 'Testing channel' }] }
  assert.equal(typeof usage.proxyBindingSearchText, 'function', 'Bound-account search is missing')
  const search = usage.proxyBindingSearchText(item)
  assert.ok(search.includes('secondary login'))
  assert.ok(search.includes('testing channel'))
  assert.ok(search.includes('custom-channel'))
})
