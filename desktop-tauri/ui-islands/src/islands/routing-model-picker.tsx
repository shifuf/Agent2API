import * as React from 'react'
import { Badge, Button, Checkbox, Input } from '@ui'
import { ModelBrand } from '../../../ui-shared/model-brand'
import { t } from '../i18n'
import { routeModelKey, ROUTING_MEMBER_LIMIT } from './routing-group-form'
import { RoutingChoiceBrand, RoutingSourceSelect, type RoutingSource } from './routing-model-source'
import { RouteIcon } from './routing-ui'
import type { RouteModelChoice } from './routing-types'
import './routing-magpie.css'

export function RoutingModelPicker({ choices, selected, onChange, disabled = false, limit = ROUTING_MEMBER_LIMIT }: {
  choices: RouteModelChoice[]; selected: string[]; onChange(selected: string[]): void; disabled?: boolean; limit?: number
}) {
  const [provider, setProvider] = React.useState('')
  const [modelSearch, setModelSearch] = React.useState('')
  const picked = new Set(selected)
  const available = choices.filter(choice => choice.accountCount > 0)
  const sourceMap = new Map<string, RoutingSource>()
  for (const choice of available) {
    const source = sourceMap.get(choice.provider) || { id: choice.provider, label: choice.providerLabel, models: 0, selected: 0 }
    source.models++
    if (picked.has(routeModelKey(choice))) source.selected = (source.selected || 0) + 1
    sourceMap.set(choice.provider, source)
  }
  const sources = [...sourceMap.values()].sort((left, right) => left.label.localeCompare(right.label))
  const current = sources.find(item => item.id === provider) || sources[0]
  const query = modelSearch.trim().toLowerCase()
  const models = available.filter(choice => choice.provider === current?.id && (!query || `${choice.name} ${choice.model} ${choice.developer || ''} ${choice.developerName || ''} ${choice.canonicalModel || ''}`.toLowerCase().includes(query)))
  const byKey = new Map(choices.map(choice => [routeModelKey(choice), choice]))
  const toggle = (choice: RouteModelChoice, on: boolean) => {
    const key = routeModelKey(choice)
    if (disabled || on && (picked.size >= limit || choice.accountCount <= 0)) return
    onChange(on ? [...new Set([...selected, key])] : selected.filter(value => value !== key))
  }
  return <div className='routing-model-selection'>
    <div className='routing-picker-tools'>
      <RoutingSourceSelect sources={sources} value={current?.id || ''} disabled={disabled}
        onChange={id => { setProvider(id); setModelSearch('') }} />
      <div className='routing-search-field'><RouteIcon name='search' size={15} /><Input value={modelSearch} disabled={disabled || !current}
        placeholder={t('搜索模型')} aria-label={t('搜索模型')} onChange={event => setModelSearch(event.currentTarget.value)} /></div>
    </div>
    <div className='routing-picker-caption'><span>{t('仅显示已登录、有账号且已获取模型的来源。')}</span><span>{t('{n} 个模型', { n: models.length })}</span></div>
    <div className='routing-model-choice-list routing-picker-list'>
      {models.map(choice => {
        const key = routeModelKey(choice), checked = picked.has(key)
        return <label key={key} className='routing-group-picker-row routing-choice-row' data-checked={checked ? '' : undefined}>
          <Checkbox checked={checked} disabled={disabled || !checked && picked.size >= limit} onCheckedChange={on => toggle(choice, on === true)}
            aria-label={`${choice.providerLabel} · ${choice.name || choice.model}`} />
          <RoutingChoiceBrand choice={choice} model={choice.model} />
          <div className='routing-choice-copy'><b>{choice.name || choice.model}</b><code>{choice.model}</code>
            <span className='routing-choice-meta'>
              {choice.capabilities.supportsToolCall === true ? <span>{t('工具调用')}</span> : null}
              {choice.capabilities.supportsImages === true ? <span>{t('图片输入')}</span> : null}
              {choice.capabilities.supportsReasoning === true ? <span>{t('深度思考')}</span> : null}
            </span>
          </div>
          <span className='routing-choice-accounts'>{t('{n} 个账号', { n: choice.accountCount })}</span>
        </label>
      })}
      {!models.length ? <div className='routing-picker-empty'><RouteIcon name='search' size={22} />
        <b>{query ? t('没有匹配的模型') : t('没有可添加的模型')}</b>
        <p>{query ? t('试试其他名称，或切换提供商。') : t('暂无可选来源，请先在账号页登录账号并获取模型。')}</p>
        {query ? <Button variant='outline' size='sm' disabled={disabled} onClick={() => setModelSearch('')}>{t('清空搜索')}</Button> : null}
      </div> : null}
    </div>
    <div className='routing-model-selection-summary'><span>{t('已选择 {count} / {total} 个', { count: picked.size, total: available.length })}</span>
      <Button variant='link' size='sm' disabled={disabled || !picked.size} onClick={() => onChange([])}>{t('清空选择')}</Button></div>
    {selected.length ? <div className='routing-selected-models' aria-label={t('已选模型')}>
      {selected.map(key => {
        const choice = byKey.get(key), [id, model] = key.split('\0')
        const label = `${choice?.providerLabel || id} · ${choice?.name || model}`
        return <span key={key} className='routing-selected-model' title={label}><ModelBrand id={choice?.provider || id} name={choice?.providerLabel || id} size='small' />
          <span>{choice?.name || model}</span>{!choice || choice.accountCount <= 0 ? <Badge variant='secondary' shape='tag'>{t('不可用')}</Badge> : null}
          <Button variant='ghost' size='icon-xs' disabled={disabled} aria-label={`${t('移除')} ${label}`} onClick={() => onChange(selected.filter(value => value !== key))}>
            <span aria-hidden='true'>×</span>
          </Button>
        </span>
      })}
    </div> : null}
    {picked.size >= limit ? <p className='routing-config-note'>{t('一个路由组最多允许 {n} 个成员', { n: ROUTING_MEMBER_LIMIT })}</p> : null}
  </div>
}
