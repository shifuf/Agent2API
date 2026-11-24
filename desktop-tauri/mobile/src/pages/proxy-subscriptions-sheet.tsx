import { useEffect, useRef, useState } from 'react'
import { Button, Card, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label, SegmentedControl, Switch } from '@ui'
import { apiCall } from '../api/client'
import { t } from '../i18n'
import { serverIdentity } from '../lib/servers'

export type ProxySubscription = { id: string; name: string; enabled: boolean; kind?: string; url?: string; fileName?: string; nodeCount?: number }
type Payload = { items: ProxySubscription[] }
export const fetchProxySubscriptions = () => apiCall<Payload>('/api/subscriptions')
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function ProxySubscriptionsSheet({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<Payload | null>(null)
  const [editor, setEditor] = useState<{ item: ProxySubscription | null } | null>(null)
  const [deleting, setDeleting] = useState<ProxySubscription | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const identity = serverIdentity()
  const alive = useRef(true)
  const locked = useRef(false)
  useEffect(() => {
    alive.current = true
    void fetchProxySubscriptions().then(result => { if (alive.current && serverIdentity() === identity) setData(result) }).catch(failure => { if (alive.current) setError(message(failure)) })
    return () => { alive.current = false }
  }, [identity])
  async function action(path: string, body: Record<string, unknown>) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try {
      const result = await apiCall<Payload>(path, { method: 'POST', body })
      if (!alive.current || serverIdentity() !== identity) return
      setData(result); setDeleting(null)
      await onChanged()
    } catch (failure) { if (alive.current && serverIdentity() === identity) setError(message(failure)) }
    finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  return <>
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className='max-w-[640px]'>
      <DialogHeader><DialogTitle>{t('订阅管理')}</DialogTitle></DialogHeader>
      <DialogBody className='max-h-[70dvh] space-y-3 overflow-y-auto'>
        {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
        {!data ? <p>{t('加载中…')}</p> : null}
        {data?.items.map(item => <Card key={item.id} className='space-y-2 p-3'>
          <div className='flex items-center gap-2'><strong className='min-w-0 flex-1 break-words text-sm'>{item.name}</strong>
            <Switch checked={item.enabled} disabled={busy} aria-label={t('启用订阅「{name}」', { name: item.name })}
              onCheckedChange={enabled => void action('/api/subscriptions/save', { ...item, enabled })} /></div>
          <p className='break-all text-xs text-subtle'>{item.kind === 'local' ? item.fileName : item.url} · {item.nodeCount || 0}</p>
          <div className='flex flex-wrap justify-end gap-2'>
            <Button size='sm' variant='outline' disabled={busy} onClick={() => void action('/api/subscriptions/refresh', { id: item.id })}>{t('刷新')}</Button>
            <Button size='sm' variant='outline' disabled={busy} onClick={() => setEditor({ item })}>{t('编辑')}</Button>
            <Button size='sm' variant='ghost' disabled={busy} className='text-destructive' onClick={() => setDeleting(item)}>{t('删除')}</Button>
          </div>
        </Card>)}
        {data && !data.items.length ? <p className='text-sm text-subtle'>{t('还没有订阅')}</p> : null}
      </DialogBody><DialogFooter><Button variant='outline' disabled={busy} onClick={onClose}>{t('关闭')}</Button>
        <Button disabled={busy} onClick={() => setEditor({ item: null })}>{t('新增订阅')}</Button></DialogFooter>
    </DialogContent></Dialog>
    {editor ? <SubscriptionEditor item={editor.item} onClose={() => setEditor(null)} onSaved={async () => {
      if (serverIdentity() !== identity) return
      setEditor(null); setData(await fetchProxySubscriptions()); await onChanged()
    }} /> : null}
    <Dialog open={!!deleting} onOpenChange={open => { if (!open && !busy) setDeleting(null) }}><DialogContent className='max-w-[440px]'>
      <DialogHeader><DialogTitle>{t('删除订阅')}</DialogTitle></DialogHeader>
      <DialogBody><p>{t('确定删除「{name}」？', { name: deleting?.name || '' })}</p></DialogBody>
      <DialogFooter><Button variant='outline' disabled={busy} onClick={() => setDeleting(null)}>{t('取消')}</Button>
        <Button variant='destructive' disabled={busy} onClick={() => deleting && void action('/api/subscriptions/remove', { id: deleting.id })}>{t('删除')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>
}

function SubscriptionEditor({ item, onClose, onSaved }: { item: ProxySubscription | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(item?.name || '')
  const [kind, setKind] = useState(item?.kind || 'url')
  const [url, setUrl] = useState(item?.url || '')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const identity = serverIdentity()
  const alive = useRef(true)
  const locked = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function save() {
    if (locked.current) return
    if (!name.trim()) { setError(t('请填写订阅名称')); return }
    if (kind === 'url' && !/^https?:\/\//i.test(url.trim())) { setError(t('请填写有效的 HTTP / HTTPS 订阅链接')); return }
    if (kind === 'local' && !item && !file) { setError(t('请选择要导入的 YAML 文件')); return }
    locked.current = true; setBusy(true); setError('')
    try {
      const body: Record<string, unknown> = { name: name.trim(), kind, enabled: item?.enabled ?? true, ...(item ? { id: item.id } : {}) }
      if (kind === 'url') body.url = url.trim()
      if (kind === 'local' && file) {
        if (file.size > 2_000_000) throw new Error(t('订阅文件不能超过 2 MB'))
        body.fileName = file.name
        body.contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
          reader.onerror = () => reject(reader.error || new Error(t('文件读取失败')))
          reader.readAsDataURL(file)
        })
      }
      if (serverIdentity() !== identity || !alive.current) return
      await apiCall(item ? '/api/subscriptions/save' : '/api/subscriptions/add', { method: 'POST', body })
      if (serverIdentity() === identity && alive.current) await onSaved()
    } catch (failure) { if (alive.current && serverIdentity() === identity) setError(message(failure)) }
    finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className='max-w-[480px]'>
    <DialogHeader><DialogTitle>{item ? t('编辑订阅') : t('新增订阅')}</DialogTitle></DialogHeader>
    <DialogBody className='space-y-3'>
      <Label>{t('名称')}<Input value={name} maxLength={60} disabled={busy} onChange={event => setName(event.currentTarget.value)} /></Label>
      <SegmentedControl disabled={busy || !!item} aria-label={t('订阅来源')} value={kind} onValueChange={setKind} options={[{ value: 'url', label: t('订阅链接') }, { value: 'local', label: t('本地 YAML 文件') }]} />
      {kind === 'url' ? <Label>{t('订阅链接')}<Input value={url} disabled={busy} onChange={event => setUrl(event.currentTarget.value)} placeholder='https://' /></Label>
        : <Label>{t('本地 YAML 文件')}<Input type='file' accept='.yaml,.yml,.json' disabled={busy} onChange={event => setFile(event.currentTarget.files?.[0] || null)} /></Label>}
      {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
    </DialogBody><DialogFooter><Button variant='outline' disabled={busy} onClick={onClose}>{t('取消')}</Button>
      <Button disabled={busy} onClick={() => void save()}>{busy ? t('保存中…') : t('保存')}</Button></DialogFooter>
  </DialogContent></Dialog>
}
