import * as React from 'react'
import { Alert, Button, Input, Label, Spinner } from '@ui'
import { SearchableSelect } from './searchable-select'
import { Captcha } from './plugin-login-captcha'
import { readPluginLoginForm, type PluginLoginForm as Form } from './plugin-login-form'
import { ManagedLoginInteraction, managedStepKey, readManagedInteraction, type ManagedInteraction, type ManagedLoginScope } from './plugin-login-managed'
import type { PluginTranslate } from './plugin-controls'

export type LoginRequest = <T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown,
  options?: { signal?: AbortSignal }) => Promise<T>

export function PluginLoginInteraction({ flow, provider, request, t, managed, openExternal, onAvailable }: {
  flow: string; provider: string; request: LoginRequest; t: PluginTranslate; managed?: ManagedLoginScope
  openExternal: (url: string) => void | Promise<void>; onAvailable?: (available: boolean) => void
}) {
  const [interaction, setInteraction] = React.useState<Form | ManagedInteraction | null>(null)
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [captcha, setCaptcha] = React.useState<unknown>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [readError, setReadError] = React.useState('')
  const alive = React.useRef(true)
  const generation = React.useRef(0)
  const read = React.useRef<AbortController | null>(null)
  const submitting = React.useRef(false)
  const submitOwner = React.useRef<symbol | null>(null)
  const signature = React.useRef('')
  const deadlines = React.useRef(new Map<string, number>())
  const attempted = React.useRef(new Set<string>())
  const captchaStarted = React.useRef(new Set<string>())
  const browserOpened = React.useRef(new Set<string>())
  const callbackSent = React.useRef(new Set<string>())
  const latest = React.useRef({ request, managed, onAvailable })
  latest.current = { request, managed, onAvailable }

  const accept = React.useCallback((next: ManagedInteraction, startedAt: number) => {
    const scope = latest.current.managed
    if (!alive.current || !scope?.current()) return
    const key = managedStepKey(next)
    deadlines.current.set(key, Math.min(scope.deadline, startedAt + next.remainingMs, deadlines.current.get(key) ?? Infinity))
    setInteraction(next); setReadError(''); latest.current.onAvailable?.(true)
  }, [])
  const refresh = React.useCallback(async () => {
    if (!flow || !alive.current || submitting.current || read.current || latest.current.managed && !latest.current.managed.current()) return
    const controller = new AbortController()
    read.current = controller
    const current = generation.current
    const startedAt = performance.now()
    try {
      const result = await latest.current.request<{ provider: string; state: string; interaction: Form | ManagedInteraction | null }>('GET',
        `/api/plugins/login?state=${encodeURIComponent(flow)}`, undefined, { signal: controller.signal })
      if (!alive.current || current !== generation.current || submitting.current || controller.signal.aborted) return
      if (!result || result.provider !== provider || result.state !== flow) throw new Error('invalid_plugin_login_owner')
      if (result.interaction && 'type' in result.interaction && result.interaction.type === 'managed') {
        const scope = latest.current.managed
        if (!scope?.current()) throw new Error('managed_scope_unavailable')
        accept(readManagedInteraction(result.interaction, flow, scope), startedAt)
        return
      }
      if (latest.current.managed && result.interaction !== null) throw new Error('invalid_managed_step')
      const form = latest.current.managed && result.interaction === null ? null : readPluginLoginForm(result, provider, flow)
      const key = form ? JSON.stringify([form.id, form.fields, form.captcha]) : ''
      if (signature.current !== key) {
        signature.current = key
        setValues({}); setCaptcha(null); setError('')
      }
      setInteraction(form); setReadError(''); latest.current.onAvailable?.(Boolean(form))
    } catch (cause) {
      const status = cause && typeof cause === 'object' && 'status' in cause ? cause.status : undefined
      if (alive.current && current === generation.current && !controller.signal.aborted && status !== 404) {
        setReadError(t('登录步骤读取失败，请刷新当前步骤或重新发起登录。'))
      }
    } finally { if (read.current === controller) read.current = null }
  }, [flow, provider, managed?.key, accept, t])
  React.useEffect(() => {
    alive.current = true; generation.current++; signature.current = ''; submitting.current = false
    deadlines.current.clear(); attempted.current.clear(); captchaStarted.current.clear(); browserOpened.current.clear(); callbackSent.current.clear()
    setInteraction(null); setValues({}); setCaptcha(null); setBusy(false); setError(''); setReadError('')
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 1500)
    return () => {
      alive.current = false; generation.current++; read.current?.abort(); read.current = null
      window.clearInterval(timer); latest.current.onAvailable?.(false)
    }
  }, [refresh])

  async function submit(form: Form) {
    if (submitting.current || !alive.current) return
    const inputs: Record<string, string> = Object.create(null)
    try {
      for (const field of form.fields) {
        const value = values[field.key] ?? ''
        if (!value.trim() && !field.optional) throw new Error(t('请填写 {label}', { label: field.label }))
        if (value && field.type === 'select' && !field.options.some(option => option.value === value)) throw new Error(t('请选择 {label} 的有效选项', { label: field.label }))
        inputs[field.key] = value
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return }
    submitting.current = true; setBusy(true); setError(''); read.current?.abort(); generation.current++
    const current = generation.current
    try {
      await latest.current.request('POST', '/api/plugins/login', { state: flow, provider, interaction: form.id, inputs, captcha })
      if (!alive.current || current !== generation.current) return
      setValues({}); setCaptcha(null)
    } catch (cause) {
      if (alive.current && current === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current && current === generation.current) { submitting.current = false; setBusy(false); void refresh() }
    }
  }

  if (interaction && 'type' in interaction && interaction.type === 'managed' && managed) {
    const key = managedStepKey(interaction)
    return <ManagedLoginInteraction key={key} step={interaction} scope={managed} request={request} refresh={refresh} accept={accept} t={t}
      deadline={deadlines.current.get(key) ?? managed.deadline} openExternal={openExternal}
      attemptedBefore={attempted.current.has(key)} markAttempted={() => attempted.current.add(key)}
      captchaAutoStartedBefore={captchaStarted.current.has(key)} markCaptchaAutoStarted={() => captchaStarted.current.add(key)}
      browserOpenedBefore={browserOpened.current.has(key)} markBrowserOpened={() => browserOpened.current.add(key)}
      callbackSubmitted={callbackSent.current.has(key)} markCallbackSubmitted={value => { if (value) callbackSent.current.add(key); else callbackSent.current.delete(key) }}
      onSubmitting={(value, owner) => {
        if (value) { submitOwner.current = owner; submitting.current = true; read.current?.abort(); generation.current++ }
        else if (submitOwner.current === owner) { submitOwner.current = null; submitting.current = false }
      }} />
  }
  if (!interaction) return readError ? <Alert variant='destructive'>{readError}</Alert> : null
  const form = interaction as Form
  return <section className='flex flex-col gap-3 rounded-lg border border-hairline p-3' aria-label={form.title}>
    <h3 className='text-sm font-medium'>{t(form.title)}</h3>
    {form.message ? <p className='whitespace-pre-wrap text-xs text-muted-foreground'>{t(form.message)}</p> : null}
    {form.fields.map(field => <div key={field.key} className='flex flex-col gap-2'>
      <Label className='text-xs'>{t(field.label)}
        {field.type === 'select' ? <SearchableSelect value={values[field.key] || ''} disabled={busy}
          options={field.options} onValueChange={value => setValues(previous => ({ ...previous, [field.key]: value }))} />
          : <Input type={field.secret ? 'password' : 'text'} autoComplete='off' spellCheck={false} maxLength={8192}
            disabled={busy} value={values[field.key] || ''} onChange={event => { const value = event.currentTarget.value; setValues(previous => ({ ...previous, [field.key]: value })) }} />}
      </Label>
    </div>)}
    {form.captcha ? <Captcha key={signature.current} config={form.captcha} onChange={setCaptcha} disabled={busy} t={t} /> : null}
    {error || readError ? <Alert variant='destructive'>{error || readError}</Alert> : null}
    {form.fields.length || form.captcha ? <Button disabled={busy || Boolean(form.captcha && !captcha)} onClick={() => void submit(form)}>
      {busy ? <Spinner /> : null}{t('提交登录步骤')}
    </Button> : null}
  </section>
}
