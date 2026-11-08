import * as React from 'react'
import { Badge, Label, Select, SelectContent, SelectItem, SelectTrigger } from '@ui'
import { ModelBrand } from '../../../ui-shared/model-brand'
import { t } from '../i18n'
import type { RouteModelChoice } from './routing-types'

export type RoutingSource = { id: string; label: string; models: number; selected?: number }

export function RoutingSourceSelect({ sources, value, onChange, disabled = false, allCount }: {
  sources: RoutingSource[]; value: string; onChange(value: string): void; disabled?: boolean; allCount?: number
}) {
  const id = React.useId()
  const current = sources.find(source => source.id === value)
  const all = allCount !== undefined && !current
  return <div className='routing-source-field'>
    <Label htmlFor={id}>{t('选择提供商')}</Label>
    <Select value={current?.id || (all ? '__all__' : null)} disabled={disabled || !sources.length && !allCount}
      onValueChange={next => { if (next) onChange(next === '__all__' ? '' : next) }}>
      <SelectTrigger id={id} className='routing-source-trigger' aria-label={t('选择提供商')}>
        <span className='routing-source-label'>
          {current ? <ModelBrand id={current.id} name={current.label} size='small' /> : <span className='routing-source-all' aria-hidden='true'>◇</span>}
          <span>{current?.label || (all ? t('全部提供商') : t('选择提供商'))}</span>
          <Badge variant='secondary' shape='tag'>{current?.models ?? allCount ?? 0}</Badge>
        </span>
      </SelectTrigger>
      <SelectContent className='routing-source-options'>
        {allCount !== undefined ? <SelectItem value='__all__' label={t('全部提供商')} aria-label={t('全部提供商')}>
          <span className='routing-source-label'><span className='routing-source-all' aria-hidden='true'>◇</span><span>{t('全部提供商')}</span><Badge variant='secondary' shape='tag'>{allCount}</Badge></span>
        </SelectItem> : null}
        {sources.map(source => <SelectItem key={source.id} value={source.id} label={source.label} aria-label={source.label}>
          <span className='routing-source-label'><ModelBrand id={source.id} name={source.label} size='small' /><span>{source.label}</span>
            <Badge variant='secondary' shape='tag'>{source.models}</Badge>{source.selected ? <Badge variant='brand' shape='tag'>{t('已选 {n}', { n: source.selected })}</Badge> : null}
          </span>
        </SelectItem>)}
      </SelectContent>
    </Select>
  </div>
}

export function RoutingChoiceBrand({ choice, model, size = 'normal' }: { choice?: RouteModelChoice; model: string; size?: 'small' | 'normal' }) {
  const family = model.toLowerCase()
  const developer = choice?.developer || (/(?:^|[/_-])claude/.test(family) ? 'anthropic'
    : /(?:^|[/_-])(?:gpt|o[134](?:-|$)|chatgpt|codex)/.test(family) ? 'openai'
      : /(?:^|[/_-])gemini/.test(family) ? 'google' : /(?:^|[/_-])deepseek/.test(family) ? 'deepseek'
        : /(?:^|[/_-])qwen/.test(family) ? 'qwen' : /(?:^|[/_-])kimi/.test(family) ? 'kimi'
          : /(?:^|[/_-])glm/.test(family) ? 'glm' : /(?:^|[/_-])grok/.test(family) ? 'xai'
            : /(?:^|[/_-])minimax/.test(family) ? 'minimax' : choice?.provider || model)
  return <ModelBrand id={developer} name={choice?.developerName || choice?.name || model} size={size} />
}
