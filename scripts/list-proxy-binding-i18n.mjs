// Read-only inventory for the parent integration step; this never writes dictionaries.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const files = [
  'desktop-tauri/ui-shared/proxy-bindings-dialog.tsx', 'desktop-tauri/ui-shared/proxy-groups.tsx',
  'desktop-tauri/ui-islands/src/islands/proxies-page.tsx', 'desktop-tauri/ui-islands/src/islands/proxies-columns.ts',
  'desktop-tauri/mobile/src/pages/ProxiesPage.tsx', 'desktop-tauri/mobile/src/pages/proxy-subscriptions-sheet.tsx',
]
const keys = new Set([
  '收起选路', '展开选路', '所属订阅已删除', '所选代理已禁用',
  '所属订阅已暂停或删除', '节点或代理组已移除，请刷新订阅',
])
for (const file of files) {
  const source = await readFile(path.join(root, file), 'utf8')
  for (const match of source.matchAll(/\bt\(\s*(['"])((?:(?!\1)[^\\]|\\.)*?)\1/g)) {
    if (/[\u3400-\u9fff]/u.test(match[2])) keys.add(match[2])
  }
}
const locales = ['en', 'zh-Hant', 'ja', 'ko', 'pt-BR']
const dictionaries = new Map()
for (const locale of locales) {
  const directory = path.join(root, 'desktop-tauri/i18n/i18n-src', locale)
  const dictionary = new Map()
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.json')) continue
    for (const [key, value] of Object.entries(JSON.parse(await readFile(path.join(directory, file), 'utf8')))) dictionary.set(key, value)
  }
  dictionaries.set(locale, dictionary)
}
console.log(JSON.stringify([...keys].sort().flatMap(key => {
  const missing = locales.filter(locale => !dictionaries.get(locale).get(key))
  return missing.length ? [{ key, missing }] : []
}), null, 2))
