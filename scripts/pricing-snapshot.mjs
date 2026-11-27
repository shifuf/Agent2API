import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const source = JSON.parse(readFileSync(0, 'utf8'))
const rows = Object.entries(source.models).filter(([, item]) => item.cost && item.canonical)
assert.ok(rows.length, 'missing models.dev prices')
const prices = Object.fromEntries(rows.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, row]) => [key, row.cost]))
writeFileSync(new URL('../desktop-tauri/src-tauri/server/src/server/core/model_pricing/usd_prices.json', import.meta.url), JSON.stringify({ generatedAt: source.generatedAt, prices }, null, 2) + '\n')
