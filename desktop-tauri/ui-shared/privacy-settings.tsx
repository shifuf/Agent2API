import * as React from 'react'

export type PrivacySettings = { enabled: boolean; wordCount: number }
export type PrivacyPatch = { enabled: boolean; words?: string[] }
export type PrivacyApi = { load(): Promise<PrivacySettings>; save(patch: PrivacyPatch): Promise<PrivacySettings>; preview(text: string): Promise<{ text: string }> }

export function PrivacyEditor({ api, identity, t }: { api: PrivacyApi; identity(): string; t(key: string): string }) {
  const scope = identity()
  const [saved, setSaved] = React.useState<PrivacySettings | null>(null)
  const [enabled, setEnabled] = React.useState(false)
  const [replace, setReplace] = React.useState(false)
  const [words, setWords] = React.useState('')
  const [sample, setSample] = React.useState('')
  const [result, setResult] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    let live = true
    void Promise.resolve().then(() => api.load()).then(value => { if (live && scope === identity() && typeof value?.enabled === 'boolean' && Number.isInteger(value.wordCount)) { setSaved(value); setEnabled(value.enabled) } }).catch(() => {})
    return () => { live = false }
  }, [api, scope, identity])
  if (!saved) return null
  async function submit(test: boolean) {
    if (busy || identity() !== scope) return
    setBusy(true); setStatus('')
    try {
      if (test) {
        const value = await api.preview(sample)
        if (identity() === scope) setResult(value.text)
      } else {
        const patch: PrivacyPatch = { enabled }
        if (replace) patch.words = words.split(/\r?\n/).filter(word => word.trim() !== '')
        const value = await api.save(patch)
        if (identity() === scope) { setSaved(value); setEnabled(value.enabled); setReplace(false); setWords(''); setResult(''); setSample(''); setStatus(t('已保存')) }
      }
    } catch { if (identity() === scope) setStatus(t('隐私设置操作失败，请检查输入后重试')) }
    finally { if (identity() === scope) setBusy(false) }
  }
  return <section className='settings-panel' data-privacy-editor=''>
    <h3>{t('请求隐私保护')}</h3>
    <p>{t('发送前替换文本中的密钥、邮箱、手机号、身份证和保密词；仅向本次请求还原。开启后拒绝不透明附件，不保留上游原始回复。')}</p>
    <p>{t('无法由网关检查最终报文的会话式提供商将被拒绝，不会自动切换账号。')}</p>
    <label><input type='checkbox' checked={enabled} onChange={event => setEnabled(event.currentTarget.checked)} /> {t('启用隐私保护')}</label>
    <p>{t('已保存的保密词数量')}：{saved.wordCount}</p>
    <label><input type='checkbox' checked={replace} onChange={event => setReplace(event.currentTarget.checked)} /> {t('替换保密词（每行一个，留空清除）')}</label>
    {replace && <textarea aria-label={t('保密词')} autoComplete='off' spellCheck={false} value={words} onChange={event => setWords(event.currentTarget.value)} />}
    <div><button type='button' className='btn' disabled={busy || (!replace && enabled === saved.enabled)} onClick={() => void submit(false)}>{t('保存')}</button></div>
    <label>{t('按已保存规则预览')}<textarea autoComplete='off' spellCheck={false} value={sample} onChange={event => { setSample(event.currentTarget.value); setResult('') }} /></label>
    <button type='button' className='btn' disabled={busy || !sample} onClick={() => void submit(true)}>{t('预览')}</button>
    {result && <pre>{result}</pre>}{status && <p role='status'>{status}</p>}
  </section>
}
