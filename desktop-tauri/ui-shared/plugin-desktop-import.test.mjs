import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = await readFile(new URL('./plugin-desktop-import.tsx', import.meta.url), 'utf8')
const phases = source.slice(source.indexOf('const PHASES'), source.indexOf('export type DesktopImportPhase'))
const validation = source.slice(source.indexOf('const record ='), source.indexOf('function payloadIdentity'))
const parser = vm.runInNewContext(stripTypeScriptTypes(phases + validation) + '\n({ readDesktopImport: readPayload })')
const read = value => JSON.parse(JSON.stringify(parser.readDesktopImport(value)))
const receipt = {
  provider: 'chatglm', intent: 'a'.repeat(48), phase: 'awaiting_confirmation', saved: false,
  expiresAt: 1900000000000, remainingMs: 90000, message: 'Confirmation required', account: null,
  package: { id: 'provider-chatglm', version: '3.5.1', archiveDigest: 'b'.repeat(64), moduleDigest: 'c'.repeat(64), declarationDigest: 'd'.repeat(64) },
  scope: { platform: 'windows', application: 'chatglm', root: 'current_user_roaming', access: 'read_only',
    files: ['chatglm/Local State', 'chatglm/Network/Cookies'], cookieHost: '.chatglm.cn',
    cookieNames: ['chatglm_token', 'chatglm_refresh_token'], excludes: ['other_apps', 'browser_profiles', 'other_windows_users'], credentialsReturnedToUi: false },
}

test('desktop import confirmation is limited to the declared current-user ChatGLM files', () => {
  assert.equal(typeof parser.readDesktopImport, 'function', 'Missing bounded desktop import receipt parser')
  assert.deepEqual(read(receipt), receipt)
  for (const scope of [{ ...receipt.scope, access: 'write' }, { ...receipt.scope, credentialsReturnedToUi: true },
    { ...receipt.scope, files: ['browser/Default/Cookies'] }]) {
    assert.throws(() => parser.readDesktopImport({ ...receipt, scope }))
  }
})

test('a different intent cannot take over an existing confirmation or polling result', () => {
  assert.equal(typeof parser.readDesktopImport, 'function')
  assert.match(source, /target\.intent && value\.intent !== target\.intent/)
  assert.match(source, /target\.identity && payloadIdentity\(value\) !== target\.identity/)
  assert.throws(() => parser.readDesktopImport({ ...receipt, provider: 'other-provider' }))
})

test('only the actual saved phase and account identity confirm a completed import', () => {
  assert.equal(typeof parser.readDesktopImport, 'function')
  const saved = { ...receipt, phase: 'saved', saved: true, account: { id: 'account-one', provider: 'chatglm' } }
  assert.equal(parser.readDesktopImport(saved).account.id, 'account-one')
  assert.throws(() => parser.readDesktopImport({ ...receipt, saved: true, account: saved.account }))
  assert.throws(() => parser.readDesktopImport({ ...saved, account: { nickname: 'Only a name' } }))
  assert.throws(() => parser.readDesktopImport({ ...receipt, phase: 'failed', saved: null, account: saved.account }))
  const uncertain = parser.readDesktopImport({ ...receipt, phase: 'failed', saved: null })
  assert.equal(uncertain.saved, null)
  assert.equal(uncertain.account, null)
})
