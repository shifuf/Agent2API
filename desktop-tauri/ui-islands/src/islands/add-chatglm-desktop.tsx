import * as React from 'react'
import { Alert, AlertDescription, Button, Spinner } from '@ui'
import { managedLoginSourceGeneration } from '../../../ui-shared/plugin-managed-state'
import { readDesktopImport, type DesktopImport } from '../../../ui-shared/plugin-desktop-import'
import { accountRequest, type LoginResult } from './add-account-bridge'
import { t } from '../i18n'

const endpoint = '/api/plugins/desktop-import/chatglm'
const processing = (info: DesktopImport | null) => Boolean(info && ['reading', 'normalizing', 'saving'].includes(info.phase))

export function ChatglmDesktopImport({ active, locked, onBusy, onSaved }: {
  active: boolean; locked: boolean; onBusy(value: boolean): void; onSaved(result: LoginResult): Promise<void>
}) {
  const [info, setInfo] = React.useState<DesktopImport | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const alive = React.useRef(false)
  const generation = React.useRef(0)
  const owner = React.useRef<{ intent: string; source: number; pack: string } | null>(null)
  const requestActive = React.useRef(false)
  const saved = React.useRef(false)
  const latest = React.useRef({ active, onBusy, onSaved })
  latest.current = { active, onBusy, onSaved }

  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false; generation.current++
      latest.current.onBusy(false)
      const current = owner.current
      if (current && !saved.current && current.source === managedLoginSourceGeneration()) {
        void accountRequest('POST', endpoint, { action: 'cancel', intent: current.intent }).catch(() => {})
      }
    }
  }, [])
  React.useEffect(() => { onBusy(busy || processing(info)); }, [busy, info?.phase, onBusy])

  async function request(action: 'prepare' | 'confirm' | 'cancel' | 'status') {
    if (requestActive.current || !alive.current || !latest.current.active) return
    const source = owner.current?.source ?? managedLoginSourceGeneration()
    if (source !== managedLoginSourceGeneration()) { setError(t('管理会话已变化，请重新发起登录。')); return }
    const intent = action === 'prepare' ? undefined : owner.current?.intent
    if (action !== 'prepare' && !intent) return
    requestActive.current = true; setBusy(true); setError('')
    const current = generation.current
    try {
      const value = action === 'status' ? await accountRequest('GET', `${endpoint}?intent=${encodeURIComponent(intent!)}`)
        : await accountRequest('POST', endpoint, { action, ...(intent ? { intent } : {}), ...(action === 'confirm' ? { confirmed: true } : {}) })
      if (!alive.current || !latest.current.active || current !== generation.current || source !== managedLoginSourceGeneration()) return
      const next = readDesktopImport(value, intent)
      if (owner.current && JSON.stringify(next.package) !== owner.current.pack) throw new Error(t('本次导入的插件来源已变化，请重新发起。'))
      owner.current = { intent: next.intent, source, pack: JSON.stringify(next.package) }
      setInfo(next)
      if (next.phase === 'saved' && next.saved === true && next.account && !saved.current) {
        saved.current = true
        await latest.current.onSaved({ ok: true, canceled: false, account: next.account })
      }
    } catch (cause) {
      if (alive.current && current === generation.current) setError(
        cause instanceof Error && cause.message !== 'invalid_desktop_import_receipt'
          ? t(cause.message) : t('本机导入未确认完成，请查询本次状态。'))
    } finally {
      requestActive.current = false
      if (alive.current && current === generation.current) setBusy(false)
    }
  }

  React.useEffect(() => {
    if (!active || !processing(info)) return
    const timer = window.setInterval(() => { void request('status') }, 1000)
    return () => window.clearInterval(timer)
  }, [active, info?.intent, info?.phase])

  return <section className='flex flex-col gap-3 rounded-lg border border-hairline p-3'>
    <h3 className='text-sm font-medium'>{t('本机智谱清言客户端导入')}</h3>
    {!info ? <Button variant='outline' disabled={locked || busy} onClick={() => void request('prepare')}>
      {busy ? <Spinner /> : null}{t('查看本次读取范围')}
    </Button> : <>
      <p className='text-xs text-muted-foreground'>{t('插件：{name} · {version}', { name: info.package.id, version: info.package.version })}</p>
      <p className='text-xs'>{t('仅只读当前 Windows 用户的智谱清言客户端登录态，凭据不会返回界面。')}</p>
      <ul className='list-disc pl-5 text-xs'>{info.scope.files.map(file => <li key={file}>{file}</li>)}</ul>
      <p className='text-xs'>{t(info.message)}</p>
      {info.phase === 'awaiting_confirmation' ? <Button disabled={busy || locked || info.remainingMs <= 0}
        onClick={() => void request('confirm')}>{t('确认本次读取并添加账号')}</Button> : null}
      {processing(info) ? <p role='status' className='text-xs'><Spinner /> {t('正在处理本次导入，保存结果尚未确认')}</p> : null}
      {info.phase !== 'saved' ? <div className='flex gap-2'>
        <Button variant='outline' disabled={busy} onClick={() => void request('status')}>{t('查询本次状态')}</Button>
        <Button variant='outline' disabled={busy} onClick={() => void request('cancel')}>{t('取消本次导入')}</Button>
      </div> : null}
    </>}
    {error ? <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert> : null}
  </section>
}
