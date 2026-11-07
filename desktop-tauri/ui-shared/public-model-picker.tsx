import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Input, Label } from '@ui'
import { filterPublicModels, type PublicModel, type PublicModelCatalog } from './public-model-catalog'

type Translate = (key: string, params?: Record<string, string | number>) => string
type CatalogRequest = (refresh: boolean) => Promise<PublicModelCatalog>

/** Page-scoped preloading; never share authenticated state between mobile servers. */
export function usePublicModelCatalog(request: CatalogRequest) {
  const [catalog, setCatalog] = useState<PublicModelCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const refresh = useCallback(async (force = true) => {
    const ticket = ++generation.current
    setLoading(true); setError('')
    try {
      const next = await request(force)
      if (ticket === generation.current) { setCatalog(next); setError(next.error || '') }
    } catch (failure) {
      if (ticket === generation.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally { if (ticket === generation.current) setLoading(false) }
  }, [request])
  useEffect(() => { void refresh(false); return () => { generation.current++ } }, [refresh])
  return { catalog, loading, error, refresh }
}

export function PublicModelPicker({ state, selectedId, disabled, onSelect, t }: {
  state: ReturnType<typeof usePublicModelCatalog>; selectedId: string; disabled?: boolean
  onSelect: (model: PublicModel) => void; t: Translate
}) {
  const id = useId()
  const [manufacturer, setManufacturer] = useState('')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(60)
  const { catalog, loading, error, refresh } = state
  const providers = catalog?.providers || []
  const rows = useMemo(() => filterPublicModels(catalog?.providers || [], manufacturer, query), [catalog, manufacturer, query])
  useEffect(() => { setLimit(60) }, [manufacturer, query])
  useEffect(() => {
    if (manufacturer && catalog && !catalog.providers.some(provider => provider.id === manufacturer)) setManufacturer('')
  }, [catalog, manufacturer])
  const updated = catalog?.updatedAt || catalog?.fetchedAt
  const updatedLabel = updated && Number.isFinite(Date.parse(updated)) ? new Date(updated).toLocaleString() : ''

  return <section className='flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-2 p-3' aria-label={t('预加载模型目录')}>
    <div className='flex flex-wrap items-center justify-between gap-2'>
      <div><strong className='text-sm'>{t('从厂商目录选择模型')}</strong>
        <p className='mt-1 text-xs text-subtle'>{t('选择后自动填写模型 ID 和名称，再选择渠道中的上游模型。')}</p></div>
      <Button size='sm' variant='outline' disabled={loading || disabled} onClick={() => void refresh()}>
        {loading ? t('加载中…') : t('更新模型目录')}
      </Button>
    </div>
    <div className='grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]'>
      <div className='flex min-w-0 flex-col gap-1.5'>
        <Label htmlFor={`${id}-manufacturer`}>{t('模型厂商')}</Label>
        <select id={`${id}-manufacturer`} value={manufacturer} disabled={disabled || !providers.length}
          className='h-9 min-w-0 w-full rounded-md border border-border bg-surface px-2 text-sm'
          onChange={event => setManufacturer(event.target.value)}>
          <option value=''>{t('全部厂商')}</option>
          {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} ({provider.models.length})</option>)}
        </select>
      </div>
      <div className='flex min-w-0 flex-col gap-1.5'>
        <Label htmlFor={`${id}-search`}>{t('搜索模型目录')}</Label>
        <Input id={`${id}-search`} value={query} disabled={disabled} placeholder={t('搜索厂商、模型名称或 ID…')}
          onChange={event => setQuery(event.target.value)} />
      </div>
    </div>
    {error && <Alert variant='warning'>{catalog?.providers.length
      ? t('目录更新失败，继续使用已缓存的模型。') : t('模型目录暂时无法加载，请重试或填写自定义模型 ID。')}</Alert>}
    {!error && catalog?.stale && <p className='text-xs text-subtle'>{t('正在使用缓存的模型目录。')}</p>}
    <div className='max-h-52 min-w-0 overflow-y-auto rounded-md border border-border bg-surface' aria-busy={loading}>
      {rows.slice(0, limit).map(({ provider, model }) => <button type='button' key={`${provider.id}:${model.id}`}
        disabled={disabled} aria-label={`${provider.name} / ${model.id}`} aria-pressed={selectedId === model.id}
        onClick={() => onSelect(model)}
        className='flex w-full items-start gap-2 border-b border-hairline px-3 py-2 text-left text-sm last:border-b-0 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 aria-pressed:bg-surface-2 disabled:opacity-50'>
        <span className='min-w-0 flex-1'><span className='block break-all font-mono'>{model.id}</span>
          <span className='block break-words text-xs text-subtle'>{provider.name} · {model.name}</span></span>
        <Badge variant='secondary' className='shrink-0 text-[10px]'>{model.kind}</Badge>
        {selectedId === model.id && <span aria-hidden='true'>✓</span>}
      </button>)}
      {!rows.length && <p className='p-5 text-center text-xs text-subtle'>{loading ? t('加载中…') : t('没有匹配的模型')}</p>}
      {rows.length > limit && <Button className='m-2' size='sm' variant='ghost' onClick={() => setLimit(value => value + 60)}>{t('显示更多')}</Button>}
    </div>
    <p className='text-xs text-subtle'>PublicProviderConf · {t('共 {n} 个候选模型', { n: rows.length })}{updatedLabel ? ` · ${t('目录更新于 {time}', { time: updatedLabel })}` : ''}</p>
  </section>
}
