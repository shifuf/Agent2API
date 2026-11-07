import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, Checkbox, Input, Label, Sheet, SheetBody, SheetContent,
  SheetFooter, SheetHeader, SheetTitle, Switch, confirmDialog } from '@ui'
import { type ManagedModel, upsertBinding, validateManagedModel } from '../../../ui-shared/managed-models'
import { apiCall } from '../api/client'
import { ErrorNote, Empty, SkeletonList } from '../components/ui'
import { t } from '../i18n'

type Source = { id: string; name: string; models: Array<{ id: string; name?: string }> }
type Catalog = { models: ManagedModel[]; sources: Source[]; revision: string; routingGroups?: Array<{ model: string }> }

export function ManagedModelsPage({ onSources }: { onSources: () => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [query, setQuery] = useState('')
  const [sourceQuery, setSourceQuery] = useState('')
  const [draft, setDraft] = useState<ManagedModel | null>(null)
  const [original, setOriginal] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const generation = useRef(0)

  async function load() {
    const ticket = ++generation.current
    setBusy(true)
    try {
      const next = await apiCall<Catalog>('/api/models/catalog')
      if (ticket === generation.current) { setCatalog(next); setError('') }
    } catch (cause) { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (ticket === generation.current) setBusy(false) }
  }
  useEffect(() => { void load(); return () => { generation.current++ } }, [])

  async function save(model: ManagedModel | null, previousId: string) {
    if (!catalog || saving.current) return
    if (model) {
      const invalid = validateManagedModel(model)
      if (invalid) { setError(invalid === 'id' ? t('请填写有效的对外模型 ID') : t('请选择渠道及其上游模型')); return }
    }
    saving.current = true; setBusy(true); setError('')
    try {
      const next = await apiCall<Catalog>('/api/models/catalog', { method: 'POST', body: { previousId, model, revision: catalog.revision } })
      setCatalog(next); setDraft(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { saving.current = false; setBusy(false) }
  }
  function edit(model?: ManagedModel) {
    setOriginal(model?.id || '')
    setDraft(model ? structuredClone(model) : { id: '', name: '', enabled: true, bindings: [] })
    setSourceQuery(''); setError('')
  }
  const name = (id: string) => catalog?.sources.find(source => source.id === id)?.name || id
  const rows = (catalog?.models || []).filter(model => `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()))
  const sources = (catalog?.sources || []).flatMap(source => source.models.map(model => ({ source, model })))
    .filter(({ source, model }) => `${source.name} ${model.id}`.toLowerCase().includes(sourceQuery.toLowerCase()))

  return <div className='m-page'>
    <div className='m-section flex flex-col gap-3'>
      <p className='text-xs text-subtle'>{t('手动添加对外模型，并选择渠道中的上游模型。获取上游清单不会自动发布模型。')}</p>
      <div className='flex flex-wrap gap-2'>
        <Button disabled={busy || !catalog} onClick={() => edit()}>{t('添加模型')}</Button>
        <Button variant='outline' disabled={busy} onClick={() => void load()}>{t('刷新')}</Button>
        <Button variant='outline' onClick={onSources}>{t('上游模型目录')}</Button>
      </div>
      <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索对外模型…')} aria-label={t('搜索对外模型')} />
      {error && !draft && <ErrorNote text={error} />}
      {!catalog && busy && <SkeletonList rows={3} height={100} />}
      {catalog && !rows.length && <Card className='m-card'><Empty text={query ? t('没有匹配的模型') : t('尚未添加对外模型。点击「添加模型」，选择渠道和上游模型后即可使用。')} /></Card>}
      {rows.map(model => <Card key={model.id} className='m-card m-card-pad'>
        <div className='flex items-center justify-between gap-3'>
          <div className='min-w-0'><div className='break-all font-mono text-sm'>{model.id}</div><p className='text-xs text-subtle'>{model.name}</p></div>
          <Switch checked={model.enabled} disabled={busy} aria-label={`${t('启用')} ${model.id}`} onCheckedChange={enabled => void save({ ...model, enabled }, model.id)} />
        </div>
        <div className='my-3 flex flex-col gap-1 text-xs'>{model.bindings.map(binding => <span key={binding.provider} className='break-all'>{name(binding.provider)} → {binding.model}</span>)}</div>
        <div className='flex gap-2'>
          <Button size='sm' variant='outline' disabled={busy} onClick={() => edit(model)}>{t('编辑')}</Button>
          <Button size='sm' variant='ghost' disabled={busy} onClick={async () => {
            if (await confirmDialog(t('确定删除对外模型「{id}」？', { id: model.id }))) await save(null, model.id)
          }}>{t('删除')}</Button>
        </div>
      </Card>)}
      {!!catalog?.routingGroups?.length && <p className='text-xs text-subtle'>{t('已创建的路由组也作为对外模型提供，可在路由配置中维护：')}{catalog.routingGroups.map(group => group.model).join('、')}</p>}
    </div>
    {draft && <Sheet open onOpenChange={(open, details) => { if (!open) { if (saving.current) details.cancel(); else setDraft(null) } }}>
      <SheetContent><SheetHeader><SheetTitle>{original ? t('编辑模型') : t('添加模型')}</SheetTitle></SheetHeader>
        <SheetBody className='flex flex-col gap-3'>
          {error && <ErrorNote text={error} />}
          <Label htmlFor='mobile-model-id'>{t('对外模型 ID')}</Label>
          <Input id='mobile-model-id' disabled={busy} value={draft.id} onChange={event => setDraft({ ...draft, id: event.target.value })} />
          <Label htmlFor='mobile-model-name'>{t('名称')}</Label>
          <Input id='mobile-model-name' disabled={busy} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} />
          <p className='text-xs text-subtle'>{t('每个渠道选择一个上游模型；可同时关联多个渠道。')}</p>
          <Button variant='outline' disabled={busy} onClick={() => void load()}>{t('刷新候选')}</Button>
          <div className='flex flex-wrap gap-2'>{draft.bindings.map(binding => <Badge key={binding.provider} variant='secondary'>
            {name(binding.provider)} → {binding.model}
            <Button size='sm' variant='ghost' disabled={busy} aria-label={`${t('移除')} ${binding.model}`}
              onClick={() => setDraft({ ...draft, bindings: upsertBinding(draft.bindings, binding.provider, '') })}>×</Button>
          </Badge>)}</div>
          <Input value={sourceQuery} onChange={event => setSourceQuery(event.target.value)} placeholder={t('搜索渠道或上游模型…')} aria-label={t('搜索渠道或上游模型')} />
          <div className='flex flex-col gap-2'>{sources.map(({ source, model }) => <label key={`${source.id}:${model.id}`} className='flex items-center gap-3 rounded border border-border p-3'>
            <Checkbox disabled={busy} checked={draft.bindings.some(binding => binding.provider === source.id && binding.model === model.id)} onCheckedChange={checked => setDraft({
              ...draft, id: draft.id || (checked ? model.id : ''), bindings: upsertBinding(draft.bindings, source.id, checked ? model.id : ''),
            })} />
            <span className='min-w-0 break-all text-xs'>{source.name}<br /><span className='font-mono'>{model.id}</span></span>
          </label>)}</div>
          {!sources.length && <Empty text={t('没有匹配的模型')} />}
        </SheetBody>
        <SheetFooter><Button variant='outline' disabled={busy} onClick={() => setDraft(null)}>{t('取消')}</Button>
          <Button disabled={busy} onClick={() => void save(draft, original)}>{t('保存')}</Button></SheetFooter>
      </SheetContent>
    </Sheet>}
  </div>
}
