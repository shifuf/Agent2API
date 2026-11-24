import * as React from 'react'
import { Alert, Button, Input, Label, Spinner } from '@ui'
import type { LoginRequest } from './plugin-login-interaction'

import {
  MANAGEMENT_SESSION_CHANGE, managedBrowserUrl, managedLoginSourceGeneration, managedStepKey, readManagedInteraction,
  managedLoginRecord as record, managedLoginText as text,
  type ManagedInteraction, type ManagedLoginScope, type ManagedTranslate as Translate,
} from './plugin-managed-state'
export * from './plugin-managed-state'

import { isCaptchaBusy, setCaptchaBusy, subscribeCaptchaBusy } from './plugin-captcha-busy'

export const subscribeManagedCaptchaBusy = subscribeCaptchaBusy
export const managedCaptchaBusy = isCaptchaBusy
function captchaBusy(owner: symbol, busy: boolean) {
  setCaptchaBusy(owner, busy)
}

type BusinessReply = { captchaResult: boolean; bizResult: boolean }
type AliyunApi = {
  isBusy(): boolean
  solve(config: NonNullable<ManagedInteraction['captcha']>, request: (param: string) => Promise<BusinessReply>, signal: AbortSignal,
    options: { protocol: 'v2'; onPhase(phase: string): void }): Promise<BusinessReply>
}
let loading: Promise<AliyunApi> | null = null
function loadAliyun(): Promise<AliyunApi> {
  const existing = (window as Window & { wbAliyunCaptcha?: AliyunApi }).wbAliyunCaptcha
  if (typeof existing?.solve === 'function' && typeof existing.isBusy === 'function') return Promise.resolve(existing)
  if (loading) return loading
  // 只加载主程序原有组件；不从插件加载脚本，不改变其 V2 协议或自动验证策略。
  loading = new Promise<AliyunApi>((resolve, reject) => {
    const script = document.createElement('script')
    const finish = (error?: Error) => {
      window.clearTimeout(timer)
      script.onload = null; script.onerror = null
      const api = (window as Window & { wbAliyunCaptcha?: AliyunApi }).wbAliyunCaptcha
      if (error || typeof api?.solve !== 'function' || typeof api.isBusy !== 'function') { script.remove(); reject(error || new Error('captcha_unavailable')) }
      else resolve(api)
    }
    const timer = window.setTimeout(() => finish(new Error('captcha_load_timeout')), 15000)
    script.src = new URL('aliyun-captcha.js', document.baseURI).href
    script.onload = () => finish()
    script.onerror = () => finish(new Error('captcha_load_failed'))
    document.head.appendChild(script)
  }).catch(error => { loading = null; throw error })
  return loading
}

const aborted = () => new DOMException('请求已取消', 'AbortError')
/** abort 只停止本地等待；原请求的迟到落定仍被消费，不表示已撤回上游请求。 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted())
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

export function ManagedLoginInteraction({ step, deadline, scope, request, refresh, accept, onSubmitting,
  attemptedBefore, markAttempted, captchaAutoStartedBefore = false, markCaptchaAutoStarted, browserOpenedBefore = false, markBrowserOpened, callbackSubmitted, markCallbackSubmitted, openExternal, openEmbedded, t }: {
  step: ManagedInteraction
  deadline: number
  scope: ManagedLoginScope
  request: LoginRequest
  refresh(): Promise<void>
  accept(step: ManagedInteraction, startedAt: number): void
  onSubmitting(busy: boolean, owner: symbol): void
  attemptedBefore: boolean
  markAttempted(): void
  captchaAutoStartedBefore?: boolean
  markCaptchaAutoStarted?: () => void
  browserOpenedBefore?: boolean
  markBrowserOpened?: () => void
  callbackSubmitted: boolean
  markCallbackSubmitted(value: boolean): void
  openExternal(url: string): void | Promise<void>
  openEmbedded?(flow: string, interaction: string): void | Promise<void>
  t: Translate
}) {
  const [busy, setBusy] = React.useState('')
  const [opening, setOpening] = React.useState(false)
  const [attempted, setAttempted] = React.useState(attemptedBefore)
  const [expired, setExpired] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [autoOpenNotice, setAutoOpenNotice] = React.useState('')
  const [hasCallback, setHasCallback] = React.useState(false)
  const [callbackSent, setCallbackSent] = React.useState(callbackSubmitted)
  const callbackLocked = React.useRef(callbackSubmitted)
  const captchaAutoStarted = React.useRef(captchaAutoStartedBefore)
  const browserOpened = React.useRef(browserOpenedBefore)
  const input = React.useRef<HTMLInputElement>(null)
  const controller = React.useRef<AbortController | null>(null)
  const owner = React.useRef(Symbol(`${scope.key}:${step.id}`))
  const sourceGeneration = React.useRef(managedLoginSourceGeneration())
  const alive = React.useRef(true)
  const used = React.useRef(attemptedBefore)
  const latest = React.useRef({ step, deadline, scope, request, refresh, accept, onSubmitting, openExternal, openEmbedded })
  latest.current = { step, deadline, scope, request, refresh, accept, onSubmitting, openExternal, openEmbedded }
  const current = () => alive.current && sourceGeneration.current === managedLoginSourceGeneration()
    && latest.current.scope.current() && performance.now() < latest.current.deadline
  const scopeKey = scope.key
  const stepKey = managedStepKey(step)
  const scopeAlive = scope.current()
  const clearInput = () => { if (input.current) input.current.value = ''; setHasCallback(false) }

  React.useEffect(() => {
    alive.current = sourceGeneration.current === managedLoginSourceGeneration()
    const ownerKey = owner.current
    const stop = () => {
      alive.current = false; controller.current?.abort(); captchaBusy(ownerKey, false)
      if (input.current) input.current.value = ''
    }
    const sourceLost = () => {
      stop(); used.current = true; callbackLocked.current = true
      setAttempted(true); setCallbackSent(true); setHasCallback(false); setExpired(true); setBusy('')
      setNotice(''); setError(t('管理会话已变化，本次登录资格已失效；不会继续查询或重发原流程。'))
      latest.current.onSubmitting(false, ownerKey)
    }
    window.addEventListener('pagehide', stop)
    window.addEventListener(MANAGEMENT_SESSION_CHANGE, sourceLost)
    return () => {
      alive.current = false; stop(); window.removeEventListener('pagehide', stop)
      window.removeEventListener(MANAGEMENT_SESSION_CHANGE, sourceLost); latest.current.onSubmitting(false, owner.current)
    }
  }, [scopeKey, stepKey])
  React.useEffect(() => {
    const expire = () => {
      controller.current?.abort()
      setExpired(true)
      clearInput()
      if (sourceGeneration.current === managedLoginSourceGeneration()) void latest.current.refresh()
    }
    const timer = window.setTimeout(expire, Math.max(0, deadline - performance.now()))
    return () => window.clearTimeout(timer)
  }, [deadline])
  React.useEffect(() => {
    if (step.status !== 'ready' || !scopeAlive) {
      controller.current?.abort()
      clearInput()
    }
  }, [step.status, scopeAlive])
  React.useEffect(() => {
    if (captchaAutoStarted.current || used.current || attempted || busy || expired || !current()
      || step.status !== 'ready' || !step.captcha || isCaptchaBusy()) return
    captchaAutoStarted.current = true
    markCaptchaAutoStarted?.()
    void verify()
  }, [scopeKey, stepKey, step.status, scopeAlive, busy, expired, attempted])

  React.useEffect(() => {
    if (browserOpened.current || !current() || busy || expired || callbackSent || callbackLocked.current
      || step.status !== 'ready' || !step.browser || !managedBrowserUrl(step.browser.url)) return
    browserOpened.current = true
    markBrowserOpened?.()
    void open(true)
  }, [scopeKey, stepKey, step.status, scopeAlive, busy, expired, callbackSent])

  async function verify() {
    if (controller.current || used.current || !current() || step.status !== 'ready' || !step.captcha) return
    const abort = new AbortController()
    controller.current = abort
    setBusy('verifying'); setError(''); setNotice('')
    const context = latest.current
    const next: { value?: { step: ManagedInteraction; startedAt: number } } = {}
    let sent = false
    const live = () => current() && latest.current.step.status === 'ready' && latest.current.scope.key === scopeKey
      && managedStepKey(latest.current.step) === stepKey && !abort.signal.aborted && controller.current === abort
    try {
      const api = await untilAborted(loadAliyun(), abort.signal)
      if (!live()) throw aborted()
      if (api.isBusy()) throw new Error('captcha_busy')
      captchaBusy(owner.current, true)
      const result = await untilAborted(api.solve(step.captcha, async param => {
        if (!live() || sent || !text(param, 32768)) return { captchaResult: false, bizResult: false }
        sent = true
        used.current = true; markAttempted(); setAttempted(true)
        context.onSubmitting(true, owner.current)
        const startedAt = performance.now()
        try {
          const response = await untilAborted(context.request<unknown>('POST', '/api/plugins/login', {
            state: step.flow, interaction: step.id, inputs: {},
            captcha: { engine: 'aliyun', configId: step.captcha!.configId, param },
          }, { signal: abort.signal }), abort.signal)
          if (!live() || !record(response) || typeof response.captchaResult !== 'boolean' || typeof response.bizResult !== 'boolean') {
            return { captchaResult: false, bizResult: false }
          }
          if (response.captchaResult && response.bizResult) {
            const browser = readManagedInteraction(response.interaction, step.flow, scope)
            if (response.accepted !== true || !browser.browser || browser.captcha || browser.id === step.id || browser.status !== 'ready'
              || Math.min(scope.deadline, startedAt + browser.remainingMs) <= performance.now()) {
              return { captchaResult: false, bizResult: false }
            }
            next.value = { step: browser, startedAt }
          }
          // V2 必须收到这次换授权地址的真实业务布尔值；不等待整个 OAuth，也不以 accepted 代替。
          return { captchaResult: response.captchaResult, bizResult: response.bizResult }
        } catch { return { captchaResult: false, bizResult: false } }
      }, abort.signal, { protocol: 'v2', onPhase: phase => { if (live()) setBusy(phase) } }), abort.signal)
      if (!live()) return
      if (result.captchaResult && result.bizResult && next.value) {
        context.accept(next.value.step, next.value.startedAt)
      } else setError(t('登录验证结果未确认，请刷新当前步骤；不会自动重发验证凭据。'))
    } catch (failure) {
      if (current() && !abort.signal.aborted) {
        if (failure instanceof Error && failure.name === 'CaptchaCancelledError') {
          setNotice(t('已取消人机验证，可点击下方按钮重新开始。'))
        } else {
          setError(t('登录验证未完成，请刷新当前步骤后重试。'))
        }
      }
    } finally {
      context.onSubmitting(false, owner.current)
      captchaBusy(owner.current, false)
      if (controller.current === abort) controller.current = null
      if (alive.current) setBusy('')
      if (current()) await context.refresh()
    }
  }

  async function submitCallback() {
    if (controller.current || callbackLocked.current || !current() || step.status !== 'ready' || !step.browser?.manualCallback) return
    const callbackUrl = input.current?.value || ''
    if (!callbackUrl.trim()) return
    try {
      const url = new URL(callbackUrl)
      if (callbackUrl.length > 32768 || /[\u0000-\u0020\u007f]/.test(callbackUrl)
        || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error()
    } catch { setError(t('请粘贴本次授权完成后的完整回调地址，不要修改其中的参数。')); return }
    const abort = new AbortController()
    controller.current = abort
    const context = latest.current
    callbackLocked.current = true; markCallbackSubmitted(true)
    setBusy('submitting'); setError(''); setNotice(''); setCallbackSent(true); clearInput()
    context.onSubmitting(true, owner.current)
    try {
      const reply = await untilAborted(context.request<unknown>('POST', '/api/plugins/login', {
        state: step.flow, interaction: step.id, inputs: { callbackUrl }, captcha: null,
      }, { signal: abort.signal }), abort.signal)
      if (!current() || abort.signal.aborted || managedStepKey(latest.current.step) !== stepKey || latest.current.scope.key !== scopeKey) return
      if (record(reply) && reply.retryable === true && reply.accepted !== true) {
        callbackLocked.current = false; markCallbackSubmitted(false)
        setCallbackSent(false)
        setError(t('回调未被接受，请重新复制本次登录的完整回调地址'))
      } else if (record(reply) && reply.accepted === true) {
        setNotice(t('回调已提交，仍需等待网关确认账号登录完成。'))
      } else setError(t('授权回调提交结果未确认，请刷新当前步骤；不会自动重发。'))
    } catch {
      if (current() && !abort.signal.aborted) setError(t('授权回调提交结果未确认，请刷新当前步骤；不会自动重发。'))
    } finally {
      context.onSubmitting(false, owner.current)
      if (controller.current === abort) controller.current = null
      if (alive.current) setBusy('')
      if (current()) await context.refresh()
    }
  }

  async function open(auto = false) {
    if (!current() || busy || opening || callbackSent || step.status !== 'ready' || !step.browser || !managedBrowserUrl(step.browser.url)) return
    setOpening(true)
    setError('')
    setNotice('')
    setAutoOpenNotice('')
    try {
      if (step.browser.browserMode === 'embedded') {
        if (!latest.current.openEmbedded) throw new Error('embedded_login_unavailable')
        await latest.current.openEmbedded(step.flow, step.id)
      } else { await latest.current.openExternal(step.browser.url) }
      if (!current()) return
      setNotice(step.browser.browserMode === 'embedded'
        ? t('已打开官方授权窗口，请在弹出的窗口中完成登录；如果未看到窗口，可点击下方按钮重新打开。')
        : t('已打开系统浏览器授权页，请在浏览器中完成登录；如果页面未切换到前台，可切到浏览器查看或点击下方按钮重新打开。'))
    }
    catch {
      if (!current()) return
      if (auto) setAutoOpenNotice(t('未能自动打开官方授权页，请点击下方按钮手动打开。'))
      else setError(t('打开授权页失败，请刷新当前步骤后重试。'))
    } finally {
      if (alive.current) setOpening(false)
    }
  }

  const disabled = Boolean(busy) || opening || expired || !scopeAlive || step.status !== 'ready'
    || sourceGeneration.current !== managedLoginSourceGeneration()
  return <section className='flex flex-col gap-3 rounded-lg border border-hairline p-3' aria-label={step.title}>
    <h3 className='text-sm font-semibold'>{step.title}</h3>
    {step.message ? <p className='whitespace-pre-wrap text-xs text-muted-foreground'>{step.message}</p> : null}
    {step.status !== 'ready' ? <p role='status' className='flex items-center gap-2 text-xs text-muted-foreground'>
      <Spinner className='size-3' />{step.status === 'preparing' ? t('正在准备安全登录，请稍候…') : t('正在处理本次登录，请勿重复提交。')}
    </p> : null}
    {step.captcha ? <Button disabled={disabled || attempted} onClick={() => void verify()}>
      {busy ? <Spinner /> : null}{busy ? t('正在进行人机验证…') : t('开始登录验证')}
    </Button> : null}
    {step.browser ? <>
      {autoOpenNotice ? <p role='status' className='text-xs text-muted-foreground'>{autoOpenNotice}</p> : null}
      <Button variant='outline' disabled={disabled || callbackSent} onClick={() => void open()}>
        {opening ? <Spinner /> : null}{autoOpenNotice ? t('打开官方授权页') : t('重新打开官方授权页')}
      </Button>
      {step.browser.manualCallback ? <>
        <p className='text-xs text-muted-foreground'>{t('授权完成后如未自动返回，请粘贴本次完整回调地址。打开浏览器不代表登录成功。')}</p>
        <Label>{t('完整回调地址（原样提交）')}
          <Input ref={input} type='password' autoComplete='off' autoCapitalize='none' spellCheck={false}
            disabled={disabled || callbackSent} maxLength={32768} onChange={event => { setHasCallback(Boolean(event.currentTarget.value)); setError(''); setNotice('') }} />
        </Label>
        <Button variant='outline' disabled={disabled || callbackSent || !hasCallback} onClick={() => void submitCallback()}>
          {busy ? <Spinner /> : null}{t('提交授权回调')}
        </Button>
      </> : null}
    </> : null}
    {expired ? <Alert variant='warning'>{t('本次登录步骤已过期，请取消后重新发起登录。')}</Alert> : null}
    {notice ? <p role='status' className='text-xs text-muted-foreground'>{notice}</p> : null}
    {error ? <Alert variant='destructive'>{error}</Alert> : null}
    {error || attempted || callbackSent || expired ? <Button variant='outline'
      disabled={Boolean(busy) || sourceGeneration.current !== managedLoginSourceGeneration() || !scopeAlive}
      onClick={() => { if (sourceGeneration.current === managedLoginSourceGeneration() && scope.current()) void refresh() }}>{t('刷新当前步骤')}</Button> : null}
  </section>
}
