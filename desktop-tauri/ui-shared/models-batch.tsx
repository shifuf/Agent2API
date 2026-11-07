import { useMemo, useState } from 'react'
import { Alert, Badge, Button, Checkbox, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input } from '@ui'
import { blankManagedModel, modelFromCandidate, type ManagedModel } from './managed-models'
import { modelCandidates, type ModelCandidate } from './public-model-catalog'
import type { usePublicModelCatalog } from './public-model-picker'
import type { ModelCatalog, Translate } from './models-types'
import { ModelError } from './models-error'

export function ModelBatch({ catalog, directory, busy, error, onCreate, onClose, onRefresh, t }: {
  catalog: ModelCatalog; directory: ReturnType<typeof usePublicModelCatalog>; busy: boolean; error: string
  onCreate: (models: ManagedModel[]) => void; onClose: () => void; onRefresh: () => void; t: Translate
}) {
  const [query, setQuery] = useState('')
  const [manufacturer, setManufacturer] = useState('')
  const [selected, setSelected] = useState<Map<string, ModelCandidate>>(() => new Map())
  const candidates = useMemo(() => {
    const seen = new Set(catalog.models.map(model => model.id.toLowerCase()))
    return modelCandidates(directory.catalog?.providers || [], catalog.sources, [], { origin: '', manufacturer, search: '' })
      .filter(row => { const id = row.model.id.toLowerCase(); if (seen.has(id)) return false; seen.add(id); return true })
  }, [catalog, directory.catalog, manufacturer])
  const rows = candidates.filter(row => `${row.model.id} ${row.model.name} ${row.labels.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  function select(rows: ModelCandidate[]) {
    setSelected(current => { const next = new Map(current); for (const row of rows) { if (next.size < 100 && !next.has(row.model.id.toLowerCase())) next.set(row.model.id.toLowerCase(), row) } return next })
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent style={{ width: 'min(860px, calc(100vw - 32px))' }} data-model-batch>
      <DialogHeader><DialogTitle>{t('批量添加模型')}</DialogTitle></DialogHeader>
      <DialogBody>
        <ModelError error={error} busy={busy} onRefresh={onRefresh} t={t} />
        <p className='text-xs text-subtle'>{t('候选已去重并排除现有模型。每次最多添加 100 个，创建后为停用状态，可分别关联渠道。')}</p>
        {directory.error && <Alert variant='warning'>{t('目录更新失败，继续使用已缓存的模型。')}</Alert>}
        <div className='models-toolbar'><Input aria-label={t('搜索模型目录')} placeholder={t('搜索模型目录')} value={query} onChange={event => setQuery(event.target.value)} />
          <select aria-label={t('模型厂商')} value={manufacturer} onChange={event => setManufacturer(event.target.value)}><option value=''>{t('全部厂商')}</option>
            {(directory.catalog?.providers || []).map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>
          <Button variant='outline' size='sm' disabled={busy || directory.loading} onClick={() => void directory.refresh()}>{t('更新模型目录')}</Button>
        </div>
        <div className='flex flex-wrap items-center gap-2'><Button size='sm' variant='ghost' disabled={busy} onClick={() => select(rows)}>{t('全选结果')}</Button>
          <Button size='sm' variant='ghost' disabled={busy} onClick={() => setSelected(new Map())}>{t('清空选择')}</Button><Badge variant='secondary'>{selected.size} / 100</Badge></div>
        <div className='models-association-list'>
          {rows.map(row => <div className='models-choice' key={row.model.id}><Checkbox aria-label={`${t('添加')} ${row.model.id}`}
            checked={selected.has(row.model.id.toLowerCase())} disabled={busy || (!selected.has(row.model.id.toLowerCase()) && selected.size >= 100)}
            onCheckedChange={checked => { if (checked) select([row]); else setSelected(current => { const next = new Map(current); next.delete(row.model.id.toLowerCase()); return next }) }} />
            <span className='min-w-0'><span className='block break-all font-mono'>{row.model.id}</span><span className='text-xs text-subtle'>{row.labels.join(' · ')} · {row.model.name}</span></span>
          </div>)}
          {!rows.length && <p className='p-6 text-center text-subtle'>{directory.loading ? t('加载中…') : t('没有匹配的模型')}</p>}
        </div>
      </DialogBody>
      <DialogFooter><Button disabled={busy} variant='outline' onClick={onClose}>{t('取消')}</Button><Button disabled={busy || !selected.size}
        onClick={() => onCreate([...selected.values()].map(row => modelFromCandidate(blankManagedModel(), row)))}>{t('添加所选模型')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
