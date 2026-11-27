import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'

const feature = await import('./panel-branding-state.ts').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
  return {}
})

test('a panel logo may only target its own versioned PNG endpoint', () => {
  assert.equal(typeof feature.parseBranding, 'function', 'branding metadata validator')
  const path = '/api/panel/branding/logo?v=' + 'f'.repeat(64)
  assert.deepEqual(feature.parseBranding({ displayName: 'Mine', logoUrl: path }, 'https://local.test'), { displayName: 'Mine', logoUrl: 'https://local.test' + path })
  for (const logoUrl of ['https://other.test/logo', '/api/panel/branding/logo?v=no', 'data:image/svg+xml;base64,eA==']) assert.throws(() => feature.parseBranding({ displayName: 'Mine', logoUrl }, 'https://local.test'))
})

test('old sites keep defaults and a late reply cannot brand a different gateway', async () => {
  assert.equal(typeof feature.brandingStore, 'function', 'scoped branding store')
  let current = 'old'
  let finish
  const store = feature.brandingStore(() => current, () => current === 'old' ? new Promise(resolve => { finish = resolve }) : Promise.reject(new Error('404')))
  const pending = store.refresh()
  current = 'new'
  await store.refresh()
  finish({ displayName: 'Previous Server', logoUrl: null }); await pending
  assert.deepEqual(store.snapshot(), { displayName: 'Agent2API', logoUrl: null })
  assert.equal(store.accept('old', { displayName: 'Stale Save', logoUrl: null }), false)
})

test('downgrading the active site removes the previously loaded brand', async () => {
  let current = true
  const site = createServer((_request, reply) => {
    if (current) reply.setHeader('Content-Type', 'application/json').end(JSON.stringify({ data: { displayName: 'Current site', logoUrl: null } }))
    else { reply.statusCode = 404; reply.end() }
  }).listen(0, '127.0.0.1')
  await once(site, 'listening')
  const base = `http://127.0.0.1:${site.address().port}`
  try {
    const store = feature.brandingStore(() => base, () => feature.readBranding(base))
    await store.refresh(); assert.equal(store.snapshot().displayName, 'Current site')
    current = false; await store.refresh(); assert.equal(store.snapshot(), feature.DEFAULT_BRANDING)
  } finally { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)) }
})
