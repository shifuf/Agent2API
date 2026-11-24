import test from 'node:test'
import assert from 'node:assert/strict'

const parser = await import('./plugin-login-form.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw error
})
const response = interaction => ({ provider: 'qoder', state: 'flow-one', interaction })
const form = {
  id: 'step-one', title: 'Login', message: 'Verify this account',
  fields: [{ key: 'account', label: 'Account', type: 'select', secret: false, optional: false,
    options: [{ value: 'one', label: 'First account' }] }],
  captcha: null,
}

test('only the current provider and flow may supply an interactive login form', () => {
  assert.equal(typeof parser.readPluginLoginForm, 'function', 'Missing validated plugin login form parser')
  const result = parser.readPluginLoginForm(response({ ...form, secretToken: 'must-not-retain' }), 'qoder', 'flow-one')
  assert.deepEqual(result, form)
  assert.equal(parser.readPluginLoginForm(response(null), 'qoder', 'flow-one'), null)
  assert.throws(() => parser.readPluginLoginForm({ ...response(form), state: 'flow-two' }, 'qoder', 'flow-one'))
  assert.throws(() => parser.readPluginLoginForm(response(form), 'other-provider', 'flow-one'))
})

test('malformed fields cannot become selectable options or writable object keys', () => {
  assert.equal(typeof parser.readPluginLoginForm, 'function')
  for (const field of [null, { ...form.fields[0], key: '__proto__' }, { ...form.fields[0], type: 'html' },
    { ...form.fields[0], options: null }, { ...form.fields[0], optional: 'false' },
    { ...form.fields[0], options: [{ value: 'same', label: 'A' }, { value: 'same', label: 'B' }] }]) {
    assert.throws(() => parser.readPluginLoginForm(response({ ...form, fields: [field] }), 'qoder', 'flow-one'))
  }
  assert.throws(() => parser.readPluginLoginForm(response({ ...form, fields: [form.fields[0], form.fields[0]] }), 'qoder', 'flow-one'))
})

test('captcha configuration must be complete and inputs obey the host limits', () => {
  assert.equal(typeof parser.readPluginLoginForm, 'function')
  const captcha = { gt: 'captcha-id', challenge: 'challenge-one', success: true, new_captcha: true }
  assert.deepEqual(parser.readPluginLoginForm(response({ ...form, captcha }), 'qoder', 'flow-one').captcha, captcha)
  for (const invalid of [{ ...captcha, success: 'true' }, { ...captcha, gt: '' }, { challenge: 'missing-id' }]) {
    assert.throws(() => parser.readPluginLoginForm(response({ ...form, captcha: invalid }), 'qoder', 'flow-one'))
  }
  assert.throws(() => parser.readPluginLoginForm(response({ ...form, fields: Array.from({ length: 17 }, (_, i) => ({ ...form.fields[0], key: `field${i}` })) }), 'qoder', 'flow-one'))
  assert.throws(() => parser.readPluginLoginForm(response({ ...form, message: 'a'.repeat(8193) }), 'qoder', 'flow-one'))
})
