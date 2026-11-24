import { useEffect, useRef, useState } from 'react'
import {
  Badge, Button, Checkbox, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input,
} from '@ui'
import { accountBindingIds, bindingAccountGroups, bindingTargetError, MAX_BINDING_ACCOUNTS, MAX_BINDING_PROXIES, type BindingPoolItem, type ProxyBindingPayload } from './proxy-bindings'
import type { GroupRequest } from './proxy-groups'
import type { ProxyUsage } from './proxy-usage'

type Translate = (key: string, values?: Record<string, string | number>) => string
const message = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const value = error as { message?: string; error?: unknown }
    if (value.message) return value.message
    if (value.error) return message(value.error)
  }
  return String(error)
}

/** Displays the actual account/channel names, including paused account bindings. */
export function ProxyAccountLabels({ item, t }: { item: ProxyUsage; t: Translate }) {
  if (!item.usedBy?.length) return <span className='text-xs text-subtle'>{t('未绑定账号')}</span>
  return <div className='max-h-32 space-y-1 overflow-y-auto text-xs' aria-label={t('渠道 / 账号')}>
    {item.usedBy.map(account => <div key={account.id} className='flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5'>
      <span className='font-medium text-text-2'>{account.providerLabel || account.provider}</span>
      <span className='break-words text-subtle'>{account.name || account.id}</span>
      {account.enabled === false ? <Badge variant='secondary'>{t('已禁用')}</Badge> : null}
    </div>)}
  </div>
}

export function ProxyBindingsDialog<Item extends BindingPoolItem>({ request, t, initialProxyIds = [], initialAccountIds = [], onClose, onSaved }: {
  request: GroupRequest; t: Translate; initialProxyIds?: string[]; initialAccountIds?: string[]
  onClose: () => void; onSaved: (payload: ProxyBindingPayload<Item>) => void
}) {
  const [data, setData] = useState<ProxyBindingPayload<Item> | null>(null)
  const [accounts, setAccounts] = useState<Set<string>>(new Set())
  const [proxies, setProxies] = useState<Set<string>>(new Set())
  const [accountQuery, setAccountQuery] = useState('')
  const [proxyQuery, setProxyQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const operation = useRef(false)
  const initial = useRef({ proxyIds: initialProxyIds, accountIds: initialAccountIds })
  useEffect(() => {
    alive.current = true
    void request('GET', '/api/proxies/bindings').then(result => {
      if (!alive.current) return
      const payload = result as ProxyBindingPayload<Item>
      if (!Array.isArray(payload.accounts) || !Array.isArray(payload.items)) throw new Error(t('代理绑定响应异常'))
      setData(payload)
      setAccounts(new Set(initial.current.accountIds.filter(id => payload.accounts.some(account => account.id === id)).slice(0, MAX_BINDING_ACCOUNTS)))
      setProxies(new Set(initial.current.proxyIds.filter(id => payload.items.some(item => item.id === id && !bindingTargetError(item))).slice(0, MAX_BINDING_PROXIES)))
    }).catch(failure => { if (alive.current) setError(message(failure)) })
    return () => { alive.current = false }
  }, [request, t])

  const groups = bindingAccountGroups(data?.accounts || [], accountQuery)
  const query = proxyQuery.trim().toLowerCase()
  const items = (data?.items || []).filter(item => !query || [item.name, item.id, item.providerId, item.node].join(' ').toLowerCase().includes(query))
  function pickAccounts(ids: string[], checked: boolean) {
    const next = new Set(accounts)
    for (const id of ids) { if (checked) next.add(id); else next.delete(id) }
    if (next.size > MAX_BINDING_ACCOUNTS) { setError(t('每次最多选择 {n} 个账号', { n: MAX_BINDING_ACCOUNTS })); return }
    setError(''); setAccounts(next)
  }
  function pickProxy(id: string, checked: boolean) {
    const next = new Set(proxies)
    if (checked) next.add(id); else next.delete(id)
    if (next.size > MAX_BINDING_PROXIES) { setError(t('每次最多选择 {n} 个出口', { n: MAX_BINDING_PROXIES })); return }
    setError(''); setProxies(next)
  }
  async function save(unbind = false) {
    if (operation.current || !accounts.size || (!unbind && !proxies.size)) return
    operation.current = true; setBusy(true); setError('')
    try {
      const result = await request('POST', '/api/proxies/bindings', { accountIds: [...accounts], proxyIds: unbind ? [] : [...proxies] }) as ProxyBindingPayload<Item>
      if (!alive.current) return
      if (!Array.isArray(result.accounts) || !Array.isArray(result.items)) throw new Error(t('代理绑定响应异常'))
      onSaved(result); onClose()
    } catch (failure) { if (alive.current) setError(message(failure)) }
    finally { operation.current = false; if (alive.current) setBusy(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className='max-w-[860px]'>
      <DialogHeader><DialogTitle>{t('管理代理绑定')}</DialogTitle></DialogHeader>
      <DialogBody className='max-h-[70dvh] space-y-3 overflow-y-auto'>
        <p className='text-sm text-subtle'>{t('选择账号和出口；选择多个出口时，账号的新请求依次轮询。')}</p>
        {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
        {!data && !error ? <p role='status'>{t('加载中…')}</p> : null}
        {data ? <div className='grid gap-4 sm:grid-cols-2'>
          <section className='min-w-0 space-y-2' aria-label={t('所选账号')}>
            <div className='flex items-center justify-between gap-2'><strong className='text-sm'>{t('账号')} · {accounts.size}</strong>
              <Button size='sm' variant='ghost' disabled={busy || !accounts.size} onClick={() => setAccounts(new Set())}>{t('清空')}</Button></div>
            <Input type='search' value={accountQuery} disabled={busy} aria-label={t('搜索渠道 / 账号')} placeholder={t('搜索渠道 / 账号')} onChange={event => setAccountQuery(event.currentTarget.value)} />
            <div className='max-h-80 space-y-3 overflow-y-auto rounded-lg border border-border p-3'>
              {!groups.length ? <p className='text-xs text-subtle'>{t('没有匹配的账号')}</p> : null}
              {groups.map(group => <div key={group.provider} className='space-y-2'>
                <label className='flex items-center gap-2 text-xs font-semibold'>
                  <Checkbox disabled={busy} checked={group.accounts.every(account => accounts.has(account.id))}
                    indeterminate={group.accounts.some(account => accounts.has(account.id)) && !group.accounts.every(account => accounts.has(account.id))}
                    onCheckedChange={checked => pickAccounts(group.accounts.map(account => account.id), checked)} />
                  {group.label} · {group.accounts.length}
                </label>
                {group.accounts.map(account => <label key={account.id} className='flex items-start gap-2 text-xs'>
                  <Checkbox disabled={busy} checked={accounts.has(account.id)} onCheckedChange={checked => pickAccounts([account.id], checked)} />
                  <span className='min-w-0 space-y-0.5'><span className='block break-words'>{account.name || account.id}{!account.enabled ? ` · ${t('已禁用')}` : ''}</span>
                    <span className='block text-[11px] text-subtle'>{accountBindingIds(account, data.items).map(id => data.items.find(item => item.id === id)?.name || id).join('、') || account.proxy?.label || t('直连')}</span>
                  </span>
                </label>)}
              </div>)}
            </div>
          </section>
          <section className='min-w-0 space-y-2' aria-label={t('所选出口')}>
            <div className='flex items-center justify-between gap-2'><strong className='text-sm'>{t('出口')} · {proxies.size}</strong>
              <Button size='sm' variant='ghost' disabled={busy || !proxies.size} onClick={() => setProxies(new Set())}>{t('清空')}</Button></div>
            <Input type='search' value={proxyQuery} disabled={busy} aria-label={t('搜索出口')} placeholder={t('搜索出口')} onChange={event => setProxyQuery(event.currentTarget.value)} />
            <div className='max-h-80 space-y-2 overflow-y-auto rounded-lg border border-border p-3'>
              {items.map(item => {
                const unavailable = bindingTargetError(item)
                return <label key={item.id} className='flex items-start gap-2 text-xs'>
                  <Checkbox disabled={busy || !!unavailable} checked={proxies.has(item.id)} onCheckedChange={checked => pickProxy(item.id, checked)} />
                  <span className='min-w-0 break-words'><span className='block'>{item.name}</span>
                    {unavailable ? <span className='text-destructive'>{t(unavailable)}</span> : null}</span>
                </label>
              })}
              {!items.length ? <p className='text-xs text-subtle'>{t('没有匹配的出口')}</p> : null}
            </div>
            <p className='text-xs text-subtle'>{proxies.size > 1 ? t('轮询所选出口') : t('使用所选出口')}</p>
          </section>
        </div> : null}
      </DialogBody>
      <DialogFooter className='flex-wrap'>
        <Button variant='destructive' disabled={busy || !accounts.size} onClick={() => void save(true)}>{t('解除所选账号绑定')}</Button>
        <Button variant='outline' disabled={busy} onClick={onClose}>{t('取消')}</Button>
        <Button disabled={busy || !accounts.size || !proxies.size} onClick={() => void save()}>{busy ? t('保存中…') : t('保存绑定')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
