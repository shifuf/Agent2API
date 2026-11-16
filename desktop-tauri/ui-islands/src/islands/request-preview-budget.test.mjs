import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'

const exports = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('./request-preview-budget.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports })

test('preview budget accepts ordinary conversations and rejects huge strings and nested payloads', () => {
  assert.equal(exports.exceedsPreviewBudget([{ messages: [{ role: 'user', content: 'hello' }] }, 'world']), false)
  assert.equal(exports.exceedsPreviewBudget('x'.repeat(20 * 1024 * 1024)), true)
  assert.equal(exports.exceedsPreviewBudget({ choices: Array(3000).fill({ content: 'x'.repeat(100) }) }), true)
})

test('budget stops traversing once the limit is exceeded', () => {
  const body = { content: 'x'.repeat(exports.PREVIEW_LIMIT + 1), get unused() { throw new Error('unnecessary traversal') } }
  assert.equal(exports.exceedsPreviewBudget(body), true)
})
