import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createFixturePanelSession } from './panel-session.mjs'

export async function pluginGateway(executable, label) {
  assert.ok(executable, 'pass the candidate server executable')
  const home = await mkdtemp(path.join(os.tmpdir(), `agent2api-${label}-`))
  const reservation = http.createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const adminKey = randomUUID()
  const credentials = { username: 'operator', password: randomUUID() + '!Aa' }
  const env = { ...process.env, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_HOME: home,
    AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: adminKey, AGENT2API_ACCOUNT_KEY: '8'.repeat(64),
    AGENT2API_SELF_UPDATE: '0', AGENT2API_WINDOWS_UPDATE: '0', AGENT2API_SYSTEMD_UPDATE: '0', AGENT2API_CAPTCHA_ENABLED: '0' }
  for (const name of ['AGENT2API_PANEL_PORT', 'AGENT2API_ADMIN_USER', 'AGENT2API_ADMIN_PASSWORD', 'AGENT2API_ADMIN_PASSWORD_HASH']) delete env[name]
  let child, exited, session, output = ''
  async function start(login = false) {
    child = spawn(path.resolve(executable), [], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    exited = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-160000) })
    let ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      assert.equal(child.exitCode, null, `fixture exited: ${output}`)
      try { if ((await fetch(base + '/health')).ok) { ready = true; break } } catch {}
      await delay(200)
    }
    assert.ok(ready, 'fixture unavailable')
    session = await createFixturePanelSession(base, credentials, login ? 'login' : undefined)
  }
  async function stop() {
    if (child?.exitCode === null) child.kill()
    if (exited) await exited
    await writeFile(path.join(home, 'server.log'), output)
  }
  async function call(endpoint, method = 'GET', body, expected = 200, auth) {
    const response = await fetch(base + endpoint, { method, headers: { ...(auth ?? { 'x-panel-token': session.accessToken }),
      'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(240000) })
    const text = await response.text()
    assert.equal(response.status, expected, `${method} ${endpoint}: ${text}`)
    const value = JSON.parse(text)
    return value.data ?? value
  }
  try { await start() } catch (error) { await stop(); throw error }
  console.log(`Evidence: ${home}`)
  return { home, base, adminKey, call, stop, get session() { return session }, async restart() { await stop(); await start(true) } }
}
