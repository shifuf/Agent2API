import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, Input } from '@ui'

type Member = { name: string; type?: string; server?: string; dialer?: string; front?: string; isGroup: boolean; delay?: number }
type Group = { providerId: string; subscription: string; name: string; type: string; count: number; selected?: string; available: boolean; selectable: boolean; selectionRemoved: boolean; error?: string; members?: Member[] }
type Result = { success: boolean; delay?: number; bytesPerSecond?: number; ip?: string; error?: string; at: number; stale?: boolean }
type Payload = { groups: Group[]; revision?: string }
export type GroupRequest = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<unknown>
type Translate = (text: string) => string
const keyOf = (g: Group) => JSON.stringify([g.providerId, g.name])
const message = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    const value = e as { message?: string; error?: unknown }
    if (value.message) return value.message
    if (value.error) return message(value.error)
  }
  return String(e)
}
const visible = () => !document.hidden

export function ProxyGroups({ request, t, active = visible }: { request: GroupRequest; t: Translate; active?: () => boolean }) {
  const [groups, setGroups] = useState<Group[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [revision, setRevision] = useState(0)
  const alive = useRef(true)
  const operation = useRef(false)
  const task = useRef('')
  const stopped = useRef(false)
  const chainRevision = useRef('')
  const load = useCallback(async () => {
    try {
      const data = await request('GET', '/api/subscriptions/groups') as Payload
      if (alive.current) {
        if (chainRevision.current && chainRevision.current !== data.revision) setRevision(r => r + 1)
        chainRevision.current = data.revision || ''
        setGroups(data.groups); setError('')
      }
    } catch (e) { if (alive.current) setError(message(e)) }
  }, [request])
  const cancel = useCallback(async () => {
    stopped.current = true
    if (task.current) await request('POST', '/api/subscriptions/groups/cancel', { id: task.current }).catch(() => {})
  }, [request])
  useEffect(() => {
    alive.current = true
    void load()
    const timer = window.setInterval(() => { if (active() && !operation.current) void load() }, 15000)
    const hide = () => { if (document.hidden) void cancel() }
    document.addEventListener('visibilitychange', hide)
    return () => { alive.current = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', hide); void cancel() }
  }, [load, cancel, active])

  async function select(group: Group, member: Member) {
    if (operation.current) return
    operation.current = true; setBusy(t('切换中…')); setError('')
    try {
      await request('POST', '/api/subscriptions/groups/select', { providerId: group.providerId, group: group.name, node: member.name })
      if (alive.current) { setRevision(r => r + 1); await load() }
    } catch (e) { if (alive.current) setError(message(e)) }
    finally { operation.current = false; if (alive.current) setBusy('') }
  }

  async function test(group: Group, members: Member[], kind: string, url: string, accept: (name: string, result: Result) => void) {
    if (operation.current) return
    operation.current = true; stopped.current = false; setError('')
    try {
      for (let index = 0; index < members.length; index++) {
        if (stopped.current || !alive.current || !active()) break
        const member = members[index]
        task.current = globalThis.crypto?.randomUUID?.() || `test-${Date.now()}-${Math.random().toString(36).slice(2)}`
        setBusy(`${member.name} · ${index + 1}/${members.length}`)
        try {
          const result = await request('POST', '/api/subscriptions/groups/test', {
            id: task.current, providerId: group.providerId, group: group.name, node: member.name, kind, url,
          }) as Result
          if (alive.current && !stopped.current) accept(member.name, result)
        } catch (e) { if (alive.current && !stopped.current) accept(member.name, { success: false, error: message(e), at: Date.now() }) }
        task.current = ''
      }
    } finally { operation.current = false; task.current = ''; if (alive.current) setBusy('') }
  }

  if (!groups.length && !error) return null
  return <section className='space-y-3 p-3' aria-label={t('订阅代理组')}>
    <div className='flex flex-wrap items-center gap-2'><strong>{t('订阅代理组')}</strong>
      <span className='text-xs text-subtle'>{t('先选前置，再选落地；账号代理可选择落地组，后续新连接跟随组内选择。')}</span>
      <Button size='sm' variant='outline' disabled={!!busy} onClick={() => void load()}>{t('刷新')}</Button>
    </div>
    {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
    {busy ? <div role='status' className='flex items-center gap-2 text-sm'><span>{busy}</span><Button size='sm' variant='outline' onClick={() => void cancel()}>{t('取消测试')}</Button></div> : null}
    {groups.map(group => <GroupCard key={keyOf(group)} group={group} request={request} t={t} busy={!!busy} revision={revision} select={select} test={test} />)}
  </section>
}

function GroupCard({ group, request, t, busy, revision, select, test }: {
  group: Group; request: GroupRequest; t: Translate; busy: boolean; revision: number;
  select: (group: Group, member: Member) => Promise<void>;
  test: (group: Group, members: Member[], kind: string, url: string, accept: (name: string, result: Result) => void) => Promise<void>;
}) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<Group | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState(false)
  const [settings, setSettings] = useState(false)
  const [delayUrl, setDelayUrl] = useState('')
  const [speedUrl, setSpeedUrl] = useState('')
  const [results, setResults] = useState<Record<string, Record<string, Result>>>({})
  const lastRevision = useRef(revision)
  useEffect(() => {
    if (lastRevision.current !== revision) {
      lastRevision.current = revision
      setResults(previous => Object.fromEntries(Object.entries(previous).map(([name, kinds]) => [name,
        Object.fromEntries(Object.entries(kinds).map(([kind, result]) => [kind, { ...result, stale: true }]))])))
    }
    if (!open) return
    let current = true
    setError('')
    void request('POST', '/api/subscriptions/groups/members', { providerId: group.providerId, group: group.name })
      .then(data => { if (current) setDetail((data as Payload).groups[0]) })
      .catch(e => { if (current) setError(message(e)) })
    return () => { current = false }
  }, [open, revision, group.providerId, group.name, group.selected, request])
  const selected = group.selected
  const current = detail?.members?.find(m => m.name === selected)
  const query = search.trim().toLowerCase()
  const shown = (detail?.members || []).filter(m => !query || `${m.name} ${m.server || ''}`.toLowerCase().includes(query))
  if (sort) shown.sort((a, b) => (results[a.name]?.delay?.delay || a.delay || Infinity) - (results[b.name]?.delay?.delay || b.delay || Infinity))
  const pages = Math.max(1, Math.ceil(shown.length / 36))
  const index = Math.min(page, pages - 1)
  const accept = (kind: string) => (name: string, result: Result) => setResults(previous => ({ ...previous, [name]: { ...previous[name], [kind]: result } }))
  return <Card className='overflow-hidden rounded-xl border border-border bg-surface-2 p-3'>
    <div className='flex flex-wrap items-center gap-2'>
      <button style={{ border: 0, background: 'transparent', color: 'inherit', padding: 0, font: 'inherit', cursor: 'pointer' }} className='min-w-0 flex-1 text-left' aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <strong className='block break-words text-sm'>{group.name}</strong>
        <span className='mt-1 flex flex-wrap items-center gap-2 text-xs text-subtle'><Badge variant='secondary'>{group.type}</Badge>{selected || t('未就绪')} · {group.subscription}</span>
      </button>
      <Badge variant='secondary'>{group.count}</Badge>
      <Button size='sm' variant='ghost' aria-label={`${group.name} ${t(open ? '收起' : '展开')}`} onClick={() => setOpen(v => !v)}>{t(open ? '收起' : '展开')}</Button>
    </div>
    {current?.dialer ? <p className='mt-2 text-xs text-subtle'>{current.dialer}：{current.front} → {selected}</p> : null}
    {group.selectionRemoved ? <p className='mt-2 text-xs text-destructive'>{t('原选择已从订阅移除，请重新选择。')}</p> : null}
    {group.error ? <p className='mt-2 text-xs text-destructive'>{group.error}</p> : null}
    {open ? <div className='mt-3 space-y-3 border-t border-border pt-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <Input className='min-w-40 flex-1' placeholder={t('搜索名称 / 地址')} value={search} onChange={e => {setSearch(e.target.value); setPage(0)}} />
        <Button size='sm' variant='outline' onClick={() => {setSort(v => !v);setPage(0)}}>{t(sort ? '按原顺序' : '按延迟排序')}</Button>
        <Button size='sm' variant='outline' disabled={busy || !group.available || !shown.length} onClick={() => void test(group, shown, 'delay', delayUrl, accept('delay'))}>{t('批量测延迟')}</Button>
        <Button size='sm' variant='ghost' onClick={() => setSettings(v => !v)}>{t('测速设置')}</Button>
      </div>
      {settings ? <div className='space-y-2 text-xs'>
        <label className='block'>{t('延迟测试地址')}<Input value={delayUrl} onChange={e => setDelayUrl(e.target.value)} placeholder='https://www.gstatic.com/generate_204' /></label>
        <label className='block'>{t('下载测速地址')}<Input value={speedUrl} onChange={e => setSpeedUrl(e.target.value)} placeholder='https://speed.cloudflare.com/__down?bytes=5242880' /></label>
        <p className='text-subtle'>{t('下载测速仅手动启动，每次最多 5 秒 / 5 MiB；结果包含连接建立耗时。')}</p>
      </div> : null}
      {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
      {!detail ? <p>{t('加载中…')}</p> : null}
      <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3'>
        {shown.slice(index*36, index*36+36).map(member => <div key={member.name} className={`rounded-lg border p-3 ${selected === member.name ? 'border-primary bg-primary/5' : 'border-border'}`}>
          <button style={{ border: 0, background: 'transparent', color: 'inherit', padding: 0, font: 'inherit', cursor: 'pointer' }} disabled={busy || !group.selectable} aria-pressed={selected === member.name} className='w-full text-left disabled:opacity-70' onClick={() => void select(group, member)}>
            <span className='block break-words text-sm font-medium'>{selected === member.name ? '● ' : '○ '}{member.name}</span>
            <span className='block break-all text-xs text-subtle'>{member.type} · {member.server || (member.isGroup ? t('代理组') : '')}</span>
          </button>
          {member.dialer ? <p className='mt-1 break-words text-xs text-subtle'>{member.dialer} → {member.front}</p> : null}
          <div className='my-2 space-y-1 text-xs' aria-live='polite'>
            {(['delay','speed','exit'] as const).map(kind => {
              const result = results[member.name]?.[kind]
              if (!result) return kind === 'delay' ? <div key={kind}>{member.delay ? `${member.delay} ms` : t('未测试')}</div> : null
              return <div key={kind} className={result.success ? 'text-text-2' : 'text-destructive'}>
                {t(kind === 'delay' ? '延迟' : kind === 'speed' ? '下载速度' : '出口 IP')}：{!result.success ? result.error : kind === 'delay' ? `${result.delay} ms` : kind === 'speed' ? `${((result.bytesPerSecond || 0)/1024).toFixed(1)} KB/s` : result.ip || t('未获取')}
                {' · '}{new Date(result.at).toLocaleTimeString()}{result.stale ? ` · ${t('链路已变更，请重新测试')}` : ''}
              </div>
            })}
          </div>
          <div className='flex flex-wrap gap-1'>
            {(['delay','speed','exit'] as const).map(kind => <Button key={kind} size='sm' variant='outline' disabled={busy || !group.available} onClick={() => void test(group, [member], kind, kind === 'speed' ? speedUrl : delayUrl, accept(kind))}>{t(kind === 'delay' ? '测延迟' : kind === 'speed' ? '测速' : '检查出口')}</Button>)}
          </div>
        </div>)}
      </div>
      <div className='flex items-center justify-end gap-2 text-xs'><span>{index+1} / {pages} · {shown.length}</span>
        <Button size='sm' variant='ghost' disabled={index===0} onClick={() => setPage(index-1)}>{t('上一页')}</Button>
        <Button size='sm' variant='ghost' disabled={index+1===pages} onClick={() => setPage(index+1)}>{t('下一页')}</Button>
      </div>
    </div> : null}
  </Card>
}
