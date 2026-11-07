import * as React from 'react'
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, DialogBody, DialogContent,
  DialogFooter, DialogHeader, DialogTitle, Input, Label, Switch, Table, TableBody, TableCell,
  TableHead, TableHeader, TableRow } from '@ui'
import { accountRequest, describeError, shared } from './add-account-bridge'
import { type ManagedModel, upsertBinding, validateManagedModel } from '../../../ui-shared/managed-models'
import { t } from '../i18n'

type Source = { id: string; name: string; accountCount: number; models: Array<{ id: string; name?: string; kind?: string }> }
type Catalog = { models: ManagedModel[]; sources: Source[]; revision: string; routingGroups?: Array<{ id: string; model: string; name: string }> }
const blank = (): ManagedModel => ({ id: '', name: '', enabled: true, bindings: [] })

export function ManagedModelsPage({ onSources }: { onSources: () => void }) {
  const [catalog, setCatalog] = React.useState<Catalog | null>(null)
  const [query, setQuery] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [draft, setDraft] = React.useState<ManagedModel | null>(null)
  const [original, setOriginal] = React.useState('')
  const [sourceQuery, setSourceQuery] = React.useState('')
  const [deleting, setDeleting] = React.useState<ManagedModel | null>(null)
  const saving = React.useRef(false)
  const generation = React.useRef(0)

  const load = React.useCallback(async () => {
    const ticket = ++generation.current
    setBusy(true); setError('')
    try {
      const result = await accountRequest('GET', '/api/models/catalog') as Catalog
      if (ticket === generation.current) setCatalog(result)
    } catch (failure) { if (ticket === generation.current) setError(describeError(failure)) }
    finally { if (ticket === generation.current) setBusy(false) }
  }, [])
  React.useEffect(() => { void load(); return () => { generation.current++ } }, [load])

  async function save(model: ManagedModel | null, previousId: string) {
    if (!catalog || saving.current) return
    if (model) {
      const invalid = validateManagedModel(model)
      if (invalid) { setError(invalid === 'id' ? t('请填写有效的对外模型 ID') : t('请选择渠道及其上游模型')); return }
    }
    saving.current = true; setBusy(true); setError('')
    try {
      const result = await accountRequest('POST', '/api/models/catalog', { previousId, model, revision: catalog.revision }) as Catalog
      setCatalog(result); setDraft(null); setDeleting(null)
      void shared().wbApp?.refresh?.()
      const keys = (window as unknown as { wbKeysPanel?: { load?: () => Promise<void> } }).wbKeysPanel
      void keys?.load?.()
    } catch (failure) { setError(describeError(failure)) }
    finally { saving.current = false; setBusy(false) }
  }

  function edit(model?: ManagedModel) {
    setOriginal(model?.id || ''); setDraft(model ? structuredClone(model) : blank())
    setSourceQuery(''); setError('')
  }
  const rows = (catalog?.models || []).filter(model => `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()))
  const sourceName = (id: string) => catalog?.sources.find(source => source.id === id)?.name || id
  const sourceRows = (catalog?.sources || []).flatMap(source => source.models.map(model => ({ source, model })))
    .filter(({ source, model }) => `${source.name} ${model.id} ${model.name || ''}`.toLowerCase().includes(sourceQuery.toLowerCase()))

  return <Card className='panel flex min-h-0 flex-1 flex-col'>
    <CardHeader className='panel-head flex flex-wrap items-center justify-between gap-3'>
      <div><h2 className='font-semibold'>{t('模型管理')}</h2>
        <p className='mt-1 text-xs text-subtle'>{t('手动添加对外模型，并选择渠道中的上游模型。获取上游清单不会自动发布模型。')}</p></div>
      <div className='flex items-center gap-2'>
        <Button variant='outline' disabled={busy} onClick={onSources}>{t('上游模型目录')}</Button>
        <Button variant='outline' disabled={busy} onClick={() => void load()}>{t('刷新')}</Button>
        <Button disabled={busy || !catalog} onClick={() => edit()}>{t('添加模型')}</Button>
      </div>
    </CardHeader>
    <div className='flex min-h-0 flex-1 flex-col gap-4 p-4'>
      <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索对外模型…')} aria-label={t('搜索对外模型')} />
      {error && !draft && !deleting && <Alert variant='destructive'>{error}</Alert>}
      <div className='min-h-0 flex-1 overflow-auto rounded border border-border'>
        <Table><TableHeader><TableRow>
          <TableHead>{t('对外模型 ID')}</TableHead><TableHead>{t('名称')}</TableHead>
          <TableHead>{t('渠道 / 上游模型')}</TableHead><TableHead>{t('启用')}</TableHead><TableHead>{t('操作')}</TableHead>
        </TableRow></TableHeader><TableBody>
          {rows.map(model => <TableRow key={model.id}>
            <TableCell className='font-mono'>{model.id}</TableCell><TableCell>{model.name || model.id}</TableCell>
            <TableCell><div className='flex flex-col gap-1'>{model.bindings.map(binding => <span key={binding.provider} className='text-xs'>
              {sourceName(binding.provider)} <span className='text-subtle'>→</span> <span className='font-mono'>{binding.model}</span>
            </span>)}</div></TableCell>
            <TableCell><Switch checked={model.enabled} disabled={busy} aria-label={`${t('启用')} ${model.id}`}
              onCheckedChange={enabled => void save({ ...model, enabled }, model.id)} /></TableCell>
            <TableCell><div className='flex gap-2'><Button size='sm' variant='ghost' disabled={busy} onClick={() => edit(model)}>{t('编辑')}</Button>
              <Button size='sm' variant='ghost' disabled={busy} onClick={() => { setError(''); setDeleting(model) }}>{t('删除')}</Button></div></TableCell>
          </TableRow>)}
          {!rows.length && <TableRow><TableCell colSpan={5} className='p-10 text-center text-subtle'>
            {busy ? t('加载中…') : query ? t('没有匹配的模型') : t('尚未添加对外模型。点击「添加模型」，选择渠道和上游模型后即可使用。')}
          </TableCell></TableRow>}
        </TableBody></Table>
      </div>
      {!!catalog?.routingGroups?.length && <p className='text-xs text-subtle'>
        {t('已创建的路由组也作为对外模型提供，可在路由配置中维护：')}
        {catalog.routingGroups.map(group => group.model).join('、')}
      </p>}
      <p className='text-xs text-subtle'>{t('网关 Key 只从已添加的对外模型中选择。停用或删除模型后，客户端不能再通过原名称调用。')}</p>
    </div>
    {draft && <Dialog open onOpenChange={open => { if (!open && !saving.current) setDraft(null) }}>
      <DialogContent className='max-w-[860px]'><DialogHeader><DialogTitle>{original ? t('编辑模型') : t('添加模型')}</DialogTitle></DialogHeader>
        <DialogBody className='gap-4'>
          <div className='grid gap-4 sm:grid-cols-2'>
            <div className='flex flex-col gap-2'><Label htmlFor='managed-model-id'>{t('对外模型 ID')}</Label>
              <Input id='managed-model-id' maxLength={128} value={draft.id} disabled={busy} placeholder='my-model'
                onChange={event => setDraft({ ...draft, id: event.target.value })} /></div>
            <div className='flex flex-col gap-2'><Label htmlFor='managed-model-name'>{t('显示名称')}</Label>
              <Input id='managed-model-name' maxLength={128} value={draft.name} disabled={busy}
                onChange={event => setDraft({ ...draft, name: event.target.value })} /></div>
          </div>
          <div className='flex items-center gap-2'><Switch checked={draft.enabled} disabled={busy} aria-label={t('启用模型')}
            onCheckedChange={enabled => setDraft({ ...draft, enabled })} /><span className='text-sm'>{t('启用模型')}</span></div>
          <Label>{t('选择渠道 / 上游模型')}</Label>
          <p className='text-xs text-subtle'>{t('可以关联多个渠道；每个渠道选择一个上游模型，同一渠道改选时会替换之前的选择。')}</p>
          <div className='flex flex-wrap gap-2'>{draft.bindings.map(binding => <Badge key={binding.provider} variant='secondary'>
            {sourceName(binding.provider)} / {binding.model}
            <button type='button' disabled={busy} className='ml-2' aria-label={`${t('移除')} ${binding.model}`}
              onClick={() => setDraft({ ...draft, bindings: upsertBinding(draft.bindings, binding.provider, '') })}>×</button>
          </Badge>)}</div>
          <Input value={sourceQuery} onChange={event => setSourceQuery(event.target.value)} placeholder={t('搜索渠道或上游模型…')} />
          <div className='max-h-[340px] overflow-auto rounded border border-border'>
            <Table><TableHeader><TableRow><TableHead>{t('选择')}</TableHead><TableHead>{t('渠道')}</TableHead><TableHead>{t('上游模型')}</TableHead></TableRow></TableHeader>
              <TableBody>{sourceRows.map(({ source, model }) => {
                const selected = draft.bindings.some(binding => binding.provider === source.id && binding.model === model.id)
                return <TableRow key={`${source.id}:${model.id}`}><TableCell><Checkbox checked={selected} disabled={busy}
                  aria-label={`${source.name} / ${model.id}`} onCheckedChange={checked => setDraft({ ...draft,
                    id: draft.id || (checked ? model.id : ''), bindings: upsertBinding(draft.bindings, source.id, checked ? model.id : '') })} /></TableCell>
                  <TableCell>{source.name}</TableCell><TableCell className='font-mono'>{model.id}</TableCell></TableRow>
              })}{!sourceRows.length && <TableRow><TableCell colSpan={3} className='p-6 text-center text-subtle'>{t('没有可选模型，请先在账号渠道中选择模型，或在上游模型目录中获取清单。')}</TableCell></TableRow>}</TableBody>
            </Table>
          </div>
          {error && <Alert variant='destructive'>{error}</Alert>}
        </DialogBody><DialogFooter>
          <Button variant='outline' disabled={busy} onClick={() => void load()}>{t('刷新候选')}</Button>
          <Button variant='outline' disabled={busy} onClick={() => setDraft(null)}>{t('取消')}</Button>
          <Button disabled={busy} onClick={() => void save(draft, original)}>{busy ? t('保存中…') : t('保存')}</Button>
        </DialogFooter></DialogContent>
    </Dialog>}
    {deleting && <Dialog open onOpenChange={open => { if (!open && !saving.current) setDeleting(null) }}>
      <DialogContent><DialogHeader><DialogTitle>{t('删除模型')}</DialogTitle></DialogHeader><DialogBody>
        <p>{t('删除后客户端将无法调用此对外模型，上游账号和模型清单会保留。')}</p><b>{deleting.id}</b>
        {error && <Alert variant='destructive'>{error}</Alert>}
      </DialogBody><DialogFooter><Button variant='outline' disabled={busy} onClick={() => setDeleting(null)}>{t('取消')}</Button>
        <Button variant='destructive' disabled={busy} onClick={() => void save(null, deleting.id)}>{t('删除')}</Button></DialogFooter></DialogContent>
    </Dialog>}
  </Card>
}
