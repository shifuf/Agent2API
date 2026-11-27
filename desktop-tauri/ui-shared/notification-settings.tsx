import { useState } from 'react'

type Channel = 'webhook' | 'telegram' | 'bark'
type Fields = Record<string, boolean>
export type NotificationSettings = { enabled: boolean; events: Fields; channels: Record<Channel, Fields> }
export type NotificationApi = {
  load: () => Promise<NotificationSettings>
  save: (patch: unknown) => Promise<NotificationSettings>
  test: (payload: unknown) => Promise<unknown>
}
const channels: Channel[] = ['webhook', 'telegram', 'bark']
const fields = { webhook: ['url', 'headers'], telegram: ['botToken', 'chatId', 'apiBase', 'proxyUrl'], bark: ['deviceKey', 'serverUrl', 'group', 'sound'] }
const fieldNames: Record<string, string> = { url: 'Webhook URL', headers: 'HTTP Headers (JSON)', botToken: 'Bot Token', chatId: 'Chat ID', apiBase: 'API URL', proxyUrl: 'Proxy URL', deviceKey: 'Device Key', serverUrl: 'Bark URL', group: 'Group', sound: 'Sound' }
const eventNames: Record<string, string> = { loginSuccess: '登录成功', loginFailure: '登录失败', checkinFailure: '自动签到失败' }

export function NotificationPanel({ api, t }: { api: NotificationApi; t: (key: string) => string }) {
  const [opened, open] = useState(false)
  const [saved, setSaved] = useState<NotificationSettings | null>(null)
  const [draft, setDraft] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  async function perform(fn: () => Promise<void>) {
    setBusy(true); setMessage(''); setError(false)
    try { await fn() } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : t('操作失败')) }
    finally { setBusy(false) }
  }
  function payload() {
    if (!saved) return {}
    const result: Record<string, Record<string, unknown>> = {}
    for (const channel of channels) {
      const values: Record<string, unknown> = { enabled: saved.channels[channel].enabled }
      for (const field of fields[channel]) {
        const value = draft[`${channel}.${field}`]
        if (value === null) values[field] = null
        else if (value) {
          if (field !== 'headers') values[field] = value
          else {
            try { values.headers = JSON.parse(value) } catch { throw new Error(t('请求头需要 JSON 对象')) }
          }
        }
      }
      result[channel] = values
    }
    return { enabled: saved.enabled, events: saved.events, channels: result }
  }
  const load = () => perform(async () => { setSaved(await api.load()); setDraft({}) })
  return <section className='panel' data-notification-settings>
    <button type='button' aria-expanded={opened} disabled={busy} onClick={() => {
      if (!opened) { open(true); void load() } else { open(false); setDraft({}); setSaved(null); setMessage('') }
    }}>{t('系统通知')}</button>
    {opened && <fieldset disabled={busy}>
      {saved ? <>
        <label><input type='checkbox' checked={saved.enabled} onChange={event => setSaved({ ...saved, enabled: event.target.checked })} />{t('启用系统通知')}</label>
        {Object.entries(eventNames).map(([key, label]) => <label key={key}><input type='checkbox' checked={!!saved.events[key]}
          onChange={event => setSaved({ ...saved, events: { ...saved.events, [key]: event.target.checked } })} />{t(label)}</label>)}
        {channels.map(channel => <fieldset key={channel}><legend>{({ webhook: 'Webhook', telegram: 'Telegram', bark: 'Bark' })[channel]}</legend>
          <label><input type='checkbox' checked={saved.channels[channel].enabled} onChange={event => setSaved({ ...saved,
            channels: { ...saved.channels, [channel]: { ...saved.channels[channel], enabled: event.target.checked } } })} />{t('启用')}</label>
          {fields[channel].map(field => { const key = `${channel}.${field}`; const isSet = saved.channels[channel][`${field}Set`]; return <div key={field}>
            <label>{fieldNames[field]} <input type='password' autoComplete='new-password' placeholder={isSet ? t('已配置') : ''}
              value={draft[key] ?? ''} onChange={event => setDraft(prev => ({ ...prev, [key]: event.target.value }))} /></label>
            {isSet && <button type='button' aria-pressed={draft[key] === null} onClick={() => setDraft(prev => ({ ...prev, [key]: prev[key] === null ? '' : null }))}>{draft[key] === null ? t('撤销清除') : t('清除')}</button>}
          </div> })}
          <button type='button' onClick={() => void perform(async () => { await api.test({ channel, draft: payload() }); setMessage(t('测试通知已发送')) })}>{t('测试发送')}</button>
        </fieldset>)}
        <button type='button' onClick={() => void perform(async () => { setSaved(await api.save(payload())); setDraft({}); setMessage(t('已保存')) })}>{t('保存')}</button>
      </> : <button type='button' onClick={() => void load()}>{t('重新加载')}</button>}
      <output role={error ? 'alert' : 'status'} aria-live='polite'>{message}</output>
    </fieldset>}
  </section>
}
