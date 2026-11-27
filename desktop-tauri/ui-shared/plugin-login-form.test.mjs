import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { readManagedInteraction } from './plugin-managed-state.ts'

const source = await readFile(new URL('../ui-islands/src/islands/add-account-dynamic-fields.ts', import.meta.url), 'utf8')
const functions = source.slice(source.indexOf('const UNSAFE_KEYS'), source.indexOf('function parseSms'))
const { parsePrompt, parseCallbackInput } = vm.runInNewContext(
  stripTypeScriptTypes(functions.replaceAll('export function ', 'function ')) + '\n({ parsePrompt, parseCallbackInput })',
  { t: value => value, pluginLoginText: value => value })
const scope = { provider: 'qoder', methodIndex: 0 }
const managed = { type: 'managed', id: 'step-one', provider: 'qoder', flow: 'flow-one', methodIndex: 0,
  status: 'preparing', title: 'Login', message: 'Verify this account', fields: [], expiresAt: 1900000000000,
  remainingMs: 90000, captcha: null, browser: null }

test('only the current provider, flow and method may supply a managed login step', () => {
  const result = readManagedInteraction({ ...managed, secretToken: 'must-not-retain' }, 'flow-one', scope)
  assert.deepEqual(result, managed)
  assert.throws(() => readManagedInteraction(managed, 'flow-two', scope))
  assert.throws(() => readManagedInteraction(managed, 'flow-one', { ...scope, provider: 'other' }))
  assert.throws(() => readManagedInteraction(managed, 'flow-one', { ...scope, methodIndex: 1 }))
})

test('actual shared prompt parser rejects unsafe keys, unsupported fields and duplicate choices', () => {
  const field = { key: 'account', label: 'Account', type: 'select', secret: false, optional: false,
    options: [{ value: 'one', label: 'First account' }] }
  assert.equal(parsePrompt(field).options[0].value, 'one')
  for (const invalid of [null, { ...field, key: '__proto__' }, { ...field, type: 'html' }, { ...field, options: null },
    { ...field, options: [{ value: 'same' }, { value: 'same' }] }, { ...field, when: { key: 'x', op: 'eval' } }]) {
    assert.throws(() => parsePrompt(invalid))
  }
  assert.equal(parsePrompt({ ...field, secret: true, default: 'must-not-retain' }).default, undefined)
  assert.throws(() => parseCallbackInput('token'))
})

test('managed captcha and browser steps remain bounded and cannot combine authorities', () => {
  const captcha = { engine: 'aliyun', protocol: 'v2', configId: 'captcha-one', prefix: 'prefix', sceneId: 'scene', region: 'cn' }
  assert.deepEqual(readManagedInteraction({ ...managed, status: 'ready', captcha }, 'flow-one', scope).captcha, captcha)
  for (const config of [{ ...captcha, protocol: 'v1' }, { ...captcha, configId: '' }]) {
    assert.throws(() => readManagedInteraction({ ...managed, captcha: config }, 'flow-one', scope))
  }
  const browser = { url: 'https://example.org/login', browserMode: 'external', manualCallback: false, callbackInput: 'url' }
  assert.throws(() => readManagedInteraction({ ...managed, status: 'ready', captcha, browser }, 'flow-one', scope))
  assert.throws(() => readManagedInteraction({ ...managed, browser: { ...browser, url: 'javascript:alert(1)' } }, 'flow-one', scope))
  assert.throws(() => readManagedInteraction({ ...managed, fields: [{}] }, 'flow-one', scope))
  assert.throws(() => readManagedInteraction({ ...managed, message: 'a'.repeat(8193) }, 'flow-one', scope))
})
