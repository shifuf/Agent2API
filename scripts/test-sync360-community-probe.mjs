import assert from 'node:assert/strict'

assert.ok(!process.argv.includes('--guest') && !process.argv.includes('--limits'),
  'The retired QEMU probe endpoint is no longer part of the plugin runtime. Run test-sync360-bun.mjs <server> for actual Bun/OpenCode/Magpie acceptance.')
await import('./test-sync360-bun.mjs')
