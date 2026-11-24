import * as React from 'react'
import { Alert, Button, Card, Input, Label, Switch } from '@ui'
import { SearchableSelect } from './searchable-select'
import { documentText } from './provider-docs'
import { pluginSettingsKey, pluginSettingsMembers, type PluginRequest, type PluginSettingValue, type PluginSettingsRow, type PluginTranslate } from './plugin-controls'
import type { PackProvider } from './plugins'

function SettingCard({ row, disabled, request, refresh, onBusyChange, t, locale }: {
  row: PluginSettingsRow; disabled: boolean; request: PluginRequest; refresh: () => Promise<void>
  onBusyChange: (busy: boolean) => void; t: PluginTranslate; locale: string
}) {
  const [draft, setDraft] = React.useState<Record<string, PluginSettingValue>>({})
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const baseline = React.useRef<PluginSettingsRow | null>(null)
  const alive = React.useRef(true)
  const pending = React.useRef(false)
  const latest = React.useRef({ request, refresh, onBusyChange })
  latest.current = { request, refresh, onBusyChange }
  const id = React.useId()
  React.useEffect(() => {
    alive.current = true
    return () => { alive.current = false; latest.current.onBusyChange(false) }
  }, [])
  const view = baseline.current || row
  const dirty = Object.keys(draft).length > 0
  const changed = baseline.current !== null && baseline.current.revision !== row.revision
  const locked = disabled || busy || changed || Boolean(row.error) || !row.revision
  const members = pluginSettingsMembers(row)
  const label = documentText(row.group?.label, locale) || members.map(member => t(member.label)).join(' / ')

  function edit(key: string, value: PluginSettingValue) {
    if (locked) return
    if (!baseline.current) baseline.current = row
    const next = { ...draft, [key]: value }
    if (value === (view.values?.[key] ?? null) && !view.invalid?.[key]) delete next[key]
    if (!Object.keys(next).length) baseline.current = null
    setDraft(next); setError(''); setNotice('')
  }
  async function save() {
    if (locked || pending.current || !dirty) return
    pending.current = true
    setBusy(true); setError(''); setNotice(''); latest.current.onBusyChange(true)
    try {
      const values = { ...draft }
      for (const field of view.schema?.fields || []) {
        const value = values[field.key]
        if (field.type !== 'number' || typeof value !== 'string') continue
        const number = Number(value)
        if (!value.trim() || !Number.isFinite(number)) throw new Error(t('请输入有效的数字'))
        values[field.key] = number
      }
      const result = await latest.current.request<PluginSettingsRow>('PATCH', '/api/plugins/provider-settings', {
        provider: view.provider, revision: view.revision, values,
      })
      if (!alive.current) return
      baseline.current = null; setDraft({})
      setNotice(result.saved === false ? t('设置已生效，但写入磁盘失败（重启后会恢复原设置）') : t('提供商设置已保存'))
      await latest.current.refresh()
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pending.current = false; latest.current.onBusyChange(false)
      if (alive.current) setBusy(false)
    }
  }
  function reset() {
    baseline.current = null; setDraft({}); setError(''); setNotice('')
    void latest.current.refresh()
  }

  return <Card className='min-w-0 p-3'>
    <form className='flex flex-col gap-4' onSubmit={event => { event.preventDefault(); void save() }}>
      <div className='flex items-center justify-between gap-3'>
        <h4 className='text-sm font-medium'>{label}</h4>
        <Button type='button' size='sm' variant='ghost' disabled={busy || disabled} onClick={reset}>{dirty ? t('放弃修改并刷新') : t('刷新')}</Button>
      </div>
      {row.schema?.description ? <p className='text-xs whitespace-pre-wrap text-muted-foreground'>{documentText(row.schema.description, locale)}</p> : null}
      {row.error ? <Alert variant='destructive'>{row.error}</Alert> : null}
      {changed ? <Alert>{t('插件或设置已变化，请放弃修改并刷新后重新编辑。')}</Alert> : null}
      {view.schema?.fields.map(field => {
        const value = Object.hasOwn(draft, field.key) ? draft[field.key] : view.values?.[field.key]
        const current = value ?? field.default
        const fieldLabel = documentText(field.label, locale)
        const inputId = `${id}-${field.key}`
        const override = row.overrides?.[field.key]
        return <div key={field.key} className='flex min-w-0 flex-col gap-2'>
          <Label htmlFor={inputId} className='text-xs'>{fieldLabel}</Label>
          {field.type === 'boolean' ? <Switch id={inputId} checked={current === true} disabled={locked} onCheckedChange={value => edit(field.key, value)} />
            : field.type === 'select' ? <SearchableSelect id={inputId} value={String(current ?? '')} disabled={locked}
              displayValue={documentText(field.options.find(option => option.value === current)?.label, locale) || t('请选择')}
              options={field.options.map(option => ({ value: option.value, label: documentText(option.label, locale) }))}
              onValueChange={value => edit(field.key, value)} />
              : <Input id={inputId} type={field.type === 'number' ? 'number' : 'text'} value={String(current ?? '')}
                min={field.minimum ?? undefined} max={field.maximum ?? undefined} maxLength={field.max_length ?? undefined}
                disabled={locked} autoComplete='off' spellCheck={false} onChange={event => {
                  const text = event.currentTarget.value
                  edit(field.key, text)
                }} />}
          {field.description ? <p className='text-xs whitespace-pre-wrap text-muted-foreground'>{documentText(field.description, locale)}</p> : null}
          {override ? <p className='text-xs text-muted-foreground'>{t('当前由 {source} 覆盖为 {value}', { source: override.source, value: String(override.value) })}</p> : null}
          {view.invalid?.[field.key] ? <p className='text-xs text-destructive'>{t('保存值不符合当前插件的规则，请重新设置。')}</p> : null}
          <Button type='button' size='sm' variant='ghost' className='self-start' disabled={locked || value === null || value === undefined}
            onClick={() => edit(field.key, null)}>{t('恢复默认值')}</Button>
        </div>
      })}
      {error ? <Alert variant='destructive'>{error}</Alert> : null}
      {notice ? <p role='status' className='text-xs text-muted-foreground'>{notice}</p> : null}
      <Button type='submit' size='sm' className='self-start' disabled={locked || !dirty}>{busy ? t('保存中…') : t('保存')}</Button>
    </form>
  </Card>
}

export function PluginProviderSettings({ providers, packId, request, t, locale, disabled = false, onBusyChange }: {
  providers: PackProvider[]; packId: string; request: PluginRequest; t: PluginTranslate; locale: string
  disabled?: boolean; onBusyChange?: (busy: boolean) => void
}) {
  const [rows, setRows] = React.useState<PluginSettingsRow[] | null>(null)
  const [error, setError] = React.useState('')
  const alive = React.useRef(true)
  const sequence = React.useRef(0)
  const latest = React.useRef({ request, providers })
  const busy = React.useRef(new Set<string>())
  latest.current = { request, providers }
  const scope = JSON.stringify([packId, providers.map(provider => [provider.id, provider.enabled, provider.loaded])])
  const load = React.useCallback(async () => {
    const current = ++sequence.current
    try {
      const value = await latest.current.request<{ settings: PluginSettingsRow[] }>('GET', '/api/plugins/provider-settings')
      if (!Array.isArray(value.settings)) throw new Error(t('提供商设置返回格式无效，请刷新后重试'))
      if (!alive.current || current !== sequence.current) return
      const ids = new Set(latest.current.providers.map(provider => provider.id))
      const next = value.settings.filter(row => pluginSettingsMembers(row).some(member => ids.has(member.id)))
      setRows(previous => [...next, ...(previous || []).filter(row => !next.some(item => pluginSettingsKey(item) === pluginSettingsKey(row)))
        .map(row => ({ ...row, error: t('提供商当前不可用，未保存的修改已保留；恢复插件后可继续编辑。') }))])
      setError('')
    } catch (cause) {
      if (alive.current && current === sequence.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [packId, t])
  React.useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false; sequence.current++; busy.current.clear(); onBusyChange?.(false) }
  }, [load, scope, onBusyChange])
  if (rows?.length === 0 && !error) return null
  return <section className='flex min-w-0 flex-col gap-3' aria-label={t('提供商设置')}>
    <h3 className='text-sm font-medium'>{t('提供商设置')}</h3>
    {error ? <Alert variant='destructive'>{error}</Alert> : null}
    {rows === null && !error ? <p role='status' className='text-xs text-muted-foreground'>{t('正在读取提供商设置…')}</p> : null}
    {rows?.map(row => <SettingCard key={pluginSettingsKey(row)} row={row} disabled={disabled} request={request} refresh={load} t={t} locale={locale}
      onBusyChange={value => { const key = pluginSettingsKey(row); if (value) busy.current.add(key); else busy.current.delete(key); onBusyChange?.(busy.current.size > 0) }} />)}
  </section>
}
