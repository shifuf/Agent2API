import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ui'
import { blankManagedModel, filterManagedModels, managedModelStatus, validateManagedModel, type ManagedModel, type ModelStatus } from './managed-models'
import { usePublicModelCatalog } from './public-model-picker'
import type { PublicModelCatalog } from './public-model-catalog'
import { ModelEditor } from './models-editor'
import { ModelAssociation } from './models-association'
import { ModelBatch } from './models-batch'
import { ModelError } from './models-error'
import { modelTypeOptions, type ModelAction, type ModelCatalog, type ModelRequest, type Translate } from './models-types'
import './models-workspace.css'

export function ModelsWorkspace({ request, onSources, onChanged, t }: {
  request: ModelRequest; onSources: () => void; onChanged?: () => void; t: Translate
}) {
  const fetchDirectory = useCallback((refresh: boolean) => request(refresh ? 'POST' : 'GET', '/api/models/public-catalog') as Promise<PublicModelCatalog>, [request])
  const directory = usePublicModelCatalog(fetchDirectory)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [query, setQuery] = useState('')
  const [developer, setDeveloper] = useState('')
  const [status, setStatus] = useState<ModelStatus | ''>('')
  const [sort, setSort] = useState('id')
  const [unassociated, setUnassociated] = useState(false)
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<{ model: ManagedModel; previousId: string; key: number } | null>(null)
  const [association, setAssociation] = useState<ManagedModel | null>(null)
  const [batch, setBatch] = useState(false)
  const [confirmation, setConfirmation] = useState<{ action: 'archive' | 'delete'; ids: string[] } | null>(null)
  const saving = useRef(false)
  const generation = useRef(0)
  const editCounter = useRef(0)
  const load = useCallback(async () => {
    if (saving.current) return
    const ticket = ++generation.current
    setBusy(true); setError('')
    try {
      const next = await request('GET', '/api/models/catalog') as ModelCatalog
      if (ticket === generation.current) { setCatalog(next); setSelected(current => current.filter(id => next.models.some(model => model.id === id))) }
    } catch (cause) { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (ticket === generation.current) setBusy(false) }
  }, [request])
  useEffect(() => { void load(); return () => { generation.current++ } }, [load])
  async function write(body: Record<string, unknown>) {
    if (!catalog || saving.current) return
    saving.current = true; const ticket = ++generation.current
    setBusy(true); setError('')
    try {
      const next = await request('POST', '/api/models/catalog', { ...body, revision: catalog.revision }) as ModelCatalog
      if (ticket !== generation.current) return
      setCatalog(next); setEditor(null); setAssociation(null); setBatch(false); setConfirmation(null); setSelected([])
      onChanged?.()
    } catch (cause) { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { saving.current = false; if (ticket === generation.current) setBusy(false) }
  }
  function save(model: ManagedModel, previousId: string) {
    const invalid = validateManagedModel(model)
    if (invalid) { setError(invalid === 'id' ? t('请填写有效的对外模型 ID') : t('请选择渠道及其上游模型')); return }
    void write({ model, previousId })
  }
  function edit(model?: ManagedModel) {
    setError(''); setEditor({ model: model || blankManagedModel(), previousId: model?.id || '', key: ++editCounter.current })
  }
  function action(action: ModelAction, ids: string[]) {
    setError('')
    if (action === 'archive' || action === 'delete') setConfirmation({ action, ids })
    else void write({ action, ids })
  }
  const allModels = catalog?.models || []
  const rows = useMemo(() => filterManagedModels(catalog?.models || [], { query, developer, status })
    .filter(model => !unassociated || model.bindings.length === 0)
    .sort((a, b) => (sort === 'name' ? a.name || a.id : a.id).localeCompare(sort === 'name' ? b.name || b.id : b.id)), [catalog, query, developer, status, sort, unassociated])
  const developers = new Map((directory.catalog?.providers || []).map(item => [item.id, item.name]))
  developers.set('custom', t('自定义'))
  const groups = new Map<string, ManagedModel[]>()
  for (const model of rows) { const id = model.developer || 'custom'; groups.set(id, [...groups.get(id) || [], model]) }
  const knownDevelopers = [...new Set(allModels.map(model => model.developer || 'custom'))].sort()
  const typeLabels = modelTypeOptions(t)
  const statusLabel = (model: ManagedModel) => model.archived ? t('已归档') : model.enabled ? t('已启用') : t('已停用')
  const close = () => { setEditor(null); setAssociation(null); setBatch(false); setConfirmation(null); setError('') }
  return <Card className='panel models-workspace' data-model-workspace>
    <CardHeader className='panel-head models-heading'>
      <div><h2 className='font-semibold'>{t('模型管理')}</h2><p className='mt-1 text-xs text-subtle'>{t('管理对外模型资料与渠道关联，按开发者分组查看。')}</p></div>
      <div className='models-actions'>
        <Button variant={unassociated ? 'secondary' : 'outline'} aria-pressed={unassociated} disabled={busy} onClick={() => setUnassociated(value => !value)}>{t('未关联模型')}</Button>
        <Button variant='outline' disabled={busy || !catalog} onClick={() => { setError(''); setBatch(true) }}>{t('批量添加')}</Button>
        <Button disabled={busy || !catalog} onClick={() => edit()}>{t('添加模型')}</Button>
      </div>
    </CardHeader>
    <div className='models-workspace-body'>
      <div className='models-toolbar'>
        <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索模型、厂商或渠道…')} aria-label={t('搜索对外模型')} />
        <select aria-label={t('筛选厂商')} value={developer} onChange={event => setDeveloper(event.target.value)}><option value=''>{t('全部厂商')}</option>
          {knownDevelopers.map(id => <option key={id} value={id}>{developers.get(id) || id}</option>)}</select>
        <select aria-label={t('模型状态')} value={status} onChange={event => setStatus(event.target.value as ModelStatus | '')}><option value=''>{t('全部状态')}</option>
          <option value='enabled'>{t('已启用')}</option><option value='disabled'>{t('已停用')}</option><option value='archived'>{t('已归档')}</option></select>
        <select aria-label={t('模型排序')} value={sort} onChange={event => setSort(event.target.value)}><option value='id'>{t('按模型 ID')}</option><option value='name'>{t('按名称')}</option></select>
        <Button size='sm' variant='outline' disabled={busy} onClick={() => void load()}>{t('刷新')}</Button>
        <Button size='sm' variant='ghost' disabled={busy} onClick={onSources}>{t('上游模型目录')}</Button>
      </div>
      {error && !editor && !association && !batch && !confirmation && <Alert variant='destructive'>{error}</Alert>}
      {!!selected.length && <div className='models-selection-toolbar'><span>{t('已选择 {n} 个模型', { n: selected.length })}</span>
        <Button size='sm' variant='outline' disabled={busy || selected.some(id => allModels.find(model => model.id === id)?.archived)} onClick={() => action('enable', selected)}>{t('批量启用')}</Button>
        <Button size='sm' variant='outline' disabled={busy} onClick={() => action('disable', selected)}>{t('批量停用')}</Button>
        <Button size='sm' variant='outline' disabled={busy} onClick={() => action('archive', selected)}>{t('批量归档')}</Button>
        <Button size='sm' variant='outline' disabled={busy} onClick={() => action('delete', selected)}>{t('批量删除')}</Button>
        <Button size='sm' variant='ghost' disabled={busy} onClick={() => setSelected([])}>{t('清空选择')}</Button>
      </div>}
      <div className='models-table-wrap'>
        <Table><TableHeader><TableRow>
          <TableHead><Checkbox aria-label={t('选择当前结果')} disabled={busy || !rows.length} checked={!!rows.length && rows.every(model => selected.includes(model.id))}
            onCheckedChange={checked => setSelected(current => checked ? [...new Set([...current, ...rows.map(model => model.id)])] : current.filter(id => !rows.some(model => model.id === id)))} /></TableHead>
          <TableHead>{t('名称')}</TableHead><TableHead>{t('对外模型 ID')}</TableHead><TableHead>{t('模型类型')}</TableHead>
          <TableHead>{t('状态')}</TableHead><TableHead>{t('关联渠道')}</TableHead><TableHead>{t('操作')}</TableHead>
        </TableRow></TableHeader><TableBody>
          {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([id, models]) => <Fragment key={id}>
            <TableRow className='models-developer-row'><TableCell colSpan={7}><button className='models-group-toggle' type='button' aria-expanded={!collapsed.includes(id)}
              onClick={() => setCollapsed(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])}>
              <span aria-hidden='true'>{collapsed.includes(id) ? '▸' : '▾'}</span>{developers.get(id) || id}<Badge variant='secondary'>{models.length}</Badge>
            </button></TableCell></TableRow>
            {!collapsed.includes(id) && models.map(model => <TableRow key={model.id} data-model-row={model.id}>
              <TableCell><Checkbox aria-label={`${t('选择')} ${model.id}`} disabled={busy} checked={selected.includes(model.id)} onCheckedChange={checked => setSelected(current => checked ? [...new Set([...current, model.id])] : current.filter(id => id !== model.id))} /></TableCell>
              <TableCell><div className='models-name'><span className='models-avatar' title={model.icon || model.developer || 'custom'} aria-hidden='true'>{(model.developer || model.name || model.id).slice(0, 1).toUpperCase()}</span>
                <div className='min-w-0'><span className='block break-words font-medium'>{model.name || model.id}</span>{model.group && <span className='text-xs text-subtle'>{model.group}</span>}</div></div></TableCell>
              <TableCell className='models-id'>{model.id}</TableCell>
              <TableCell><Badge variant='secondary'>{typeLabels.find(option => option.id === model.type)?.label || t('对话')}</Badge>
                {model.modelCard?.toolCall && <span className='mt-1 block text-xs text-subtle'>{t('工具调用')}</span>}</TableCell>
              <TableCell><div className='flex items-center gap-2'><Switch checked={managedModelStatus(model) === 'enabled'} disabled={busy || !!model.archived} aria-label={`${t('启用')} ${model.id}`}
                onCheckedChange={checked => action(checked ? 'enable' : 'disable', [model.id])} /><span className='text-xs text-subtle'>{statusLabel(model)}</span></div></TableCell>
              <TableCell><Button size='sm' variant='outline' aria-label={`${t('关联渠道')} ${model.id}`} disabled={busy} onClick={() => { setError(''); setAssociation(model) }}>{model.bindings.length ? t('{n} 个渠道', { n: model.bindings.length }) : t('未关联')}</Button></TableCell>
              <TableCell><div className='models-row-actions'><Button size='sm' variant='ghost' aria-label={`${t('编辑')} ${model.id}`} disabled={busy} onClick={() => edit(model)}>{t('编辑')}</Button>
                <Button size='sm' variant='ghost' aria-label={`${model.archived ? t('恢复') : t('归档')} ${model.id}`} disabled={busy} onClick={() => action(model.archived ? 'restore' : 'archive', [model.id])}>{model.archived ? t('恢复') : t('归档')}</Button>
                <Button size='sm' variant='ghost' aria-label={`${t('删除')} ${model.id}`} disabled={busy} onClick={() => action('delete', [model.id])}>{t('删除')}</Button></div></TableCell>
            </TableRow>)}
          </Fragment>)}
          {!rows.length && <TableRow><TableCell colSpan={7} className='p-10 text-center text-subtle'>{busy ? t('加载中…') : allModels.length ? t('没有匹配的模型') : t('尚未添加模型。可从厂商目录或账号上游选择，也可填写自定义模型。')}</TableCell></TableRow>}
        </TableBody></Table>
      </div>
      <div className='models-footer'><span>{t('共 {n} 个模型', { n: rows.length })}</span><span>{t('网关 Key 仅显示已启用且有可用渠道的模型。')}</span></div>
      {!!catalog?.routingGroups?.length && <p className='text-xs text-subtle'>{t('已创建的路由组也作为对外模型提供，可在路由配置中维护：')}{catalog.routingGroups.map(group => group.model).join('、')}</p>}
    </div>
    {editor && catalog && <ModelEditor key={editor.key} initial={editor.model} previousId={editor.previousId} catalog={catalog} directory={directory} busy={busy} error={error} onSave={save} onClose={close} onExisting={edit} onRefresh={() => void load()} t={t} />}
    {association && catalog && <ModelAssociation model={association} catalog={catalog} busy={busy} error={error} onSave={save} onClose={close} onRefresh={() => void load()} t={t} />}
    {batch && catalog && <ModelBatch catalog={catalog} directory={directory} busy={busy} error={error} onClose={close} onCreate={models => void write({ action: 'create', models })} onRefresh={() => void load()} t={t} />}
    {confirmation && <Dialog open onOpenChange={open => { if (!open && !busy) close() }}><DialogContent>
      <DialogHeader><DialogTitle>{confirmation.action === 'archive' ? t('归档模型') : t('删除模型')}</DialogTitle></DialogHeader>
      <DialogBody><ModelError error={error} busy={busy} onRefresh={() => void load()} t={t} /><p>{confirmation.action === 'archive' ? t('归档后模型将停止提供服务，关联信息会保留。') : t('删除后无法通过原模型 ID 调用，相关 Key 限制不会自动移除。')}</p>
        <p className='break-all font-mono text-xs'>{confirmation.ids.join(', ')}</p></DialogBody>
      <DialogFooter><Button variant='outline' disabled={busy} onClick={close}>{t('取消')}</Button><Button variant='destructive' disabled={busy} onClick={() => void write(confirmation)}>{confirmation.action === 'archive' ? t('确认归档') : t('确认删除')}</Button></DialogFooter>
    </DialogContent></Dialog>}
  </Card>
}
