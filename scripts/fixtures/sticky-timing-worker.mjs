// Controlled remote dependency: the real Host and RpcAdapter still own all RPC,
// account selection, classification, deadlines, retries and channel health.
import readline from 'node:readline'
import { appendFile, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'))
async function handle(frame) {
  const params = frame.params || {}
  const channel = Object.keys(fixture.accounts).find(channel => fixture.accounts[channel] === params.account)
  await appendFile(fixture.control + '.rpc.jsonl', JSON.stringify({ method: frame.method, status: params.status, channel }) + '\n')
  let result
  switch (frame.method) {
    case 'init': result = fixture.providers; break
    case 'models.refresh': result = { refreshed: true, count: fixture.providers[0].default_models.length,
      models: fixture.providers[0].default_models, meta: { remote: true, refreshed_at: Date.now() } }; break
    case 'models.list': result = { models: fixture.providers[0].default_models }; break
    case 'token.ensure':
    case 'token.refresh': {
      const control = JSON.parse(await readFile(fixture.control, 'utf8'))
      if (channel === 'b' && control.slowPrepare) await delay(350)
      result = 'fixture-token'
      break
    }
    case 'chat': result = { url: fixture.upstream + '/messages', upstream: 'chat', body: params.body,
      headers: [['Content-Type', 'application/json'], ['Authorization', 'Bearer timing-' + channel]] }; break
    case 'is_error_response': result = false; break
    case 'conversation': {
      const control = JSON.parse(await readFile(fixture.control, 'utf8'))
      const send = value => process.stdout.write(JSON.stringify({ id: frame.id, ...value }) + '\n')
      if (channel !== 'c' && control.mode === 'cleanup') {
        send({ error: { code: 'provider_http:' + JSON.stringify({ status: 502, code: 'network_cleanup_unconfirmed' }),
          message: 'fixture resource cleanup was not confirmed' } })
        return
      }
      const status = channel !== 'c' ? Number(control.mode) : 200
      send({ event: 'head', status, headers: {}, upstream: 'chat' })
      if (status === 200) {
        const text = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: channel }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
        send({ event: 'chunk', data: Buffer.from(text).toString('base64') })
      }
      send({ result: null })
      return
    }
    case 'classify': result = params.status === 429 ? fixture.quota : { ...fixture.fatal, status: params.status }; break
    case 'error.policy': result = {}; break
    case 'retry.decision': result = { action: 'default' }; break
    case 'retry.advice': result = null; break
    case 'token.expiring': result = false; break
    case 'account.view': result = { name: params.account }; break
    case 'shutdown': result = null; break
    case 'abort': return
    default: result = null
  }
  process.stdout.write(JSON.stringify({ id: frame.id, result }) + '\n')
}
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
  const frame = JSON.parse(line)
  if (frame.method) handle(frame).catch(error => process.stdout.write(JSON.stringify({ id: frame.id,
    error: { code: 'internal', message: error.message } }) + '\n'))
})
input.on('close', () => process.exit(0))
