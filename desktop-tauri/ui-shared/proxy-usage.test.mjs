import test from 'node:test'
import assert from 'node:assert/strict'
import { hasProxyUsage, proxyServiceLabels } from './proxy-usage.ts'

test('subscription kernel download references count as proxy usage and retain their label', () => {
  const item = { usedByServices: ['kernelDownload', 'update', 'kernelDownload'] }
  assert.equal(hasProxyUsage(item), true)
  assert.deepEqual(proxyServiceLabels(item, text => text), ['代理内核下载', '软件 / 插件更新'])
})

test('unknown service references are not displayed as software updates', () => {
  assert.deepEqual(proxyServiceLabels({ usedByServices: ['unknown'] }, text => text), [])
})
