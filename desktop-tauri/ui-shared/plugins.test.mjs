import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugins from './plugins.ts'

const wasm = { target: 'wasm32-unknown-unknown', size: 100, url: 'https://example.test/provider-wasm.zip', current: false }
const linux = { target: 'x86_64-unknown-linux-gnu', size: 200, url: 'https://example.test/provider-linux.zip', current: true }

test('a signed cross-platform release is selectable on Linux, ARM and Windows gateways', () => {
  assert.equal(typeof plugins.selectPluginPlatform, 'function', 'Cross-platform plugin selection is missing')
  for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'x86_64-pc-windows-msvc']) {
    assert.equal(plugins.selectPluginPlatform([wasm], target)?.target, wasm.target)
  }
})

test('an exact native asset wins and unrelated native platforms never become installable', () => {
  assert.equal(typeof plugins.selectPluginPlatform, 'function')
  assert.equal(plugins.selectPluginPlatform([wasm, linux], linux.target), linux)
  assert.equal(plugins.selectPluginPlatform([linux], 'aarch64-unknown-linux-gnu'), undefined)
})

test('installation sends the actual asset target and ignores a misleading current flag', () => {
  assert.equal(typeof plugins.isPluginTargetCompatible, 'function')
  assert.equal(plugins.isPluginTargetCompatible(wasm.target, linux.target), true)
  assert.equal(plugins.isPluginTargetCompatible('aarch64-apple-darwin', linux.target), false)
  assert.equal(plugins.selectPluginPlatform([{ ...linux, target: 'aarch64-apple-darwin' }], linux.target), undefined)
})
