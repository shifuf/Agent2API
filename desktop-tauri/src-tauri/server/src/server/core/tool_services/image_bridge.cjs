const { createInterface } = require('node:readline')

async function forward(frame) {
  const url = new URL(process.env.AGENT2API_IMAGE_ENDPOINT)
  const key = process.env.AGENT2API_IMAGE_KEY
  if (!key || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/mcp/image-generation')
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw Error()
  const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    signal: AbortSignal.timeout(125000), body: JSON.stringify(frame) })
  if (!response.ok) throw Error()
  if (response.status !== 202 && Object.hasOwn(frame, 'id')) process.stdout.write(JSON.stringify(await response.json()) + '\n')
}

;(async () => {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let frame
    try {
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw Error()
      frame = JSON.parse(line)
      if (!frame || Array.isArray(frame) || frame.jsonrpc !== '2.0') throw Error()
      await forward(frame)
    } catch {
      if (!frame || Object.hasOwn(frame, 'id')) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame?.id ?? null, error: { code: -32000, message: 'Image gateway request failed. Do not resubmit; check the original request_id.' } }) + '\n')
    }
  }
})().catch(() => { process.exitCode = 1 })
