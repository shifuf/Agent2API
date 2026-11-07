import { useState } from 'react'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label, Textarea } from '@ui'
import { modelFromCandidate, type ManagedModel, type ModelType } from './managed-models'
import { ModelCardFields } from './models-card-fields'
import { ModelError } from './models-error'
import { modelTypeOptions, type ModelCatalog, type Translate } from './models-types'
import { PublicModelPicker, type usePublicModelCatalog } from './public-model-picker'

export function ModelEditor({ initial, previousId, catalog, directory, busy, error, onSave, onClose, onExisting, onRefresh, t }: {
  initial: ManagedModel; previousId: string; catalog: ModelCatalog; directory: ReturnType<typeof usePublicModelCatalog>
  busy: boolean; error: string; onSave: (model: ManagedModel, previousId: string) => void; onClose: () => void
  onExisting: (model: ManagedModel) => void; onRefresh: () => void; t: Translate
}) {
  const [draft, setDraft] = useState(() => structuredClone(initial))
  const [picker, setPicker] = useState(false)
  const [cardRevision, setCardRevision] = useState(0)
  const developers = new Map((directory.catalog?.providers || []).map(item => [item.id, item.name]))
  for (const model of catalog.models) if (model.developer && !developers.has(model.developer)) developers.set(model.developer, model.developer)
  if (draft.developer && !developers.has(draft.developer)) developers.set(draft.developer, draft.developer)
  developers.set('custom', t('自定义'))
  const update = (values: Partial<ManagedModel>) => setDraft(current => ({ ...current, ...values }))
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent style={{ width: 'min(1080px, calc(100vw - 32px))' }} data-model-editor>
      <DialogHeader><DialogTitle>{previousId ? t('编辑模型') : t('添加模型')}</DialogTitle></DialogHeader>
      <DialogBody className='min-w-0'>
        <ModelError error={error} busy={busy} onRefresh={onRefresh} t={t} />
        <fieldset disabled={busy} className='models-editor-grid'>
          <section className='models-basic-fields'>
            <div><h3>{t('基本信息')}</h3><p className='text-xs text-subtle'>{t('先创建模型，再独立关联渠道。新模型默认停用。')}</p></div>
            <div className='models-field'><Label htmlFor='managed-model-developer'>{t('开发者 / 厂商')}</Label>
              <select id='managed-model-developer' value={draft.developer || 'custom'} onChange={event => update({ developer: event.target.value })}>
                {[...developers].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select></div>
            <div className='models-field'><div className='flex flex-wrap items-center justify-between gap-2'><Label htmlFor='managed-model-id'>{t('对外模型 ID')}</Label>
              <Button size='sm' variant='outline' onClick={() => setPicker(true)}>{t('从目录或上游选择')}</Button></div>
              <Input id='managed-model-id' value={draft.id} maxLength={128} placeholder='my-model' onChange={event => update({ id: event.target.value })} /></div>
            <div className='models-field'><Label htmlFor='managed-model-name'>{t('显示名称')}</Label><Input id='managed-model-name' value={draft.name} onChange={event => update({ name: event.target.value })} /></div>
            <div className='models-field-grid'>
              <div className='models-field'><Label htmlFor='managed-model-icon'>{t('图标标识')}</Label><Input id='managed-model-icon' value={draft.icon || ''} maxLength={128} onChange={event => update({ icon: event.target.value })} /></div>
              <div className='models-field'><Label htmlFor='managed-model-group'>{t('模型系列')}</Label><Input id='managed-model-group' value={draft.group || ''} maxLength={128} onChange={event => update({ group: event.target.value })} /></div>
            </div>
            <div className='models-field'><Label htmlFor='managed-model-type'>{t('模型类型')}</Label><select id='managed-model-type' value={draft.type || 'chat'} onChange={event => update({ type: event.target.value as ModelType })}>
              {modelTypeOptions(t).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select></div>
            <div className='models-field'><Label htmlFor='managed-model-remark'>{t('备注')}</Label><Textarea id='managed-model-remark' rows={3} value={draft.remark || ''} maxLength={4000} onChange={event => update({ remark: event.target.value })} /></div>
            <p className='text-xs text-subtle'>{t('已关联 {n} 个渠道；可在列表的「关联渠道」中维护。', { n: draft.bindings.length })}</p>
          </section>
          <ModelCardFields key={cardRevision} card={draft.modelCard || {}} onChange={modelCard => update({ modelCard })} t={t} />
        </fieldset>
      </DialogBody>
      <DialogFooter><Button variant='outline' disabled={busy} onClick={onClose}>{t('取消')}</Button><Button disabled={busy} onClick={() => onSave(draft, previousId)}>{busy ? t('保存中…') : t('保存')}</Button></DialogFooter>
    </DialogContent>
    {picker && <Dialog open onOpenChange={setPicker}>
      <DialogContent overlayForceRender style={{ width: 'min(760px, calc(100vw - 32px))' }}>
        <DialogHeader><DialogTitle>{t('选择模型')}</DialogTitle></DialogHeader>
        <DialogBody><PublicModelPicker state={directory} selectedId={draft.id} sources={catalog.sources} saved={catalog.models} t={t}
          initialManufacturer={directory.catalog?.providers.some(provider => provider.id === draft.developer) ? draft.developer : ''}
          onSelect={(_model, existing, candidate) => {
            setPicker(false)
            if (existing) { if (existing.id !== previousId) onExisting(existing) }
            else if (candidate) { setDraft(current => modelFromCandidate(current, candidate)); setCardRevision(value => value + 1) }
          }} /></DialogBody>
        <DialogFooter><Button variant='outline' onClick={() => setPicker(false)}>{t('取消')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>}
  </Dialog>
}

