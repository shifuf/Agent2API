import * as React from 'react'

export type TurnstileSettings = { provider: 'altcha' | 'turnstile'; siteKey: string; widgetOrigin: string; hostnames: string[]; hasSecret: boolean }
export type TurnstilePatch = Omit<TurnstileSettings, 'hasSecret'> & { secret?: string }
export type TurnstileApi = { load(): Promise<TurnstileSettings>; save(value: TurnstilePatch): Promise<TurnstileSettings> }

export function TurnstileEditor({ api, identity, t }: { api: TurnstileApi; identity(): string; t(key: string): string }) {
  const scope = identity()
  const [saved,setSaved] = React.useState<TurnstileSettings | null>(null)
  const [provider,setProvider] = React.useState<TurnstileSettings['provider']>('altcha')
  const [site,setSite] = React.useState(''), [secret,setSecret] = React.useState(''), [widgetOrigin,setOrigin] = React.useState('')
  const [busy,setBusy] = React.useState(false), [message,setMessage] = React.useState('')
  function apply(settings:TurnstileSettings) { setSaved(settings); setProvider(settings.provider); setSite(settings.siteKey); setOrigin(settings.widgetOrigin); setSecret('') }
  React.useEffect(() => {
    let live = true
    void Promise.resolve().then(() => api.load()).then(value => { if (live && identity() === scope && value && Array.isArray(value.hostnames)) apply(value) }).catch(() => {})
    return () => {live = false}
  },[api,identity,scope])
  if (!saved) return null
  async function save() {
    if (busy || identity() !== scope) return
    setBusy(true); setMessage('')
    try {
      const origin = widgetOrigin.trim().replace(/\/$/,'').toLowerCase()
      const host = origin ? new URL(origin).hostname : ''
      if (provider === 'turnstile' && host === location.hostname) throw new Error('A separate widget host is required')
      const value = await api.save({provider,siteKey:site.trim(),widgetOrigin:origin,hostnames:host ? [host] : [], ...(secret ? {secret} : {})})
      if (identity() === scope) { apply(value); setMessage(t('已保存')) }
    } catch { if (identity() === scope) setMessage(t('登录验证设置未保存，请检查输入后重试')) }
    finally { if (identity() === scope) setBusy(false) }
  }
  return <section className='settings-panel' data-turnstile-editor=''>
    <h3>{t('登录验证方式')}</h3>
    <label>{t('登录验证方式')} <select value={provider} onChange={event => setProvider(event.currentTarget.value as TurnstileSettings['provider'])}><option value='altcha'>ALTCHA</option><option value='turnstile'>Cloudflare Turnstile</option></select></label>
    {provider === 'turnstile' && <><p>{t('仅在能访问 Cloudflare 的域名上启用。验证失败时不会回退；请保留当前会话，在另一个窗口测试登录。')}</p>
      <label>Site key <input value={site} maxLength={256} autoComplete='off' onChange={event => setSite(event.currentTarget.value)} /></label>
      <label>Secret key <input type='password' value={secret} maxLength={256} autoComplete='new-password' onChange={event => setSecret(event.currentTarget.value)} /></label>
      {saved.hasSecret && <small>{t('密钥已保存；留空保持不变')}</small>}
      <label>{t('验证专用 HTTPS 站点（与面板分开，部署方法见安装文档）')}<input type='url' value={widgetOrigin} autoComplete='off' spellCheck={false} onChange={event => setOrigin(event.currentTarget.value)} /></label></>}
    <button className='btn' type='button' disabled={busy || (provider === 'turnstile' && (!site.trim() || !widgetOrigin.trim() || (!secret && !saved.hasSecret)))} onClick={() => void save()}>{t('保存')}</button>
    {message && <p role='status'>{message}</p>}
  </section>
}
