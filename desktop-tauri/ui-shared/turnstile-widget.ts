export type WidgetResult = { state: 'verified'; token: string } | { state: 'error' | 'expired' }

export function mountTurnstile(host: HTMLElement, widgetOrigin: string, gatewayUrl: string, siteKey: string, onResult: (value: WidgetResult) => void) {
  const origin = new URL(widgetOrigin)
  if (origin.protocol !== 'https:' || origin.origin !== widgetOrigin || origin.hostname === location.hostname || origin.hostname === new URL(gatewayUrl,location.href).hostname) throw new Error('A separate HTTPS widget host is required')
  const channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  const frame = document.createElement('iframe')
  const ports = new MessageChannel()
  let closed = false
  let expiry: ReturnType<typeof setTimeout> | undefined
  function close() {
    if (closed) return
    closed = true; clearTimeout(expiry); ports.port1.close(); ports.port2.close(); frame.remove()
  }
  function fail() { if (!closed) { close(); onResult({ state: 'error' }) } }
  expiry = setTimeout(fail, 120000)
  ports.port1.onmessage = ({ data }) => {
    if (closed) return
    if (data?.state === 'verified' && typeof data.token === 'string' && /^[\x21-\x7e]{1,2048}$/.test(data.token)) {
      clearTimeout(expiry); expiry = setTimeout(() => { if (!closed) { close(); onResult({ state: 'expired' }) } }, 280000)
      onResult({ state: 'verified', token: data.token })
    } else if (data?.state === 'expired') { close(); onResult({ state: 'expired' }) }
    else fail()
  }
  frame.title = 'Cloudflare Turnstile'; frame.setAttribute('sandbox', 'allow-scripts allow-same-origin'); frame.referrerPolicy = 'no-referrer'
  frame.style.cssText = 'border:0;width:100%;min-width:0;height:72px;display:block'
  frame.onload = () => { if (!closed) { try { frame.contentWindow?.postMessage({ channel, siteKey }, widgetOrigin, [ports.port2]) } catch { fail() } } }
  frame.onerror = fail
  frame.src = widgetOrigin + '/turnstile-widget.html#' + channel
  host.appendChild(frame)
  return close
}
