import test from 'node:test'
import assert from 'node:assert/strict'
import { workbuddyCredentialEdition } from './workbuddy-credentials.ts'

test('WorkBuddy import recognizes official legacy and international credential domains', () => {
  for (const [file, expected] of [
    [{ auth: { domain: 'https://copilot.tencent.com' } }, 'cn'],
    [{ domain: 'workbuddy.cn' }, 'cn'],
    [{ domain: 'codebuddy.cn' }, 'cn'],
    [{ auth: { domain: 'workbuddy.ai' } }, 'intl'],
    [{ domain: 'codebuddy.ai' }, 'intl'],
  ]) assert.equal(workbuddyCredentialEdition(file), expected)
})

test('WorkBuddy import falls back to declared realm, region and edition', () => {
  for (const [file, expected] of [
    [{ realm: 'international' }, 'intl'], [{ region: 'GLOBAL' }, 'intl'],
    [{ edition: 'workbuddy-ai' }, 'intl'], [{ realm: 'cn' }, 'cn'],
    [{ region: 'mainland' }, 'cn'], [{ edition: 'workbuddy' }, 'cn'],
    [{ auth: { domain: 'workbuddy.cn' }, realm: 'intl' }, 'cn'],
    [{ domain: 'unrecognized.example', realm: 'intl' }, 'intl'],
    [{}, null], [{ realm: 'unknown' }, null],
  ]) assert.equal(workbuddyCredentialEdition(file), expected)
})
