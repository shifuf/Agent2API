import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pluginGateway } from './fixtures/plugin-gateway.mjs'

const gateway = await pluginGateway(process.argv[2], 'full-bun-runtime')
const { home, call } = gateway
const directory = path.join(home, 'fixture-source')
const source = `file:${directory}`
const scripts = '/api/plugins/scripts'
await mkdir(directory)
await writeFile(path.join(directory, 'package.json'), JSON.stringify({
  name: '@fixture/full-bun-provider', version: '1.0.0', type: 'module', exports: { './server': './index.mjs' },
  scripts: { postinstall: 'node -e "throw new Error(\'lifecycle scripts must not run\')"' },
}))
await writeFile(path.join(directory, 'index.mjs'), `export default {
  id: 'full-bun-provider',
  async server(input, options) {
    if (Bun.version !== '1.4.2' || typeof input.magpie.option !== 'function') throw Error('actual Bun/Magpie runtime required');
    return {
      config(config) { config.provider['fixture-bun'] = {
        name: options.title || 'Bun ' + Bun.version, npm: '@ai-sdk/openai-compatible', api: 'https://example.org/v1',
        models: { 'fixture-model': { name: 'Fixture model', limit: { context: 8192, output: 1024 }, tool_call: true } }
      }; },
      auth: { provider: 'fixture-bun', options: [{ key: 'extended', label: 'Extended catalog', default: false }],
        methods: [{ type: 'api', label: 'Fixture API Key' }], loader: async getAuth => ({ apiKey: (await getAuth())?.key }) }
    };
  }
}`)
const snapshot = async () => (await call('/api/plugins')).scripts
async function operation(endpoint, payload) {
  const started = await call(endpoint, 'POST', payload)
  assert.ok(started.operation?.operationId)
  for (let attempt = 0; attempt < 1200; attempt++) {
    const state = await snapshot()
    if (!state.operation.active) {
      assert.equal(state.operation.error, null, JSON.stringify(state.operation))
      assert.equal(state.operation.stage, 'done')
      return state
    }
    await delay(250)
  }
  assert.fail('Bun plugin operation timed out')
}
try {
  assert.deepEqual((await snapshot()).packages, [])
  const key = (await call('/api/keys', 'POST', { name: 'Bun fixture' })).created.key
  await call(scripts + '/install', 'POST', { source, trusted: true }, 403, { 'x-api-key': key })
  await call(scripts + '/install', 'POST', { source, trusted: false }, 400)
  const installed = await operation(scripts + '/install', { source, trusted: true })
  assert.equal(installed.runtime.version, '1.4.2'); assert.equal(installed.runtime.installed, true)
  assert.equal(installed.packages.length, 1)
  const pack = installed.packages[0]
  assert.equal(pack.name, '@fixture/full-bun-provider'); assert.equal(pack.running, true)
  const provider = pack.providers[0]
  assert.ok(provider.loaded); assert.equal(provider.label, 'Bun 1.4.2')
  const methods = await call('/api/session/login/methods?provider=' + encodeURIComponent(provider.id))
  assert.ok(methods.methods.some(method => method.type === 'api' && method.label === 'Fixture API Key'))
  const prompts = await call(scripts + '/prompts', 'POST', { provider: provider.id, methodIndex: 0 })
  assert.ok(prompts.prompts.some(prompt => prompt.key === 'key' && prompt.secret === true))
  const settings = await call(scripts + '/settings', 'POST', { id: pack.id })
  assert.equal(settings.schema.providerOptions[provider.id][0].key, 'extended')
  await call(scripts + '/settings', 'POST', { id: pack.id, providerOptions: { [provider.id]: { undeclared: true } } }, 400)
  await call(scripts + '/settings', 'POST', { id: pack.id, providerOptions: { [provider.id]: { extended: true } } })
  assert.equal((await call(scripts + '/settings', 'POST', { id: pack.id })).providerOptions[provider.id].extended, true)
  const configured = await operation(scripts + '/settings', { id: pack.id, options: { title: 'Configured Bun fixture' } })
  assert.equal(configured.packages[0].providers[0].label, 'Configured Bun fixture')
  await operation(scripts + '/change', { id: pack.id, action: 'reload' })
  const disabled = await operation(scripts + '/change', { id: pack.id, action: 'enable', enabled: false })
  assert.equal(disabled.packages[0].enabled, false); assert.equal(disabled.packages[0].running, false)
  await call(scripts + '/change', 'POST', { id: pack.id, action: 'reload' }, 400)
  const enabled = await operation(scripts + '/change', { id: pack.id, action: 'enable', enabled: true })
  assert.equal(enabled.packages[0].running, true); assert.equal(enabled.packages[0].providers[0].id, provider.id)
  await gateway.restart()
  let restored
  for (let attempt = 0; attempt < 160; attempt++) {
    restored = await snapshot()
    if (restored.packages[0]?.running) break
    await delay(250)
  }
  assert.equal(restored.packages[0].running, true)
  assert.equal(restored.packages[0].providers[0].label, 'Configured Bun fixture')
  const removed = await operation(scripts + '/change', { id: pack.id, action: 'remove' })
  assert.deepEqual(removed.packages, [])
  console.log('PASS actual Bun 1.4.2 download/start, trusted local package installation, OpenCode/Magpie hooks, auth prompts, declared settings, reload, enable/disable, stable identities, restart and removal')
} finally { await gateway.stop() }
