import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../package.json', import.meta.url))
const { buildSync } = require('esbuild')
const nodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url))
const load = async name => {
  const source = buildSync({ entryPoints: [fileURLToPath(new URL(name, import.meta.url))], bundle: true,
    platform: 'node', format: 'esm', write: false, nodePaths: [nodeModules],
    alias: { '@ui': fileURLToPath(new URL('../../../ui-kit/src/index.ts', import.meta.url)),
      react: fileURLToPath(new URL('../../node_modules/react', import.meta.url)) },
    tsconfigRaw: { compilerOptions: { jsx: 'automatic' } } }).outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
const bridge = await load('./add-account-bridge.ts')
const metadata = await load('./add-account-dynamic-fields.ts')
const saved = {
  managedLogin: true, provider: 'trae', flow: 'original-flow', methodIndex: 0,
  phase: 'saved', saved: true, pending: false, done: true,
  session: { provider: 'trae', accountUid: 'account-one', nickname: 'Verified account', proxySaved: true },
}

test('managed saved receipts must match the selected login owner', () => {
  const owner = { provider: 'trae', flow: 'original-flow', methodIndex: 0 }
  const result = bridge.normalizeLoginResult({ ok: true, payload: saved }, owner)
  assert.equal(result.ok, true)
  assert.equal(result.session.accountUid, 'account-one')
  assert.throws(() => bridge.normalizeLoginResult({ ok: true, payload: saved }, { ...owner, provider: 'qoder' }))
  assert.throws(() => bridge.normalizeLoginResult({ ok: true, payload: saved }, { ...owner, flow: 'new-flow' }))
  assert.throws(() => bridge.normalizeLoginResult({ ok: true, payload: saved }, { ...owner, methodIndex: 1 }))
})

test('an outer success cannot turn unconfirmed managed saving into a saved account', () => {
  const unknown = { ...saved, phase: 'unconfirmed', saved: null, session: null }
  assert.throws(() => bridge.normalizeLoginResult({ ok: true, payload: unknown, session: saved.session }))
  assert.throws(() => bridge.normalizeLoginResult({ ok: true, payload: { ...saved, saved: false } }))
  assert.throws(() => bridge.normalizeLoginResult({ ok: true, payload: { ...saved, session: { nickname: 'Only a name' } } }))
})

test('managed and interactive metadata must be booleans and apply only to OAuth methods', () => {
  const method = { methodIndex: 0, type: 'oauth', label: 'Browser login', prompts: [],
    manualCallback: false, callbackInput: 'url', localOnly: false, embeddedOnly: false,
    managedLogin: true, interactiveLogin: true }
  const parsed = metadata.parseMethods({ methods: [method] }, 'trae').methods[0]
  assert.equal(parsed.managedLogin, true)
  assert.equal(parsed.interactiveLogin, true)
  assert.throws(() => metadata.parseMethods({ methods: [{ ...method, managedLogin: 'true' }] }, 'trae'))
  assert.throws(() => metadata.parseMethods({ methods: [{ ...method, type: 'api' }] }, 'trae'))
})
