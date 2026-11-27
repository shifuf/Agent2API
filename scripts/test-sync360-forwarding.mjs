import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./test-sync360-title.mjs', import.meta.url))
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2), '--prompt'], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
