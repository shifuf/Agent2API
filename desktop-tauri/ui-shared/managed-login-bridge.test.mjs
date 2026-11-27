import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const rust = await readFile(new URL('../src-tauri/server/src/web_shim.rs', import.meta.url), 'utf8')
const script = rust.slice(rust.indexOf('    r#"') + 7, rust.lastIndexOf('"#'))

function harness(receive, now = 0) {
  const listeners = new Map()
  const requests = []
  const prompts = []
  const window = {
    location: { href: 'http://127.0.0.1:43991/', origin: 'http://127.0.0.1:43991' },
    addEventListener(name, listener) { listeners.set(name, listener) },
    dispatchEvent(event) { listeners.get(event.type)?.(event) },
  }
  const context = vm.createContext({
    window, URL, URLSearchParams, Event, console, Set, Map, Number, Date,
    performance: { now: () => now },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout,
    document: { addEventListener() {} },
  })
  const instrumentation = `
    window.probe = {
      activate(flow) { currentFlow = flow; loginActive = true; loginProvider = flow.provider; },
      poll: pollManagedWait,
      result: managedWaitResult,
      change() { notifyManagementSessionChanged(); },
      replaceCall(next) { call = next; },
      replaceUnknown(next) { queryUnconfirmedManagedWait = next; },
    };
  `
  vm.runInContext(script.replace(/\}\)\(\);\s*$/, instrumentation + '\n})();'), context)
  const bridge = window.probe
  const flow = {
    provider: 'trae', state: 'original-flow', methodIndex: 0,
    managed: true, managementGeneration: 0, monotonicDeadline: 100, pollIntervalMs: 0,
  }
  bridge.activate(flow)
  bridge.replaceCall(async (method, path, body) => {
    requests.push({ method, path, body })
    return receive(flow, bridge)
  })
  bridge.replaceUnknown(async current => {
    prompts.push(current.state)
    const error = new Error('read-only confirmation required')
    error.loginStateReadOnly = true
    throw error
  })
  return { bridge, flow, requests, prompts }
}

const receipt = (phase = 'saved') => ({
  managedLogin: true, provider: 'trae', flow: 'original-flow', methodIndex: 0,
  phase, saved: phase === 'saved', pending: phase === 'waiting', done: phase !== 'waiting',
  session: { provider: 'trae', accountUid: 'saved-account' },
})

test('a saved receipt belongs to the exact provider, flow and selected method', async () => {
  const state = harness(() => receipt())
  assert.equal((await state.bridge.poll(state.flow)).session.accountUid, 'saved-account')
  for (const patch of [{ provider: 'other' }, { flow: 'other' }, { methodIndex: 1 }, { saved: null }]) {
    assert.throws(() => state.bridge.result({ ...receipt(), ...patch }, state.flow))
  }
  assert.deepEqual(state.requests.map(request => request.method), ['GET'])
})

test('cancellation while a wait request is pending discards a late saved receipt', async () => {
  const state = harness(flow => { flow.canceled = true; return receipt() })
  await assert.rejects(state.bridge.poll(state.flow), error => error.canceled === true)
  assert.equal(state.prompts.length, 0)
  assert.equal(state.requests.length, 1)
})

test('a changed management session cannot accept or retry the original flow', async () => {
  const state = harness((flow, bridge) => { flow.sourceLost = true; return receipt() })
  await assert.rejects(state.bridge.poll(state.flow), /管理会话已变化/)
  assert.equal(state.requests.length, 1)
  assert.equal(state.prompts.length, 0)
})

test('timeout requires a read-only confirmation and never starts or saves another login', async () => {
  const state = harness(() => receipt('waiting'), 101)
  await assert.rejects(state.bridge.poll(state.flow), error => error.loginStateReadOnly === true)
  assert.deepEqual(state.prompts, ['original-flow'])
  assert.deepEqual(state.requests.map(request => request.method), ['GET'])
  assert.match(state.requests[0].path, /wait\?state=original-flow$/)
})

test('a transport failure asks for a read-only query instead of replaying credentials', async () => {
  const state = harness(() => { throw new Error('connection interrupted') })
  await assert.rejects(state.bridge.poll(state.flow), error => error.loginStateReadOnly === true)
  assert.equal(state.requests.length, 1)
  assert.deepEqual(state.prompts, ['original-flow'])
})
