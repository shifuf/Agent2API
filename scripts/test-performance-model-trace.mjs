// Isolated HTTP + browser regression: no user database or real upstream is accessed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isolateUpdateNotice } from './fixtures/update-notice.mjs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = path.resolve(import.meta.dirname, '..')
const dir = await mkdtemp(path.join(os.tmpdir(), 'agent2api-performance-'))
const key = 'isolated-performance-admin'
const evidence = { directory: dir, tests: [], systemInfoMs: [] }
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  assert.equal(body.model, 'wire-model')
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  let text
  if (req.url.endsWith('/messages')) text = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg', model: 'observed-anthropic', role: 'assistant', content: [], usage: { input_tokens: 1 } } })}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
  else if (req.url.endsWith('/responses')) text = `data: {"type":"response.created","response":{"id":"resp","model":"observed-responses"}}\n\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"model":"observed-responses","usage":{"input_tokens":1,"output_tokens":1}}}\n\n`
  else text = `data: {"id":"chat","model":"observed-chat","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"model":"observed-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`
  res.write(text.slice(0, 31)); res.end(text.slice(31))
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const reserved = http.createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening')
const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve))
const base = `http://127.0.0.1:${port}`
const child = spawn(path.resolve(process.argv[2] || path.join(root, 'target/debug/agent2api-server.exe')), [], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    AGENT2API_PROXY_HOME: dir, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port),
    AGENT2API_PROXY_API_KEY: key, AGENT2API_ACCOUNT_KEY: '5'.repeat(64), AGENT2API_UI_DIR: path.join(root, 'desktop-tauri/ui'),
    AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_PANEL_PORT: '',
    AGENT2API_ADMIN_USER: '', AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ADMIN_PASSWORD_HASH: '' },
})
let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-100000) })
let browser
async function api(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) })
  const text = await response.text(); assert.equal(response.status, 200, `${endpoint}: ${text.slice(0, 1000)}`)
  if (text.startsWith('data:')) return text
  const result = JSON.parse(text); return result.success === true ? result.data : result
}
try {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${child.exitCode}`)
    try { await api('/api/system-info'); break } catch { await delay(250) }
  }
  for (const [protocol, label] of [['chat_completions', 'chat'], ['responses', 'responses'], ['anthropic', 'anthropic']]) {
    const channel = await api('/api/custom-providers', { name: `Trace ${label}`, protocol,
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, keyGroups: [{ id: 'main', apiKeys: [label], models: ['wire-model'], enabled: true }] })
    const groups = await api('/api/routing/groups')
    const model = `Public/${label}`
    await api('/api/routing/groups', { id: label, revision: groups.newRevision,
      group: { id: label, name: label, model, strategy: 'order', sticky: 'off', members: [{ id: label,
        provider: channel.provider.id, model: 'wire-model', accountScope: 'all', accounts: [], included: true }] } }, 'PUT')
    for (const stream of [false, true]) {
      const before = new Set((await api('/api/stats/requests?limit=20')).entries.map(row => row.id))
      await api('/v1/chat/completions', { model, stream, messages: [{ role: 'user', content: 'ping' }] })
      let row
      for (let n = 0; n < 30; n++) {
        const data = await api('/api/stats/requests?limit=20')
        row = data.entries?.find(item => !before.has(item.id) && item.clientModel === model && item.status !== 0)
        if (row) break
        await delay(50)
      }
      assert(row, `Missing request record for ${model}`)
      assert.equal(row.upstreamModel, 'wire-model')
      assert.deepEqual(row.attemptDetails.at(-1).responseModels, [`observed-${label}`])
      assert.equal(row.attemptDetails.at(-1).responseModelSource, 'upstream')
      evidence.tests.push(`${label} stream=${stream}: original model persisted across alias rewrite`)
    }
  }
  for (let i = 0; i < 10; i++) { const start = performance.now(); await api('/api/system-info'); evidence.systemInfoMs.push(performance.now() - start) }
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  await isolateUpdateNotice(context)
  await context.addInitScript(key => {
    localStorage.setItem('agent2api.webKey', key); localStorage.setItem('agent2api.webKey.origin', key)
    localStorage.setItem('workbuddy-desktop-settings-cat', 'system')
  }, key)
  const page = await context.newPage(); const requests = []; const errors = []
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname) })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.wbApp?.showPage && !!window.wbRequestDetail)
  requests.length = 0
  await page.evaluate(() => window.wbApp.showPage('settings'))
  await page.waitForFunction(() => document.querySelector('.settings-pane[data-cat="system"]')?.textContent.includes('AGPL'))
  await delay(300)
  assert.equal(requests.filter(path => path === '/api/system-info').length, 1)
  for (const path of ['/api/storage', '/api/cloud-sync', '/api/update/token', '/api/retention', '/api/retry']) assert(!requests.includes(path), `Hidden settings called ${path}`)
  evidence.tests.push('version page: one system-info request, no hidden settings reads')
  let rawCalls = 0, debugCalls = 0
  await page.evaluate(() => {
    window.__rawCalls = 0; window.__debugCalls = 0
    window.workbuddyDesktop.getStatsRequestRaw = async () => { window.__rawCalls++; return { requestBody: 'x'.repeat(20 * 1024 * 1024), responseBody: '', truncated: true } }
    window.workbuddyDesktop.getDebugTraffic = async () => { window.__debugCalls++; return { responseBody: 'y'.repeat(20 * 1024 * 1024) } }
    window.wbRequestDetail.open('large', { id: 'large', status: 200, attemptDetails: [{ model: 'wire', responseModels: ['other'], responseModelSource: 'upstream' }] })
  })
  await page.getByRole('dialog').waitFor()
  await page.getByText('模型名称不一致，请核对别名或上游路由', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(dir, 'model-provenance.png') })
  assert.deepEqual(await page.evaluate(() => [window.__rawCalls, window.__debugCalls]), [rawCalls, debugCalls])
  await page.getByRole('radio', { name: '预览对话', exact: true }).click()
  await page.getByText('正文过大，已暂停对话预览；可复制已保存正文查看。', { exact: true }).waitFor()
  await page.getByText('旧版本保存的正文可能已截断，无法恢复缺失内容', { exact: true }).waitFor()
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    window.__copiedLength = 0
    document.execCommand = action => {
      if (action !== 'copy') return false
      window.__copiedLength = document.querySelector('textarea')?.value.length || 0
      return true
    }
  })
  await page.getByRole('dialog').getByRole('button', { name: '复制', exact: true }).click()
  assert((await page.evaluate(() => window.__copiedLength)) > 20 * 1024 * 1024)
  evidence.tests.push('large saved body clipboard fallback works without navigator.clipboard')
  await page.getByRole('radio', { name: '原始报文', exact: true }).click()
  await page.getByText('显示内容已截断，复制可获取完整正文。', { exact: false }).waitFor()
  assert.equal(await page.getByRole('dialog').locator('[data-copy]').evaluateAll(nodes => Math.max(0, ...nodes.map(node => node.getAttribute('data-copy').length))), 0)
  await page.screenshot({ path: path.join(dir, 'request-detail.png') })
  await page.evaluate(() => window.wbRequestDetail.close())
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('dialog').count(), 0)
  evidence.tests.push('20 MiB bodies: lazy loading, bounded rendering, historical truncation notice, clean dialog removal')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  if (browser) await browser.close()
  child.kill(); upstream.close()
  await writeFile(path.join(dir, 'server.log'), output)
  await writeFile(path.join(dir, 'results.json'), JSON.stringify(evidence, null, 2))
}
