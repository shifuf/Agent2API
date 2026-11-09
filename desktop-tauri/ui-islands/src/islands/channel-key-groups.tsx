import * as React from 'react'
import { createPortal } from 'react-dom'
import { Alert, Button, Checkbox, Dialog, Input, Label, Textarea } from '@ui'
import { shared, describeError } from './add-account-bridge'
import { ChannelDialogContent, useChannelPanel } from './channel-dialog'
import { t } from '../i18n'

export type KeyGroupDraft = {
  id: string; name: string; enabled: boolean; apiKeys: string[]; accountIds: string[]; models: string[]
  keys?: Array<{ accountId: string; tail?: string; name?: string }>
}
type ChannelRecord = { id: string; name?: string; baseUrl?: string; protocol?: string; keyGroups?: KeyGroupDraft[] }
export type ChannelRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>

const drafts = new Map<string, KeyGroupDraft[]>()
const candidateDrafts = new Map<string, Record<string, string[]>>()
const keyChoiceDrafts = new Map<string, Record<string, string>>()
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
export function clearChannelGroups(id: string): void { drafts.delete(id); candidateDrafts.delete(id); keyChoiceDrafts.delete(id) }

type ModelGroup = { row: KeyGroupDraft; candidates: string[]; label: string }

function GroupModelSelection({ groups, title, onApply, onClose }: {
  groups: ModelGroup[]; title: string; onApply: (models: Record<string, string[]>) => void; onClose: () => void
}) {
  const [selected, setSelected] = React.useState<Record<string, string[]>>(() => Object.fromEntries(groups.map(({ row }) => [row.id, row.models])))
  const [custom, setCustom] = React.useState('')
  const [added, setAdded] = React.useState<string[]>([])
  const [search, setSearch] = React.useState('')
  const input = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { input.current?.focus() }, [])
  const all = [...new Set([...groups.flatMap(({ row, candidates }) => [...candidates, ...row.models]), ...added])]
  const visible = all.filter(model => model.toLowerCase().includes(search.trim().toLowerCase()))
  const sourcesOf = (model: string) => groups.filter(({ row, candidates }) => candidates.includes(model) || row.models.includes(model) || added.includes(model))
  const selectedModels = all.filter(model => sourcesOf(model).some(({ row }) => selected[row.id]?.includes(model)))
  const toggle = (model: string, checked: boolean) => setSelected(previous => {
    const next = { ...previous }
    for (const { row } of sourcesOf(model)) {
      next[row.id] = checked ? [...new Set([...(previous[row.id] || []), model])] : (previous[row.id] || []).filter(item => item !== model)
    }
    return next
  })
  const addCustom = () => {
    const models = lines(custom)
    setAdded(previous => [...new Set([...previous, ...models])])
    setSelected(previous => Object.fromEntries(groups.map(({ row }) => [row.id, [...new Set([...(previous[row.id] || []), ...models])]])))
    setCustom('')
  }
  return <section className='channel-panel-content' aria-label={t('选择分组模型')} data-channel-panel='models'>
    <div className='flex items-center justify-between gap-2'>
      <h3 className='min-w-0 truncate text-sm font-semibold'>{title}</h3>
      <Button variant='ghost' size='sm' onClick={onClose}>{t('关闭')}</Button>
    </div>
    <p className='text-xs text-subtle'>{groups.length > 1 ? t('按来源分组确认模型，获取清单不会自动选中。') : t('仅在确认后更新当前分组，获取模型不会自动选中。')}</p>
    <Input ref={input} aria-label={t('搜索模型')} placeholder={t('搜索模型')} value={search} onChange={event => setSearch(event.target.value)} />
    <div className='flex flex-wrap items-center justify-between gap-2'>
      <span className='text-xs text-subtle'>{t('已选择 {n} 个模型', { n: selectedModels.length })}</span>
      <div className='flex gap-2'>
        <Button size='sm' variant='outline' onClick={() => visible.forEach(model => toggle(model, true))}>{t('全选')}</Button>
        <Button size='sm' variant='outline' onClick={() => setSelected(Object.fromEntries(groups.map(({ row }) => [row.id, []])))}>{t('清空')}</Button>
      </div>
    </div>
    <div className='channel-panel-list'>
      {visible.length ? visible.map(model => <label key={model} className='flex cursor-pointer items-start gap-2 rounded p-2 text-xs'>
        <Checkbox checked={sourcesOf(model).every(({ row }) => selected[row.id]?.includes(model))}
          indeterminate={selectedModels.includes(model) && !sourcesOf(model).every(({ row }) => selected[row.id]?.includes(model))}
          onCheckedChange={checked => toggle(model, checked === true)} />
        <span className='min-w-0 flex-1'><code className='break-all'>{model}</code>
          {groups.length > 1 && <span aria-hidden='true' className='mt-1 flex flex-wrap gap-1'>{sourcesOf(model).map(group =>
            <span key={group.row.id} className='rounded border border-border px-1 text-subtle'>{group.label}</span>)}</span>}
        </span>
      </label>) : <p className='py-6 text-center text-xs text-subtle'>{t('没有匹配的模型')}</p>}
    </div>
    <div className='flex items-center gap-2'>
      <Input className='min-w-0 flex-1' aria-label={t('自定义模型 ID')} placeholder={t('自定义模型 ID')} value={custom}
        onChange={event => setCustom(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addCustom() } }} />
      <Button size='sm' variant='outline' disabled={!custom.trim()} onClick={addCustom}>{t('添加')}</Button>
    </div>
    <div className='channel-panel-actions'>
      <Button variant='outline' size='sm' onClick={onClose}>{t('取消')}</Button>
      <Button size='sm' onClick={() => onApply(selected)}>{t('确认选择')}</Button>
    </div>
  </section>
}

export function ChannelKeyGroups({ draftId, fieldPrefix = draftId, providerId = '', baseUrl, protocol, initial, request }: {
  draftId: string; fieldPrefix?: string; providerId?: string; baseUrl: () => string; protocol: () => string; initial?: KeyGroupDraft[]
  request?: ChannelRequest
}) {
  const [rows, setRows] = React.useState<KeyGroupDraft[]>(() => drafts.get(draftId) || initial || [emptyGroup()])
  const [candidates, setCandidates] = React.useState<Record<string, string[]>>(() => candidateDrafts.get(draftId) || {})
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [selectedKey, setSelectedKey] = React.useState<Record<string, string>>(() => keyChoiceDrafts.get(draftId) || {})
  const [panel, setPanel] = React.useState<{ rowId: string; kind: 'keys' | 'models' | 'all-models'; cacheKey: string; groupKeys?: Record<string, string>; revision: number } | null>(null)
  const { host, activeId, openPanel, closePanel, releasePanel, intent } = useChannelPanel()
  const generation = React.useRef(0)
  React.useEffect(() => {
    drafts.set(draftId, rows)
  }, [draftId, rows])
  React.useEffect(() => () => { generation.current++ }, [])
  React.useEffect(() => () => releasePanel(draftId), [draftId, releasePanel])
  const keyChoice = (row: KeyGroupDraft) => {
    const current = selectedKey[row.id]
    if (current?.startsWith('saved:') && row.accountIds.includes(current.slice(6))) return current
    if (current?.startsWith('new:') && row.apiKeys[Number(current.slice(4))]) return current
    return row.accountIds[0] ? `saved:${row.accountIds[0]}` : 'new:0'
  }
  const candidateKey = (row: KeyGroupDraft) => {
    const choice = keyChoice(row)
    const credential = choice.startsWith('saved:') ? choice : row.apiKeys[Number(choice.slice(4))] || ''
    return JSON.stringify([row.id, baseUrl().trim(), protocol(), credential])
  }
  const showPanel = (row: KeyGroupDraft, kind: 'keys' | 'models', cacheKey = candidateKey(row), trigger?: HTMLElement) => {
    setPanel(previous => ({ rowId: row.id, kind, cacheKey, revision: (previous?.revision || 0) + 1 }))
    openPanel(draftId, trigger)
  }
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

  async function fetchModels(row: KeyGroupDraft, trigger: HTMLElement) {
    const endpoint = baseUrl().trim()
    const selectedProtocol = protocol()
    if (!endpoint) { setError(t('请填写 Base URL')); return }
    const choice = keyChoice(row)
    const cacheKey = candidateKey(row)
    const payload: Record<string, unknown> = { providerId, baseUrl: endpoint, protocol: selectedProtocol }
    if (choice.startsWith('saved:')) payload.accountId = choice.slice(6)
    else payload.apiKey = row.apiKeys[Number(choice.slice(4))] || ''
    if (!payload.accountId && !payload.apiKey) { setError(t('请先填写 API Key')); return }
    const version = generation.current
    const requestIntent = ++intent.current
    const alreadySelecting = activeId === draftId && panel?.rowId === row.id && panel.kind === 'models' && panel.cacheKey === cacheKey
    setBusy(row.id); setError('')
    try {
      const api = request || shared().wbProviders?.customRequest
      if (!api) throw new Error(t('接口尚未就绪'))
      const result = await api('POST', '/api/custom-providers/fetch-models', payload) as { models?: string[] }
      if (generation.current !== version || baseUrl().trim() !== endpoint || protocol() !== selectedProtocol) return
      setCandidates(previous => {
        const next = { ...previous, [cacheKey]: [...new Set(result.models || [])] }
        candidateDrafts.set(draftId, next)
        return next
      })
      // Cache late results, but never steal a newer panel or recreate its tentative selection.
      if (intent.current === requestIntent && !alreadySelecting) showPanel(row, 'models', cacheKey, trigger)
    } catch (error) { if (generation.current === version) setError(describeError(error)) }
    finally { setBusy('') }
  }

  async function fetchAllModels(trigger: HTMLElement) {
    const endpoint = baseUrl().trim()
    const selectedProtocol = protocol()
    if (!endpoint) { setError(t('请填写 Base URL')); return }
    const eligible = rows.filter(row => row.accountIds.length || row.apiKeys.length)
    if (!eligible.length) { setError(t('请先填写 API Key')); return }
    const version = generation.current
    const requestIntent = ++intent.current
    const groupKeys: Record<string, string> = {}
    const discovered: Record<string, string[]> = {}
    const errors: string[] = []
    setBusy('all'); setError('')
    try {
      const api = request || shared().wbProviders?.customRequest
      if (!api) throw new Error(t('接口尚未就绪'))
      for (const row of eligible) {
        if (generation.current !== version || baseUrl().trim() !== endpoint || protocol() !== selectedProtocol) return
        const choice = keyChoice(row)
        const cacheKey = candidateKey(row)
        const payload: Record<string, unknown> = { providerId, baseUrl: endpoint, protocol: selectedProtocol }
        if (choice.startsWith('saved:')) payload.accountId = choice.slice(6)
        else payload.apiKey = row.apiKeys[Number(choice.slice(4))] || ''
        try {
          const result = await api('POST', '/api/custom-providers/fetch-models', payload) as { models?: string[] }
          discovered[cacheKey] = [...new Set(result.models || [])]
          groupKeys[row.id] = cacheKey
        } catch (error) {
          errors.push(`${row.name || `${t('分组')} ${rows.indexOf(row) + 1}`}：${describeError(error)}`)
        }
      }
      if (generation.current !== version || baseUrl().trim() !== endpoint || protocol() !== selectedProtocol) return
      setCandidates(previous => {
        const next = { ...previous, ...discovered }
        candidateDrafts.set(draftId, next)
        return next
      })
      setError(errors.join('\n'))
      if (Object.keys(groupKeys).length && intent.current === requestIntent) {
        setPanel(previous => ({ rowId: '', kind: 'all-models', cacheKey: '', groupKeys, revision: (previous?.revision || 0) + 1 }))
        openPanel(draftId, trigger)
      }
    } catch (error) { if (generation.current === version) setError(describeError(error)) }
    finally { setBusy('') }
  }

  const panelRow = panel && activeId === draftId ? rows.find(row => row.id === panel.rowId) : undefined
  const panelName = panelRow?.name || `${t('分组')} ${rows.findIndex(row => row.id === panelRow?.id) + 1}`
  const modelGroups: ModelGroup[] = panel && activeId === draftId && panel.kind !== 'keys'
    ? rows.filter(row => panel.kind === 'all-models' ? Boolean(panel.groupKeys?.[row.id]) : row.id === panel.rowId)
      .map(row => ({ row, label: row.name || `${t('分组')} ${rows.indexOf(row) + 1}`,
        candidates: candidates[panel.kind === 'all-models' ? panel.groupKeys?.[row.id] || '' : panel.cacheKey] || [] }))
    : []
  const modelCount = new Set(rows.flatMap(row => row.models)).size
  return <div className='flex flex-col gap-3'>
    <div className='flex items-center justify-between gap-2'><strong className='text-sm'>{t('API Key 分组')}</strong>
      <Button variant='outline' size='sm' disabled={rows.length >= 64} onClick={() => { generation.current++; setRows(previous => [...previous, emptyGroup()]) }}>{t('添加分组')}</Button></div>
    <p className='text-xs text-subtle'>{t('每组可填写多把 Key，模型在下方按分组配置。')}</p>
    {error && <Alert variant='destructive'>{error}</Alert>}
    {rows.map((row, index) => <section key={row.id} data-channel-group={index} className='flex min-w-0 flex-col gap-2 rounded-md border border-border p-3'>
      <div className='flex items-center gap-2'>
        <Checkbox checked={row.enabled} aria-label={t('启用分组')} onCheckedChange={enabled => update(row.id, { enabled: enabled === true })} />
        <span className='shrink-0 text-xs text-subtle'>{t('分组')} {index + 1}</span>
        <Input value={row.name} maxLength={100} aria-label={t('分组名称')} placeholder={t('分组名称')} onChange={event => update(row.id, { name: event.target.value })} />
        <Button variant='ghost' size='sm' disabled={rows.length === 1} onClick={() => { generation.current++; if (panelRow?.id === row.id || panel?.kind === 'all-models') closePanel(); setRows(previous => previous.filter(item => item.id !== row.id)) }}>{t('删除')}</Button>
      </div>
      <div className='channel-group-actions'>
        <span className='text-xs text-subtle'>{t('{n} 把 Key', { n: row.accountIds.length + row.apiKeys.length })}</span>
        <Button variant='outline' size='sm' onClick={event => showPanel(row, 'keys', candidateKey(row), event.currentTarget)}>{t('查看分组 Key')}</Button>
      </div>
      <Label htmlFor={`${fieldPrefix}-${index}-keys`}>{t('API Key（每行一把）')}</Label>
      <LinesInput id={`${fieldPrefix}-${index}-keys`} autoComplete='off' spellCheck={false} value={row.apiKeys}
        onChange={apiKeys => { if ((panelRow?.id === row.id && panel?.kind === 'models') || panel?.kind === 'all-models') closePanel(); update(row.id, { apiKeys }) }} placeholder={row.accountIds.length ? t('追加 Key，留空保留已有 Key') : 'sk-…'} rows={2} />
    </section>)}
    <section className='mt-4 flex min-w-0 flex-col gap-3' data-channel-models>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <strong className='text-sm'>{t('支持的模型')} <span className='font-normal text-subtle'>({modelCount})</span></strong>
        <Button variant='outline' size='sm' disabled={Boolean(busy) || !rows.some(row => row.apiKeys.length || row.accountIds.length)}
          onClick={event => void fetchAllModels(event.currentTarget)}>{busy === 'all' ? t('获取中…') : t('获取全部分组模型')}</Button>
      </div>
      <p className='text-xs text-subtle'>{modelCount ? t('获取清单后按分组选择模型，确认后生效。') : t('尚未选择模型，可先保存渠道，稍后配置模型。')}</p>
      {rows.map((row, index) => <div key={row.id} data-channel-model-group={index} className='channel-model-row'>
        <span className='rounded border border-border px-2 py-1 text-xs'>{row.name || `${t('分组')} ${index + 1}`}</span>
        <select className='min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs' aria-label={t('用于获取模型的 Key')}
          value={keyChoice(row)}
          onChange={event => {
            generation.current++
            if (panelRow?.id === row.id || panel?.kind === 'all-models') closePanel()
            const next = { ...selectedKey, [row.id]: event.target.value }
            keyChoiceDrafts.set(draftId, next)
            setSelectedKey(next)
          }}>
          {row.accountIds.map((id, i) => <option key={id} value={`saved:${id}`}>{t('已保存 Key')} {i + 1}</option>)}
          {row.apiKeys.map((_, i) => <option key={i} value={`new:${i}`}>{t('新 Key')} {i + 1}</option>)}
          {!row.accountIds.length && !row.apiKeys.length && <option value='new:0'>{t('请先填写 API Key')}</option>}
        </select>
        <Button size='sm' variant='outline' disabled={Boolean(busy) || (!row.accountIds.length && !row.apiKeys.length)} onClick={event => void fetchModels(row, event.currentTarget)}>{busy === row.id ? t('获取中…') : t('获取模型')}</Button>
        <Button variant='ghost' size='sm' onClick={event => showPanel(row, 'models', candidateKey(row), event.currentTarget)}>{t('选择模型')}</Button>
        <span className='text-xs text-subtle'>{t('已选择 {n} 个模型', { n: row.models.length })}</span>
        {row.models.length > 0 && <div className='channel-model-preview'>{row.models.map(model =>
          <code key={model} className='max-w-full break-all rounded bg-secondary px-1.5 py-1 text-xs'>{model}</code>)}</div>}
      </div>)}
    </section>
    {host && panel && activeId === draftId && (panelRow || modelGroups.length > 0) && createPortal(panel.kind !== 'keys'
      ? <GroupModelSelection key={`${panel.rowId}-${panel.revision}`} groups={modelGroups}
        title={panel.kind === 'all-models' ? t('全部分组模型') : panelName} onClose={closePanel} onApply={models => {
          if (modelGroups.some(({ row }) => (panel.kind === 'all-models' ? panel.groupKeys?.[row.id] : panel.cacheKey) !== candidateKey(row))) {
            setError(t('Base URL、协议或 Key 已变化，请重新获取模型。'))
            closePanel()
            return
          }
          for (const [id, selected] of Object.entries(models)) update(id, { models: selected })
          closePanel()
        }} />
      : panelRow && <section className='channel-panel-content' aria-label={t('分组 Key')} data-channel-panel='keys'>
        <div className='flex items-center justify-between gap-2'>
          <h3 className='min-w-0 truncate text-sm font-semibold'>{panelName} · API Key</h3>
          <Button autoFocus variant='ghost' size='sm' onClick={closePanel}>{t('关闭')}</Button>
        </div>
        <div className='channel-panel-list flex flex-col gap-2'>
          {panelRow.accountIds.map((id, index) => {
            const key = panelRow.keys?.find(key => key.accountId === id)
            return <div key={id} className='flex flex-wrap items-center gap-2 rounded border border-border p-2 text-xs'>
              <span className='min-w-0 break-all'>{key?.name || `${t('已保存 Key')} ${index + 1}`} · ••••{key?.tail || ''}</span>
              {rows.length > 1 && <select className='min-w-0 max-w-full rounded border border-border bg-surface px-2 py-1' aria-label={t('移动到分组')}
                value={panelRow.id} onChange={event => moveKey(id, panelRow, event.target.value)}>
                {rows.map((group, i) => <option key={group.id} value={group.id}>{group.name || `${t('分组')} ${i + 1}`}</option>)}
              </select>}
              <Button variant='ghost' size='sm' onClick={() => update(panelRow.id, { accountIds: panelRow.accountIds.filter(accountId => accountId !== id) })}>{t('移除')}</Button>
            </div>
          })}
          {panelRow.apiKeys.map((key, index) => <div key={index} className='rounded border border-border p-2 text-xs'>
            <span className='text-subtle'>{t('新 Key')} {index + 1}</span><code className='mt-1 block break-all'>{key}</code>
          </div>)}
          {!panelRow.accountIds.length && !panelRow.apiKeys.length && <p className='py-6 text-center text-xs text-subtle'>{t('请先填写 API Key')}</p>}
        </div>
      </section>, host)}
  </div>
}

export function ChannelKeyGroupsDialog({ providerId, onClose, request, onSaved }: {
  providerId: string; onClose: () => void; request?: ChannelRequest; onSaved?: () => Promise<void>
}) {
  const [provider, setProvider] = React.useState<ChannelRecord | null>(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const draftId = `edit-channel-${providerId}`
  React.useEffect(() => {
    let alive = true
    const api = request || shared().wbProviders?.customRequest
    if (!api) { setError(t('接口尚未就绪')); return }
    void api('GET', '/api/custom-providers').then(result => {
      if (!alive) return
      const found = (result as {providers?: ChannelRecord[]}).providers?.find(item => item.id === providerId)
      if (!found) throw new Error(t('渠道不存在'))
      setProvider(found)
    }).catch(error => { if (alive) setError(describeError(error)) })
    return () => { alive = false }
  }, [draftId, providerId, request])
  async function save() {
    setBusy(true); setError('')
    try {
      const api = request || shared().wbProviders?.customRequest
      if (!api) throw new Error(t('接口尚未就绪'))
      await api('POST', '/api/custom-providers/update', {id:providerId,keyGroups:readChannelGroups(draftId)})
      if (onSaved) await onSaved()
      else {
        await shared().wbProviders?.refreshCustom?.()
        await shared().wbApp?.refresh?.()
      }
      clearChannelGroups(draftId)
      onClose()
    } catch(error) { setError(describeError(error)) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <ChannelDialogContent title={t('编辑渠道')} description={provider?.name}
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
          <ChannelKeyGroups draftId={draftId} providerId={providerId} request={request}
            baseUrl={() => provider.baseUrl || ''} protocol={() => provider.protocol || 'chat_completions'} initial={provider.keyGroups?.map(row => ({...row,apiKeys:[]}))} />
        </section>
      </>}
    </ChannelDialogContent>
  </Dialog>
}
