import * as React from 'react'
import {
  Combobox,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@ui'
import { t } from '../ui-kit/src/i18n'

export type SearchableSelectOption = {
  value: string
  label: string
  disabled?: boolean
  searchText?: string
}

type SearchableSelectProps = {
  value: string
  onValueChange: (value: string) => void
  options: readonly SearchableSelectOption[]
  placeholder?: string
  displayValue?: string
  searchPlaceholder?: string
  emptyHint?: string
  searchable?: boolean
  disabled?: boolean
  className?: string
  id?: string
  title?: string
  'aria-label'?: string
}

export function SearchableSelect({
  value, onValueChange, options, placeholder = '', displayValue,
  searchPlaceholder = t('搜索…'), emptyHint = t('没有匹配的选项'),
  disabled, className, id, title, searchable = true, ...props
}: SearchableSelectProps) {
  const [search, setSearch] = React.useState('')
  const selected = options.find(option => option.value === value) ?? null
  const label = displayValue ?? selected?.label ?? (value || placeholder)
  const isPlaceholder = displayValue === undefined && !selected && !value

  if (!searchable) return <Select value={value} disabled={disabled}
    onValueChange={next => { if (typeof next === 'string') onValueChange(next) }}>
    <SelectTrigger id={id} className={className} title={title ?? label} aria-label={props['aria-label']}>
      <SelectValue>{label}</SelectValue>
    </SelectTrigger>
    <SelectContent>{options.map(item => <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
      {item.label}
    </SelectItem>)}</SelectContent>
  </Select>

  return <Combobox.Root items={options} value={selected} disabled={disabled}
    inputValue={search} onInputValueChange={setSearch} onOpenChange={() => setSearch('')}
    itemToStringLabel={item => item.label} itemToStringValue={item => item.value}
    isItemEqualToValue={(item, current) => item.value === current.value}
    filter={(item, query) => `${item.label} ${item.value} ${item.searchText || ''}`.toLowerCase().includes(query.trim().toLowerCase())}
    onValueChange={item => { if (item && !item.disabled) onValueChange(item.value) }}>
    <Combobox.Trigger id={id} className={'flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-surface px-3 text-left text-xs disabled:opacity-50 ' + (className || '')} title={title ?? label} aria-label={props['aria-label']}>
      <Combobox.Value>
        <span data-placeholder={isPlaceholder ? '' : undefined}>{label}</span>
      </Combobox.Value>
      <span aria-hidden='true'>⌄</span>
    </Combobox.Trigger>
    <Combobox.Portal>
      <Combobox.Positioner sideOffset={4} className='z-[100] w-[var(--anchor-width)]'>
        <Combobox.Popup className='rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg'>
      <Combobox.Input className='mb-1 min-h-9 w-full rounded-sm border border-input bg-surface px-2 text-xs' placeholder={searchPlaceholder} aria-label={searchPlaceholder} autoComplete='off' />
      <Combobox.Empty className='px-2 py-3 text-xs text-muted-foreground'>{emptyHint}</Combobox.Empty>
      <Combobox.List className='max-h-60 overflow-y-auto'>
        {(item: SearchableSelectOption) => <Combobox.Item className='cursor-default rounded-sm px-2 py-2 text-xs data-[highlighted]:bg-accent data-[disabled]:opacity-50' key={item.value} value={item} disabled={item.disabled} title={item.label}>
          {item.label}
        </Combobox.Item>}
      </Combobox.List>
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  </Combobox.Root>
}
