import * as React from 'react'
import { Alert, Button, Checkbox, Input, Label, Sheet, Textarea } from '@ui'
import { shared, describeError } from './add-account-bridge'
import { ChannelDrawerContent } from './channel-drawer'
import { t } from '../i18n'

export type KeyGroupDraft = {
  id: string; name: string; enabled: boolean; apiKeys: string[]; accountIds: string[]; models: string[]
  keys?: Array<{ accountId: string; tail?: string; name?: string }>
}
type ChannelRecord = { id: string; name?: string; baseUrl?: string; protocol?: string; keyGroups?: KeyGroupDraft[] }

const drafts = new Map<string, KeyGroupDraft[]>()
const emptyGroup = (): KeyGroupDraft => ({ id: globalThis.crypto?.randomUUID?.() || `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, name: '', enabled: true, apiKeys: [], accountIds: [], models: [] })
const lines = (value: string): string[] => [...new Set(value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean))]

function LinesInput({ value, onChange, ...props }: Omit<React.ComponentProps<typeof Textarea>, 'value' | 'onChange'> & { value: string[]; onChange: (value: string[]) => void }) {
  const [text, setText] = React.useState(value.join('\n'))
  React.useEffect(() => {
    if (lines(text).join('\n') !== value.join('\n')) setText(value.join('\n'))
  }, [value, text])
  return <Textarea {...props} value={text} onChange={event => { setText(event.target.value); onChange(lines(event.target.value)) }} />
}

export function readChannelGroups(id: string): KeyGroupDraft[] { return drafts.get(id) || [] }
export function clearChannelGroups(id: string): void { drafts.delete(id) }

export function ChannelKeyGroups({ draftId, providerId = '', baseUrl, protocol, initial }: {
  draftId: string; providerId?: string; baseUrl: () => string; protocol: () => string; initial?: KeyGroupDraft[]
}) {
  const [rows, setRows] = React.useState<KeyGroupDraft[]>(() => drafts.get(draftId) || initial || [emptyGroup()])
  const [candidates, setCandidates] = React.useState<Record<string, string[]>>({})
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [selectedKey, setSelectedKey] = React.useState<Record<string, string>>({})
  const generation = React.useRef(0)
  React.useEffect(() => {
    drafts.set(draftId, rows)
  }, [draftId, rows])
  React.useEffect(() => () => { generation.current++ }, [])
  const update = (id: string, patch: Partial<KeyGroupDraft>) => setRows(previous => {
    generation.current++
    const next = previous.map(row => row.id === id ? { ...row, ...patch } : row)
    drafts.set(draftId, next)
    return next
  })
  const moveKey = (accountId: string, from: KeyGroupDraft, targetId: string) => setRows(previous => {
    generation.current++
    const key = from.keys?.find(key => key.accountId === accountId)
    const next = previous.map(row => row.id === from.id
      ? { ...row, accountIds: row.accountIds.filter(id => id !== accountId), keys: row.keys?.filter(key => key.accountId !== accountId) }
      : row.id === targetId ? { ...row, accountIds: [...row.accountIds, accountId], keys: key ? [...(row.keys || []), key] : row.keys } : row)
    drafts.set(draftId, next)
    return next
  })

  async function fetchModels(row: KeyGroupDraft) {
    const endpoint = baseUrl().trim()
    const selectedProtocol = protocol()
    if (!endpoint) { setError(t('请填写 Base URL')); return }
    const keyChoice = selectedKey[row.id] || (row.accountIds[0] ? `saved:${row.accountIds[0]}` : 'new:0')
    const payload: Record<string, unknown> = { providerId, baseUrl: endpoint, protocol: selectedProtocol }
    if (keyChoice.startsWith('saved:')) payload.accountId = keyChoice.slice(6)
    else payload.apiKey = row.apiKeys[Number(keyChoice.slice(4))] || ''
    if (!payload.accountId && !payload.apiKey) { setError(t('请先填写 API Key')); return }
    const version = generation.current
    setBusy(row.id); setError('')
    try {
      const api = shared().wbProviders?.customRequest
      if (!api) throw new Error(t('接口尚未就绪'))
      const result = await api('POST', '/api/custom-providers/fetch-models', payload) as { models?: string[] }
      if (generation.current !== version || baseUrl().trim() !== endpoint || protocol() !== selectedProtocol) return
      setCandidates(previous => ({ ...previous, [row.id]: [...new Set(result.models || [])] }))
    } catch (error) { if (generation.current === version) setError(describeError(error)) }
    finally { setBusy('') }
  }

  return <div className='flex flex-col gap-3'>
    <div className='flex items-center justify-between gap-2'><strong className='text-sm'>{t('API Key 分组')}</strong>
      <Button variant='outline' size='sm' disabled={rows.length >= 64} onClick={() => { generation.current++; setRows(previous => [...previous, emptyGroup()]) }}>{t('添加分组')}</Button></div>
    <p className='text-xs text-subtle'>{t('每组可放多把 Key，并独立选择可用上游模型；未选择模型的分组不参与转发。获取清单后请勾选需要的模型。')}</p>
    {error && <Alert variant='destructive'>{error}</Alert>}
    {rows.map((row, index) => <section key={row.id} className='flex flex-col gap-2 rounded-md border border-border p-3'>
      <div className='flex items-center gap-2'>
        <Checkbox checked={row.enabled} aria-label={t('启用分组')} onCheckedChange={enabled => update(row.id, { enabled: enabled === true })} />
        <Input value={row.name} maxLength={100} placeholder={t('分组名称')} onChange={event => update(row.id, { name: event.target.value })} />
        <Button variant='ghost' size='sm' disabled={rows.length === 1} onClick={() => { generation.current++; setRows(previous => previous.filter(item => item.id !== row.id)) }}>{t('删除')}</Button>
      </div>
      {row.keys?.filter(key => row.accountIds.includes(key.accountId)).map(key => <div className='flex items-center justify-between text-xs' key={key.accountId}>
        <span>{key.name || t('已保存 Key')} · ••••{key.tail || ''}</span>
        {rows.length > 1 && <select className='ml-auto max-w-40 rounded border border-border bg-surface px-2 py-1' aria-label={t('移动到分组')}
          value={row.id} onChange={event => moveKey(key.accountId, row, event.target.value)}>
          {rows.map((group, i) => <option key={group.id} value={group.id}>{group.name || `${t('分组')} ${i + 1}`}</option>)}
        </select>}
        <Button variant='ghost' size='sm' onClick={() => update(row.id, { accountIds: row.accountIds.filter(id => id !== key.accountId) })}>{t('移除')}</Button>
      </div>)}
      <Label htmlFor={`${draftId}-${index}-keys`}>{t('API Key（每行一把）')}</Label>
      <LinesInput id={`${draftId}-${index}-keys`} autoComplete='off' spellCheck={false} value={row.apiKeys}
        onChange={apiKeys => update(row.id, { apiKeys })} placeholder={row.accountIds.length ? t('追加 Key，留空保留已有 Key') : 'sk-…'} rows={2} />
      <div className='flex items-center gap-2'>
        <select className='min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs' aria-label={t('用于获取模型的 Key')}
          value={selectedKey[row.id] || (row.accountIds[0] ? `saved:${row.accountIds[0]}` : 'new:0')}
          onChange={event => { generation.current++; setSelectedKey(previous => ({ ...previous, [row.id]: event.target.value })) }}>
          {row.accountIds.map((id, i) => <option key={id} value={`saved:${id}`}>{t('已保存 Key')} {i + 1}</option>)}
          {row.apiKeys.map((_, i) => <option key={i} value={`new:${i}`}>{t('新 Key')} {i + 1}</option>)}
        </select>
        <Button size='sm' variant='outline' disabled={Boolean(busy)} onClick={() => void fetchModels(row)}>{busy === row.id ? t('获取中…') : t('获取模型')}</Button>
      </div>
      {candidates[row.id]?.length ? <div className='flex max-h-44 flex-wrap gap-2 overflow-auto rounded border border-border p-2'>
        {candidates[row.id].map(model => <label key={model} className='inline-flex cursor-pointer items-center gap-1 text-xs'>
          <Checkbox checked={row.models.includes(model)} onCheckedChange={checked => update(row.id, { models: checked ? [...new Set([...row.models, model])] : row.models.filter(item => item !== model) })} />{model}
        </label>)}
      </div> : null}
      <Label htmlFor={`${draftId}-${index}-models`}>{t('可用上游模型（每行一个，可手动填写）')}</Label>
      <LinesInput id={`${draftId}-${index}-models`} value={row.models} rows={3} spellCheck={false}
        onChange={models => update(row.id, { models })} />
      <span className='text-xs text-subtle'>{t('已选择 {n} 个模型', { n: row.models.length })}</span>
    </section>)}
  </div>
}

export function ChannelKeyGroupsDialog({ providerId, onClose }: { providerId: string; onClose: () => void }) {
  const [provider, setProvider] = React.useState<ChannelRecord | null>(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const draftId = `edit-channel-${providerId}`
  React.useEffect(() => {
    let alive = true
    clearChannelGroups(draftId)
    const api = shared().wbProviders?.customRequest
    if (!api) { setError(t('接口尚未就绪')); return }
    void api('GET', '/api/custom-providers').then(result => {
      if (!alive) return
      const found = (result as {providers?: ChannelRecord[]}).providers?.find(item => item.id === providerId)
      if (!found) throw new Error(t('渠道不存在'))
      setProvider(found)
    }).catch(error => { if (alive) setError(describeError(error)) })
    return () => { alive = false; clearChannelGroups(draftId) }
  }, [draftId, providerId])
  async function save() {
    setBusy(true); setError('')
    try {
      const api = shared().wbProviders?.customRequest
      if (!api) throw new Error(t('接口尚未就绪'))
      await api('POST', '/api/custom-providers/update', {id:providerId,keyGroups:readChannelGroups(draftId)})
      await shared().wbProviders?.refreshCustom?.()
      await shared().wbApp?.refresh?.()
      onClose()
    } catch(error) { setError(describeError(error)) }
    finally { setBusy(false) }
  }
  return <Sheet open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <ChannelDrawerContent title={t('编辑渠道')} description={provider?.name}
      footer={<><Button variant='outline' disabled={busy} onClick={onClose}>{t('取消')}</Button>
        <Button disabled={busy || !provider} onClick={() => void save()}>{busy ? t('保存中…') : t('保存')}</Button></>}>
      {error && <Alert variant='destructive'>{error}</Alert>}
      {provider && <>
        <section data-channel-section='details' className='scroll-mt-4'>
          <h3 className='mb-3 text-sm font-semibold'>{t('基本配置')}</h3>
          <div className='add-form'>
            <div className='add-field'><Label htmlFor='edit-channel-name'>{t('名称')}</Label><Input id='edit-channel-name' readOnly value={provider.name || ''} /></div>
            <div className='add-field'><Label htmlFor='edit-channel-base-url'>Base URL</Label><Input id='edit-channel-base-url' readOnly value={provider.baseUrl || ''} /></div>
            <div className='add-field'><Label htmlFor='edit-channel-protocol'>{t('协议')}</Label><Input id='edit-channel-protocol' readOnly value={provider.protocol || 'chat_completions'} /></div>
          </div>
        </section>
        <section data-channel-section='keys' className='scroll-mt-4'>
          <ChannelKeyGroups draftId={draftId} providerId={providerId}
            baseUrl={() => provider.baseUrl || ''} protocol={() => provider.protocol || 'chat_completions'} initial={provider.keyGroups?.map(row => ({...row,apiKeys:[]}))} />
        </section>
      </>}
    </ChannelDrawerContent>
  </Sheet>
}
