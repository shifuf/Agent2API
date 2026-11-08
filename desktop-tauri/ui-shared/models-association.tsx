import { useMemo, useState } from 'react'
import { Badge, Button, Checkbox, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, SelectContent, SelectItem, SelectTrigger } from '@ui'
import { upsertBinding, type ManagedModel } from './managed-models'
import type { ModelCatalog, Translate } from './models-types'
import { ModelError } from './models-error'
import { ModelBrand } from './model-brand'

export function ModelAssociation({ model, catalog, busy, error, onSave, onClose, onRefresh, t }: {
  model: ManagedModel; catalog: ModelCatalog; busy: boolean; error: string
  onSave: (model: ManagedModel, previousId: string) => void; onClose: () => void; onRefresh: () => void; t: Translate
}) {
  const [bindings, setBindings] = useState(() => structuredClone(model.bindings))
  const [query, setQuery] = useState('')
  const sources = useMemo(() => catalog.sources.filter(source => source.accountCount > 0), [catalog.sources])
  const [provider, setProvider] = useState(() => sources.find(source => bindings.some(binding => binding.provider === source.id))?.id || sources[0]?.id || '')
  const source = sources.find(item => item.id === provider) || sources[0]
  const available = bindings.filter(binding => sources.some(item => item.id === binding.provider && item.models.some(upstream => upstream.id === binding.model)))
  const missing = bindings.filter(binding => !available.includes(binding))
  const visible = (source?.models || []).filter(upstream => `${upstream.id} ${upstream.name || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const remove = (id: string) => setBindings(current => current.filter(item => item.provider !== id))
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className='models-compact-dialog' style={{ width: 'min(640px, calc(100vw - 32px))' }} data-model-association>
      <DialogHeader><ModelBrand id={model.developer} icon={model.icon} size='large' />
        <div className='min-w-0'><DialogTitle>{t('关联渠道')}</DialogTitle><p className='mt-1 break-all font-mono text-xs text-subtle'>{model.id}</p></div></DialogHeader>
      <DialogBody>
        <ModelError error={error} busy={busy} onRefresh={onRefresh} t={t} />
        <p className='text-xs text-subtle'>{t('每个渠道选择一个上游模型。仅显示有账号的渠道；保存后仍需启用模型才会对外提供。')}</p>
        <div className='models-field'><Label htmlFor='model-association-provider'>{t('账号提供商')}</Label>
          <Select value={source?.id || null} disabled={busy || !sources.length} onValueChange={id => { if (id) { setProvider(id); setQuery('') } }}>
            <SelectTrigger id='model-association-provider' className='models-provider-trigger'>
              <span className='models-provider-label'>{source && <ModelBrand id={source.id} name={source.name} size='small' />}<span>{source?.name || t('选择账号提供商')}</span></span>
            </SelectTrigger>
            <SelectContent className='models-provider-options'>
              {sources.map(item => <SelectItem key={item.id} value={item.id} label={item.name} aria-label={item.name}>
                <span className='models-provider-label'><ModelBrand id={item.id} name={item.name} size='small' /><span>{item.name}</span>
                  <Badge variant='secondary'>{item.models.length}</Badge></span>
              </SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Input value={query} disabled={busy || !source} onChange={event => setQuery(event.target.value)} aria-label={t('搜索上游模型')} placeholder={t('搜索上游模型')} />
        <div className='models-association-list'>
          {source && visible.map(upstream => <label key={`${source.id}/${upstream.id}`} className='models-choice' data-selected={bindings.some(binding => binding.provider === source.id && binding.model === upstream.id) || undefined}>
            <Checkbox disabled={busy} checked={bindings.some(binding => binding.provider === source.id && binding.model === upstream.id)}
              onCheckedChange={checked => setBindings(current => upsertBinding(current, source.id, checked ? upstream.id : ''))} />
            <ModelBrand id={source.id} name={source.name} size='small' />
            <span className='min-w-0'><span className='block break-all font-mono'><span className='sr-only'>{source.name} / </span>{upstream.id}</span>
              {upstream.name && upstream.name !== upstream.id && <span aria-hidden='true' className='break-all text-xs text-subtle'>{upstream.name}</span>}</span>
          </label>)}
          {!visible.length && <p className='p-6 text-center text-subtle'>{source?.models.length ? t('没有匹配的上游模型') : t('没有可选的上游模型，请先在账号中添加渠道并选择支持的模型。')}</p>}
        </div>
        {available.length > 0 && <section className='models-associated-summary'>
          <p className='text-xs text-subtle'>{t('已选择 {n} 个渠道', { n: bindings.length })}</p>
          {available.map(binding => {
            const item = sources.find(item => item.id === binding.provider)!
            return <div key={binding.provider} className='models-associated-row'>
              <ModelBrand id={item.id} name={item.name} size='small' />
              <span className='min-w-0 flex-1'><span className='block break-words text-xs'>{item.name}</span><span className='block break-all font-mono text-xs text-subtle'>{binding.model}</span></span>
              <Button size='sm' variant='ghost' disabled={busy} aria-label={`${t('移除')} ${item.name} / ${binding.model}`} onClick={() => remove(binding.provider)}>{t('移除')}</Button>
            </div>
          })}
        </section>}
        {missing.length > 0 && <section className='rounded border border-border p-3'>
          <p className='mb-2 text-xs text-subtle'>{t('以下关联暂时不可用，仍会保留；可手动移除。')}</p>
          {missing.map(binding => <div key={binding.provider} className='flex items-center justify-between gap-2 text-xs'>
            <span className='break-all'>{catalog.sources.find(source => source.id === binding.provider)?.name || binding.provider} / {binding.model}</span>
            <Button size='sm' variant='ghost' disabled={busy} onClick={() => remove(binding.provider)}>{t('移除')}</Button>
          </div>)}
        </section>}
      </DialogBody>
      <DialogFooter><span className='mr-auto text-xs text-subtle'>{t('已选择 {n} 个渠道', { n: bindings.length })}</span>
        <Button disabled={busy} variant='outline' onClick={onClose}>{t('取消')}</Button>
        <Button disabled={busy} onClick={() => onSave({ ...model, bindings }, model.id)}>{t('保存关联')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

