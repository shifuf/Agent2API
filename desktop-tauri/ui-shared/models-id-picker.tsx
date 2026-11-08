import { useMemo, useState } from 'react'
import { Combobox, Input } from '@ui'
import { modelCandidates, type ModelCandidate } from './public-model-catalog'
import type { ModelCatalog, Translate } from './models-types'
import type { usePublicModelCatalog } from './public-model-picker'
import { ModelBrand } from './model-brand'

export function ModelIdPicker({ value, developer, catalog, directory, disabled, onChange, onSelect, t }: {
  value: string; developer: string; catalog: ModelCatalog; directory: ReturnType<typeof usePublicModelCatalog>; disabled: boolean
  onChange: (id: string) => void; onSelect: (candidate: ModelCandidate) => void; t: Translate
}) {
  const [query, setQuery] = useState('')
  const rows = useMemo(() => modelCandidates(directory.catalog?.providers || [], catalog.sources, catalog.models,
    { origin: '', manufacturer: developer, search: query }), [directory.catalog, catalog.sources, catalog.models, developer, query])
  return <Combobox.Root items={rows} filter={null} disabled={disabled}
    value={rows.find(row => row.model.id === value) || null} inputValue={value}
    itemToStringLabel={(row: ModelCandidate) => row.model.id} isItemEqualToValue={(a, b) => a.model.id === b.model.id}
    onInputValueChange={(next, details) => {
      // Only typing edits the draft ID. Closing or selecting a suggestion must not clear a custom ID.
      if (details.reason === 'input-change') { setQuery(next); onChange(next) }
    }}
    onOpenChange={(open, details) => { if (!open || details.reason !== 'input-change') setQuery('') }}
    onValueChange={candidate => { if (candidate) onSelect(candidate) }}>
    <Combobox.InputGroup className='relative min-w-0'>
      <Combobox.Input id='managed-model-id' render={<Input />} className='pr-8' maxLength={128}
        placeholder={t('搜索或输入模型 ID…')} autoComplete='off' />
      <Combobox.Trigger aria-label={t('选择模型')} className='models-id-trigger absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-md text-subtle hover:text-foreground disabled:opacity-50'>
        <svg viewBox='0 0 12 12' className='size-3' aria-hidden='true'><path d='m3 4.5 3 3 3-3' fill='none' stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' /></svg>
      </Combobox.Trigger>
    </Combobox.InputGroup>
    <Combobox.Portal>
      <Combobox.Positioner sideOffset={4} align='start' className='z-[35] max-w-[calc(100vw-32px)]'>
        <Combobox.Popup data-model-id-options className='flex w-[var(--anchor-width)] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-lg border border-border-strong bg-raised shadow-3 outline-none'
          style={{ maxHeight: 'min(320px, var(--available-height))' }}>
          <Combobox.Empty className='px-3 py-4 text-xs text-subtle'>
            {directory.loading && developer !== 'custom' ? t('加载中…') : t('没有匹配的模型')}
          </Combobox.Empty>
          <Combobox.List className='min-h-0 overflow-y-auto overscroll-contain p-1'>
            {(candidate: ModelCandidate) => <Combobox.Item key={candidate.model.id} value={candidate}
              aria-label={`${candidate.provider.name || t('已有自定义模型')} / ${candidate.model.id}`}
              className='flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-nav-hover data-[selected]:bg-primary-soft'>
              <ModelBrand id={candidate.provider.id} name={candidate.provider.name} icon={candidate.existing?.icon || candidate.model.icon} />
              <span className='min-w-0 flex-1'><span className='block break-all font-mono'>{candidate.model.id}</span>
                <span className='block break-words text-xs text-subtle'>{candidate.existing?.name || candidate.model.name}</span>
              </span>
              <Combobox.ItemIndicator className='shrink-0 text-primary' aria-hidden='true'>✓</Combobox.ItemIndicator>
            </Combobox.Item>}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  </Combobox.Root>
}
