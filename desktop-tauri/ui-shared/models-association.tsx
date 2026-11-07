import { useMemo, useState } from 'react'
import { Badge, Button, Checkbox, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input } from '@ui'
import { upsertBinding, type ManagedModel } from './managed-models'
import type { ModelCatalog, Translate } from './models-types'
import { ModelError } from './models-error'

export function ModelAssociation({ model, catalog, busy, error, onSave, onClose, onRefresh, t }: {
  model: ManagedModel; catalog: ModelCatalog; busy: boolean; error: string
  onSave: (model: ManagedModel, previousId: string) => void; onClose: () => void; onRefresh: () => void; t: Translate
}) {
  const [bindings, setBindings] = useState(() => structuredClone(model.bindings))
  const [query, setQuery] = useState('')
  const rows = useMemo(() => catalog.sources.filter(source => source.accountCount > 0).flatMap(source => source.models.map(upstream => ({ source, upstream }))), [catalog])
  const missing = bindings.filter(binding => !rows.some(row => row.source.id === binding.provider && row.upstream.id === binding.model))
  const visible = rows.filter(({ source, upstream }) => `${source.name} ${upstream.id} ${upstream.name || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent style={{ width: 'min(840px, calc(100vw - 32px))' }} data-model-association>
      <DialogHeader><DialogTitle>{t('关联渠道')}</DialogTitle><Badge variant='secondary'>{model.id}</Badge></DialogHeader>
      <DialogBody>
        <ModelError error={error} busy={busy} onRefresh={onRefresh} t={t} />
        <p className='text-xs text-subtle'>{t('每个渠道选择一个上游模型。仅显示有账号的渠道；保存后仍需启用模型才会对外提供。')}</p>
        <Input value={query} onChange={event => setQuery(event.target.value)} aria-label={t('搜索渠道及上游模型')} placeholder={t('搜索渠道及上游模型')} />
        <div className='models-association-list'>
          {visible.map(({ source, upstream }) => <label key={`${source.id}/${upstream.id}`} className='models-choice'>
            <Checkbox disabled={busy} checked={bindings.some(binding => binding.provider === source.id && binding.model === upstream.id)}
              onCheckedChange={checked => setBindings(current => upsertBinding(current, source.id, checked ? upstream.id : ''))} />
            <span className='min-w-0'><span className='block break-all'>{source.name} / {upstream.id}</span>
              {upstream.name && upstream.name !== upstream.id && <span aria-hidden='true' className='text-xs text-subtle'>{upstream.name}</span>}</span>
          </label>)}
          {!visible.length && <p className='p-6 text-center text-subtle'>{t('没有可选的上游模型，请先在账号中添加渠道并选择支持的模型。')}</p>}
        </div>
        {missing.length > 0 && <section className='rounded border border-border p-3'>
          <p className='mb-2 text-xs text-subtle'>{t('以下关联暂时不可用，仍会保留；可手动移除。')}</p>
          {missing.map(binding => <div key={binding.provider} className='flex items-center justify-between gap-2 text-xs'>
            <span className='break-all'>{catalog.sources.find(source => source.id === binding.provider)?.name || binding.provider} / {binding.model}</span>
            <Button size='sm' variant='ghost' disabled={busy} onClick={() => setBindings(current => current.filter(item => item.provider !== binding.provider))}>{t('移除')}</Button>
          </div>)}
        </section>}
      </DialogBody>
      <DialogFooter><span className='mr-auto text-xs text-subtle'>{t('已选择 {n} 个渠道', { n: bindings.length })}</span>
        <Button disabled={busy} variant='outline' onClick={onClose}>{t('取消')}</Button>
        <Button disabled={busy} onClick={() => onSave({ ...model, bindings }, model.id)}>{t('保存关联')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

