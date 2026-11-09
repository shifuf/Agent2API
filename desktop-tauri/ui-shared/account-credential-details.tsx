import * as React from 'react'
import { Button, Textarea } from '@ui'

type Details = { id: string; noAuth: boolean; desktop: boolean; fields: { key: string; value: string }[] }
const labels: Record<string, string> = {
  apiKey: 'API Key', api_key: 'API Key', accessToken: 'Access Token', access_token: 'Access Token',
  refreshToken: 'Refresh Token', refresh_token: 'Refresh Token', jwt: 'JWT',
}

/** Secret state belongs only to this mounted view, never the account store or edit draft. */
export function AccountCredentialDetails({ id, read, t }: {
  id: string
  read: (id: string) => Promise<unknown>
  t: (text: string) => string
}) {
  const [details, setDetails] = React.useState<Details | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [copied, setCopied] = React.useState('')
  const generation = React.useRef(0)
  React.useEffect(() => {
    generation.current++
    setDetails(null); setBusy(false); setError(''); setCopied('')
    return () => { generation.current++ }
  }, [id])
  function hide() {
    generation.current++
    setDetails(null); setBusy(false); setError(''); setCopied('')
  }
  async function reveal() {
    const current = ++generation.current
    setBusy(true); setError(''); setCopied('')
    try {
      const value = await read(id) as Details
      if (current !== generation.current) return
      if (value?.id !== id || !Array.isArray(value.fields)
        || value.fields.some(field => typeof field?.key !== 'string' || typeof field?.value !== 'string')) throw new Error('Invalid credential response')
      setDetails(value)
    } catch {
      if (current === generation.current) setError(t('读取密钥详情失败，请重试'))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  async function copy(value: string, key: string) {
    const current = generation.current
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value)
      else {
        // HTTP deployments may lack Clipboard API. Use the existing visible field.
        const input = inputs.current.get(key)
        if (!input) throw new Error('No field')
        input.focus(); input.select()
        if (!document.execCommand('copy')) throw new Error('Copy failed')
      }
      if (current === generation.current) { setCopied(key); setError('') }
    } catch {
      if (current === generation.current) setError(t('复制失败，请手动选择后复制'))
    }
  }
  const inputs = React.useRef(new Map<string, HTMLTextAreaElement>())
  return <section className='rounded-xl border p-4 space-y-3' data-account-credentials=''>
    <div className='flex items-center justify-between gap-3'>
      <strong>{t('已保存的密钥')}</strong>
      <Button type='button' variant='outline' size='sm' onClick={details || busy ? hide : () => void reveal()}>
        {details || busy ? t('隐藏密钥详情') : t('查看密钥详情')}
      </Button>
    </div>
    <p className='text-xs text-muted-foreground'>{t('点击后读取当前已保存的凭证；隐藏或关闭窗口后清除。')}</p>
    {busy ? <p role='status' className='text-sm'>{t('正在读取密钥详情…')}</p> : null}
    {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
    {details?.fields.map(field => {
      const queryKey = field.key.startsWith('balanceQuery.') ? field.key.slice('balanceQuery.'.length) : ''
      const label = field.key === 'pluginSecret' ? t('提供商凭证（JSON）') : queryKey
        ? `${t('查询凭证')} · ${labels[queryKey] || queryKey}` : labels[field.key] || field.key
      return <div key={field.key} className='space-y-2'>
        <div className='flex items-center justify-between gap-2'>
          <span className='text-sm font-medium'>{label}</span>
          <Button type='button' variant='ghost' size='sm' aria-label={`${t('复制')} ${label}`} onClick={() => void copy(field.value, field.key)}>
            {copied === field.key ? t('已复制') : t('复制')}
          </Button>
        </div>
        <Textarea ref={node => { if (node) inputs.current.set(field.key, node); else inputs.current.delete(field.key) }}
          aria-label={label} data-credential-value={field.key} readOnly value={field.value} rows={field.value.includes('\n') ? 5 : 2}
          autoComplete='off' spellCheck={false} className='font-mono text-xs break-all resize-y' />
      </div>
    })}
    {details && details.fields.length === 0 ? <p className='text-sm text-muted-foreground'>{details.noAuth
      ? t('此账号无需鉴权，没有已保存的密钥。') : details.desktop
        ? t('此账号使用客户端实时登录态，没有已保存的密钥。') : t('此账号没有可查看的已保存凭证。')}</p> : null}
  </section>
}
