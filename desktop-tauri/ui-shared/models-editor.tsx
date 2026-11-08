import { useState } from 'react'
import { Alert, Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Label, Select, SelectContent, SelectItem, SelectTrigger, Textarea } from '@ui'
import { modelFromCandidate, type ManagedModel } from './managed-models'
import { ModelBrand } from './model-brand'
import { ModelError } from './models-error'
import { ModelIdPicker } from './models-id-picker'
import { type ModelCatalog, type Translate } from './models-types'
import type { usePublicModelCatalog } from './public-model-picker'

export function ModelEditor({ initial, previousId, catalog, directory, busy, error, onSave, onClose, onExisting, onRefresh, t }: {
  initial: ManagedModel; previousId: string; catalog: ModelCatalog; directory: ReturnType<typeof usePublicModelCatalog>
  busy: boolean; error: string; onSave: (model: ManagedModel, previousId: string) => void; onClose: () => void
  onExisting: (model: ManagedModel) => void; onRefresh: () => void; t: Translate
}) {
  const [draft, setDraft] = useState(() => structuredClone(initial))
  const developers = new Map((directory.catalog?.providers || []).map(item => [item.id, item.name]))
  for (const model of catalog.models) if (model.developer && !developers.has(model.developer)) developers.set(model.developer, model.developer)
  if (draft.developer && !developers.has(draft.developer)) developers.set(draft.developer, draft.developer)
  developers.set('custom', t('自定义'))
  const update = (values: Partial<ManagedModel>) => setDraft(current => ({ ...current, ...values }))
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className='models-compact-dialog' style={{ width: 'min(560px, calc(100vw - 32px))' }} data-model-editor>
      <DialogHeader><ModelBrand id={draft.developer} name={developers.get(draft.developer || 'custom')} size='large' />
        <div className='min-w-0'><DialogTitle>{previousId ? t('编辑模型') : t('添加模型')}</DialogTitle>
          <p className='mt-1 text-xs text-subtle'>{t('先创建模型，再独立关联渠道。新模型默认停用。')}</p></div></DialogHeader>
      <DialogBody className='min-w-0'>
        <ModelError error={error} busy={busy} onRefresh={onRefresh} t={t} />
        <fieldset disabled={busy} className='models-editor-grid'>
          <section className='models-basic-fields'>
            <div className='models-field'><div className='flex flex-wrap items-center justify-between gap-2'><Label htmlFor='managed-model-developer'>{t('开发者 / 厂商')}</Label>
              <Button size='sm' variant='ghost' disabled={directory.loading} onClick={() => void directory.refresh()}>{directory.loading ? t('加载中…') : t('更新模型目录')}</Button></div>
              <Select value={draft.developer || 'custom'} disabled={busy} onValueChange={value => { if (value) update({ developer: value }) }}>
                <SelectTrigger id='managed-model-developer' className='models-provider-trigger'>
                  <span className='models-provider-label'><ModelBrand id={draft.developer} name={developers.get(draft.developer || 'custom')} size='small' />
                    <span>{developers.get(draft.developer || 'custom')}</span></span>
                </SelectTrigger>
                <SelectContent className='models-provider-options'>
                  {[...developers].map(([id, name]) => <SelectItem key={id} value={id} label={name} aria-label={name}>
                    <span className='models-provider-label'><ModelBrand id={id} name={name} size='small' /><span>{name}</span></span>
                  </SelectItem>)}
                </SelectContent>
              </Select></div>
            {directory.error && <Alert variant='warning'>{directory.catalog?.providers.length
              ? t('目录更新失败，继续使用已缓存的模型。') : t('模型目录暂时无法加载，请重试或填写自定义模型 ID。')}</Alert>}
            <div className='models-field'><Label htmlFor='managed-model-id'>{t('对外模型 ID')}</Label>
              <ModelIdPicker key={draft.developer || 'custom'} value={draft.id} developer={draft.developer || 'custom'} catalog={catalog} directory={directory} disabled={busy} t={t}
                onChange={id => update({ id })} onSelect={candidate => {
                  if (candidate.existing) {
                    if (candidate.existing.id !== previousId) onExisting(candidate.existing)
                    else update({ id: candidate.existing.id })
                  } else setDraft(current => modelFromCandidate(current, candidate))
                }} />
              <p className='text-xs text-subtle'>{t('可直接输入自定义模型 ID。')}</p></div>
            <div className='models-field'><Label htmlFor='managed-model-remark'>{t('备注')}</Label><Textarea id='managed-model-remark' rows={3} value={draft.remark || ''} maxLength={4000} onChange={event => update({ remark: event.target.value })} /></div>
            <p className='text-xs text-subtle'>{t('已关联 {n} 个渠道；可在列表的「关联渠道」中维护。', { n: draft.bindings.length })}</p>
          </section>
        </fieldset>
      </DialogBody>
      <DialogFooter><Button variant='outline' disabled={busy} onClick={onClose}>{t('取消')}</Button><Button disabled={busy} onClick={() => onSave(draft, previousId)}>{busy ? t('保存中…') : t('保存')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

