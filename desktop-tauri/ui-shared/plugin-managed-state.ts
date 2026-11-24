export type ManagedInteraction = {
  type: 'managed'
  id: string
  provider: string
  flow: string
  methodIndex: number
  status: 'preparing' | 'ready' | 'processing'
  title: string
  message: string
  fields: []
  expiresAt: number
  remainingMs: number
  captcha: null | { engine: 'aliyun'; protocol: 'v2'; configId: string; prefix: string; sceneId: string; region: string }
  browser: null | { url: string; browserMode: 'external' | 'embedded'; manualCallback: boolean; callbackInput: 'url' }
}
export type ManagedLoginScope = {
  provider: string
  methodIndex: number
  key: string
  deadline: number
  current(): boolean
}
export type ManagedLoginWaitPhase = 'waiting' | 'saving' | 'saved' | 'failed' | 'canceled' | 'unconfirmed'
export type ManagedLoginSummary = {
  accountUid?: string; accountId?: string; nickname?: string; edition?: string; provider: string
  proxySaved?: boolean; warning?: string
}
export type ManagedLoginWait = {
  managedLogin: true; provider: string; flow: string; methodIndex: number
  phase: ManagedLoginWaitPhase; saved: boolean | null; pending?: boolean; done?: boolean
  error?: string; instructions?: string; hint?: string; session?: ManagedLoginSummary | null
}
export type ManagedLoginWaitOwner = { provider: string; flow?: string; methodIndex?: number }
export const MANAGEMENT_SESSION_CHANGE = 'wb:management-session-changed'
let managementGeneration = 0
// 来自壳/网页/手机的权威通知；只记代次，不读取凭据，也不据恢复会话复活旧 flow。
if (typeof window !== 'undefined') window.addEventListener(MANAGEMENT_SESSION_CHANGE, () => { managementGeneration++ })
export const managedLoginSourceGeneration = () => managementGeneration

export type ManagedTranslate = (key: string, vars?: Record<string, string | number>) => string
export const managedLoginRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
export const managedLoginText = (value: unknown, limit = 512): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)
const record = managedLoginRecord
const text = managedLoginText
const managedId = (value: unknown, limit = 512): value is string => text(value, limit) && value.trim() === value
const MANAGED_WAIT_PHASES: readonly string[] = ['waiting', 'saving', 'saved', 'failed', 'canceled', 'unconfirmed']

/** 只查看既有桥包装层；外层 ok/summary 不能覆盖内部 managed 保存事实。 */
export function managedLoginWaitRecord(value: unknown): Record<string, unknown> | undefined {
  const seen = new Set<Record<string, unknown>>()
  const found = new Set<Record<string, unknown>>()
  const inspect = (item: unknown, depth: number) => {
    if (!record(item) || seen.has(item) || depth > 3) return
    seen.add(item)
    if (item.managedLogin === true) found.add(item)
    // 只查现有信封键，不走任意属性或账号字段；有界并防止自引用。
    for (const key of ['data', 'payload', 'session']) inspect(item[key], depth + 1)
  }
  inspect(value, 0)
  if (found.size > 1) throw new Error('conflicting_managed_login_wait')
  return found.values().next().value
}

/** 同源 wait 的严格公开投影；done 只表示任务结束，昵称/空对象不能充当保存摘要。 */
export function readManagedLoginWait(raw: unknown, owner?: ManagedLoginWaitOwner): ManagedLoginWait {
  const value = managedLoginWaitRecord(raw)
  const envelope = record(raw) ? raw : undefined
  const data = envelope && record(envelope.data) ? envelope.data : undefined
  const payload = envelope && record(envelope.payload) ? envelope.payload : data && record(data.payload) ? data.payload : undefined
  const savedOutcome = value?.phase === 'saved' || value?.saved === true
  if ([envelope, data, payload].some(item => item && (item.success === false || savedOutcome && item.ok === false))) {
    throw new Error('conflicting_managed_login_envelope')
  }
  if (!value || !managedId(value.provider, 128) || !managedId(value.flow)
    || typeof value.methodIndex !== 'number' || !Number.isSafeInteger(value.methodIndex) || value.methodIndex < 0
    || owner && (value.provider !== owner.provider || owner.flow !== undefined && value.flow !== owner.flow
      || owner.methodIndex !== undefined && value.methodIndex !== owner.methodIndex)
    || typeof value.phase !== 'string' || !MANAGED_WAIT_PHASES.includes(value.phase)
    || value.saved !== null && typeof value.saved !== 'boolean'
    || value.pending !== undefined && typeof value.pending !== 'boolean'
    || value.done !== undefined && typeof value.done !== 'boolean') throw new Error('invalid_managed_login_wait')
  const phase = value.phase as ManagedLoginWaitPhase
  const pending = value.pending === true
  const done = value.done === true
  const terminal = ['saved', 'failed', 'canceled', 'unconfirmed'].includes(phase)
  const expectedSaved = phase === 'saved' ? true : phase === 'saving' || phase === 'unconfirmed' ? null : false
  if (value.saved !== expectedSaved || (terminal ? !done || pending : done || !pending)) throw new Error('invalid_managed_login_state')
  const optionalText = (key: string): string | undefined => {
    const item = value[key]
    if (item !== undefined && item !== null && (typeof item !== 'string' || item.length > 8192)) throw new Error('invalid_managed_login_text')
    return typeof item === 'string' ? item : undefined
  }
  const error = optionalText('error')
  if (error && ['waiting', 'saving', 'saved'].includes(phase)) throw new Error('conflicting_managed_login_error')
  let session: ManagedLoginSummary | null = null
  if (phase === 'saved') {
    const summary = value.session
    if (!record(summary) || summary.provider !== value.provider
      || !managedId(summary.accountUid) && !managedId(summary.accountId)) throw new Error('invalid_managed_login_summary')
    for (const key of ['accountUid', 'accountId']) {
      if (summary[key] !== undefined && summary[key] !== null && !managedId(summary[key])) throw new Error('invalid_managed_login_account')
    }
    session = { provider: value.provider }
    for (const key of ['accountUid', 'accountId', 'nickname', 'edition', 'warning'] as const) {
      if (typeof summary[key] === 'string' && summary[key].length <= (key === 'warning' ? 8192 : 512)) session[key] = summary[key]
    }
    if (typeof summary.proxySaved === 'boolean') session.proxySaved = summary.proxySaved
  }
  // 非 saved 的任何夹带摘要都丢弃；不能拿另一层账号或旧 session 补一次成功。
  return { managedLogin: true, provider: value.provider, flow: value.flow, methodIndex: value.methodIndex,
    phase, saved: value.saved, ...(value.pending !== undefined ? { pending } : {}), ...(value.done !== undefined ? { done } : {}),
    error, instructions: optionalText('instructions'), hint: optionalText('hint'), session }
}

export function managedLoginWaitMessage(value: ManagedLoginWait, t: ManagedTranslate): string {
  if (value.phase === 'saving') return t('正在保存账号，保存结果尚未确认')
  if (value.phase === 'unconfirmed') return t('账号保存未确认，请查询本次状态；不会再次保存。')
  if (value.phase === 'failed') return value.error ? t(value.error) : t('托管登录未确认保存账号，未宣布登录成功')
  if (value.phase === 'canceled') return t('已取消登录等待')
  if (value.phase === 'saved') return t('账号已确认保存')
  return t('等待账号登录完成…')
}

/** 只做语法防御；站点许可由宿主核准，不从 URL 派生或扩大授权范围。 */
export function managedBrowserUrl(value: unknown): value is string {
  if (!text(value, 16384) || /[\s\\]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
  } catch { return false }
}

export function readManagedInteraction(value: unknown, flow: string, scope: ManagedLoginScope): ManagedInteraction {
  if (!record(value) || value.type !== 'managed' || !text(value.id) || value.provider !== scope.provider || value.flow !== flow
    || value.methodIndex !== scope.methodIndex || !Number.isSafeInteger(value.methodIndex)
    || !['preparing', 'ready', 'processing'].includes(String(value.status)) || typeof value.title !== 'string'
    || typeof value.message !== 'string' || value.title.length > 256 || value.message.length > 8192
    || !Array.isArray(value.fields) || value.fields.length !== 0
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0
    || typeof value.remainingMs !== 'number' || !Number.isFinite(value.remainingMs) || value.remainingMs < 0) {
    throw new Error('invalid_managed_interaction')
  }
  let captcha: ManagedInteraction['captcha'] = null
  let browser: ManagedInteraction['browser'] = null
  if (value.captcha !== null) {
    const config = value.captcha
    if (!record(config) || config.engine !== 'aliyun' || config.protocol !== 'v2'
      || !text(config.configId) || !text(config.prefix) || !text(config.sceneId) || !text(config.region)) throw new Error('invalid_managed_captcha')
    captcha = { engine: 'aliyun', protocol: 'v2', configId: config.configId, prefix: config.prefix, sceneId: config.sceneId, region: config.region }
  }
  if (value.browser !== null) {
    const page = value.browser
    if (!record(page) || !['external', 'embedded'].includes(String(page.browserMode)) || typeof page.manualCallback !== 'boolean' || page.callbackInput !== 'url'
      || !managedBrowserUrl(page.url)) throw new Error('invalid_managed_browser')
    browser = { url: page.url, browserMode: page.browserMode as 'external' | 'embedded', manualCallback: page.manualCallback, callbackInput: 'url' }
  }
  if (captcha && browser || value.status === 'ready' && !captcha && !browser) throw new Error('invalid_managed_step')
  return { type: 'managed', id: value.id, provider: scope.provider, flow, methodIndex: scope.methodIndex,
    status: value.status as ManagedInteraction['status'], title: value.title, message: value.message, fields: [],
    expiresAt: value.expiresAt, remainingMs: value.remainingMs, captcha, browser }
}

/** 剩余时间和说明变化不是新步骤；轮询不能重置验证码或再次允许已用票据。 */
export const managedStepKey = (step: ManagedInteraction) => JSON.stringify([
  step.provider, step.flow, step.methodIndex, step.id, step.captcha, step.browser,
])

