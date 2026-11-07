import * as React from 'react'
import { Badge, Button, Checkbox, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, type MultiSelectOption } from '@ui'
import { t } from '../i18n'
import { channelOptions, hiddenSelections, modelOptions, pickedFromOptions, retainHiddenSelections, type KeyRestrictions, type ProviderOption } from './keys-data'

type SelectionProps = {
  kind: 'channels' | 'models'
  values: string[]
  options: MultiSelectOption[]
  emptyHint: string
  onConfirm(values: string[]): void
  onClose(): void
}

/** Changes stay inside this dialog until confirmed, including removals of old restrictions. */
function KeySelectionDialog({ kind, values, options, emptyHint, onConfirm, onClose }: SelectionProps) {
  const [draft, setDraft] = React.useState(() => [...values])
  const [query, setQuery] = React.useState('')
  const search = query.trim().toLowerCase()
  const visible = options.filter(option => `${option.label} ${option.value}`.toLowerCase().includes(search))
  const hidden = hiddenSelections(draft, options)
  const selected = new Set(draft.map(value => value.toLowerCase()))
  const title = kind === 'channels' ? t('选择可用渠道') : t('选择可用模型')
  function toggle(value: string, checked: boolean): void {
    setDraft(current => checked ? pickedFromOptions([...current, value], options)
      : current.filter(item => item.toLowerCase() !== value.toLowerCase()))
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent overlayForceRender data-key-selection={kind} className='w-[min(720px,calc(100vw-32px))]'>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <DialogBody>
        <Input autoFocus aria-label={kind === 'channels' ? t('搜索渠道') : t('搜索模型')}
          placeholder={kind === 'channels' ? t('搜索渠道…') : t('搜索模型…')} value={query} onChange={event => setQuery(event.target.value)} />
        <div className='flex flex-wrap items-center gap-2'>
          <span className='mr-auto text-xs text-subtle'>{t('已选择 {n} 项', { n: draft.length })}</span>
          <Button size='sm' variant='outline' disabled={!visible.length}
            onClick={() => setDraft(current => pickedFromOptions([...current, ...visible.map(option => option.value)], options))}>{t('全选结果')}</Button>
          <Button size='sm' variant='ghost' onClick={() => setDraft(current => retainHiddenSelections(current, [], options))}>{t('清空可选项')}</Button>
        </div>
        <div className='grid max-h-[280px] grid-cols-1 gap-1 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-2'>
          {visible.map(option => <label key={option.value} className='flex min-w-0 cursor-pointer items-start gap-2 rounded px-2 py-2 hover:bg-surface-2'>
            <Checkbox checked={selected.has(option.value.toLowerCase())} onCheckedChange={checked => toggle(option.value, checked)} className='mt-0.5' />
            <span className='min-w-0 break-all text-sm'>{option.label}
              {kind === 'channels' && option.value !== option.label && <span aria-hidden='true' className='mt-0.5 block text-xs text-subtle'>{option.value}</span>}
            </span>
          </label>)}
          {!visible.length && <p className='col-span-full p-4 text-center text-xs text-subtle'>{options.length ? t('没有匹配的选项') : emptyHint}</p>}
        </div>
        <div className='space-y-2' data-key-selection-preview>
          <div className='text-xs font-medium'>{t('已选预览')}</div>
          <div className='flex max-h-[140px] flex-wrap gap-1.5 overflow-y-auto'>
            {draft.filter(value => !hidden.includes(value)).map(value => <Badge key={value} variant='secondary' className='max-w-full whitespace-normal break-all'>
              {options.find(option => option.value.toLowerCase() === value.toLowerCase())?.label || value}
            </Badge>)}
            {!draft.length && <p className='text-xs text-subtle'>{kind === 'channels' ? t('未选择 = 全部渠道') : t('未选择 = 全部已发布模型')}</p>}
          </div>
        </div>
        {!!hidden.length && <div className='space-y-2 rounded-md border border-border p-3' data-key-hidden-restrictions>
          <p className='text-xs text-subtle'>{t('以下已保存的限制当前不可用，仍会保留；可手动移除。')}</p>
          {hidden.map(value => <div key={value} className='flex min-w-0 items-center gap-2'>
            <code className='min-w-0 flex-1 break-all text-xs'>{value}</code>
            <Button size='sm' variant='ghost' aria-label={`${kind === 'channels' ? t('移除渠道限制') : t('移除模型限制')} ${value}`}
              onClick={() => toggle(value, false)}>{t('移除')}</Button>
          </div>)}
        </div>}
      </DialogBody>
      <DialogFooter>
        <Button variant='outline' onClick={onClose}>{t('取消')}</Button>
        <Button onClick={() => onConfirm(pickedFromOptions(draft, options))}>{t('确认选择')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function KeyScopeFields({ value, onChange, providers, modelsByProvider, disabled = false }: {
  value: KeyRestrictions
  onChange(value: KeyRestrictions): void
  providers: ProviderOption[]
  modelsByProvider: Record<string, string[]>
  disabled?: boolean
}) {
  const [selection, setSelection] = React.useState<'channels' | 'models' | null>(null)
  const channels = channelOptions(providers)
  const models = modelOptions(modelsByProvider, value.allowedProviders)
  const summaries = [
    { kind: 'channels' as const, title: t('可用渠道'), label: t('选择渠道'), values: value.allowedProviders, options: channels, empty: t('未选择 = 全部渠道') },
    { kind: 'models' as const, title: t('可用模型'), label: t('选择模型'), values: value.allowedModels, options: models, empty: t('未选择 = 全部已发布模型') },
  ]
  return <>
    <div className='space-y-3'>
      {summaries.map(item => <section key={item.kind} className='space-y-2 rounded-md border border-border bg-surface-inset p-3' data-key-scope={item.kind}>
        <div className='flex items-center justify-between gap-2'><h3 className='text-sm font-medium'>{item.title}</h3>
          <Button size='sm' variant='outline' disabled={disabled} onClick={() => setSelection(item.kind)}>{item.label}</Button>
        </div>
        <div className='flex max-h-[130px] flex-wrap gap-1.5 overflow-y-auto'>
          {item.values.map(id => {
            const option = item.options.find(candidate => candidate.value.toLowerCase() === id.toLowerCase())
            return <Badge key={id} variant={option ? 'secondary' : 'warning'} className='max-w-full whitespace-normal break-all'>
              {option?.label || id}{!option && <span className='ml-1'>{t('当前不可用')}</span>}
            </Badge>
          })}
          {!item.values.length && <span className='text-xs text-subtle'>{item.empty}</span>}
        </div>
      </section>)}
      <p className='text-xs leading-relaxed text-subtle'>{t('未选择渠道表示允许全部渠道；未选择模型表示允许全部已发布模型。同时选择时按交集生效。模型候选来自模型管理中手动添加的目录，并按所选渠道筛选。')}</p>
    </div>
    {selection && <KeySelectionDialog key={selection} kind={selection} values={selection === 'channels' ? value.allowedProviders : value.allowedModels}
      options={selection === 'channels' ? channels : models}
      emptyHint={selection === 'channels' ? t('暂无可用渠道，请先在账号页添加账号或渠道') : value.allowedProviders.length
        ? t('所选渠道暂无已发布模型，请先在模型管理中添加并关联上游模型') : t('暂无已发布模型，请先在模型管理中手动添加')}
      onClose={() => setSelection(null)} onConfirm={next => {
        onChange({ ...value, ...(selection === 'channels' ? { allowedProviders: next } : { allowedModels: next }) })
        setSelection(null)
      }} />}
  </>
}
