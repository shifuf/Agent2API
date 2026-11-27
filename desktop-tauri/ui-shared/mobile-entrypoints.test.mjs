import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

const typescript = createRequire(new URL('../mobile/package.json', import.meta.url))('typescript')
const mobileRoot = new URL('../mobile/src/', import.meta.url)
const reachable = new Set()

async function visit(path) {
  if (reachable.has(path)) return
  reachable.add(path)
  const source = await readFile(path, 'utf8')
  const imports = typescript.preProcessFile(source, true, true).importedFiles
  for (const imported of imports) {
    if (!imported.fileName.startsWith('.')) continue
    const stem = resolve(dirname(path), imported.fileName)
    for (const suffix of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
      const candidate = stem + suffix
      try { await access(candidate) } catch { continue }
      await visit(candidate)
      break
    }
  }
}

await visit(resolve(new URL('main.tsx', mobileRoot).pathname.replace(/^\/(\w:)/, '$1')))

function isMounted(relative) {
  const path = resolve(new URL(relative, mobileRoot).pathname.replace(/^\/(\w:)/, '$1'))
  assert.ok(reachable.has(path), `${relative} is orphaned from the actual mobile entry point`)
}

test('the actual mobile app reaches full tool services, provider keys, vision and image configuration', () => {
  isMounted('pages/ToolsPage.tsx')
  isMounted('core/api-images.ts')
})

test('the actual mobile app reaches detailed reports, API documentation and response phase settings', () => {
  isMounted('pages/ReportPage.tsx')
  isMounted('pages/DocsPage.tsx')
  isMounted('components/settings-responses-phase.tsx')
})

test('retained fork management pages remain reachable beside upstream pages', () => {
  for (const path of ['pages/RoutingPage.tsx', 'pages/ModelsPage.tsx', 'pages/ProxiesPage.tsx',
    'pages/proxy-subscriptions-sheet.tsx', 'pages/AssistantPage.tsx', 'views/ForwardingSheets.tsx',
    'views/PricingSheet.tsx', 'views/MaintenanceView.tsx', 'views/ScheduledView.tsx']) isMounted(path)
})
