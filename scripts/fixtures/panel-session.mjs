import assert from 'node:assert/strict'

// Real panel credentials for disposable loopback test servers, never a gateway Key.
export async function createFixturePanelSession(base, credentials, action = 'setup') {
  const origin = new URL(base)
  assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Panel fixtures require an isolated loopback server')
  assert.ok(action === 'setup' || action === 'login')
  const response = await fetch(base + '/api/panel/' + action + '?auth-mode=body', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials), signal: AbortSignal.timeout(20_000),
  })
  assert.equal(response.status, 200, 'Fixture panel ' + action + ' must succeed')
  const value = await response.json()
  const payload = value.success === true && Object.hasOwn(value, 'data') ? value.data : value
  assert.equal(typeof payload.accessToken, 'string')
  assert.equal(typeof payload.refreshToken, 'string')
  assert.ok(payload.accessToken && payload.refreshToken, 'The real panel endpoint must issue both session tokens')
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie, 'The real panel endpoint must issue its session cookie')
  const separator = cookie.indexOf('=')
  assert.ok(separator > 0)
  const sessionCookie = { name: cookie.slice(0, separator), value: cookie.slice(separator + 1) }
  assert.ok(sessionCookie.value === payload.accessToken + '.' + payload.refreshToken, 'Cookie and body must describe the same real session')
  return { accessToken: payload.accessToken, refreshToken: payload.refreshToken, cookie: sessionCookie }
}

export async function installFixturePanelSession(context, base, session, gatewayKey) {
  assert.ok(session?.accessToken && session?.cookie?.name && session?.cookie?.value, 'Browser fixtures require a real panel session')
  await context.addCookies([{ ...session.cookie, url: base, httpOnly: true, sameSite: 'Lax' }])
  // Preserve the existing gateway configuration used by legacy management/model APIs.
  await context.addInitScript(({ key, origin }) => {
    if (location.origin !== origin) return
    localStorage.setItem('agent2api.webKey', key)
    localStorage.setItem('agent2api.webKey.origin', key)
  }, { key: gatewayKey, origin: new URL(base).origin })
}
