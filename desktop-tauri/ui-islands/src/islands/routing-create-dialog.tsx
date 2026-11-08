import * as React from 'react'
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, RadioGroup, RadioGroupItem, SegmentedControl } from '@ui'
import { ModelBrand } from '../../../ui-shared/model-brand'
import { t } from '../i18n'
import type { AccountRecord } from './accounts-shared'
import { createRouteMembers, newRouteId, routeGroupFieldsError, routeModelKey, RoutingGroupForm, type RoutingGroupFields } from './routing-group-form'
import { RoutingModelPicker } from './routing-model-picker'
import { RoutingChoiceBrand, RoutingSourceSelect, type RoutingSource } from './routing-model-source'
import { RouteIcon } from './routing-ui'
import { errorMessage, type RouteGroup, type RouteModelChoice, type RoutingWorkspace } from './routing-types'

type RouteType = 'model' | 'group'

export function RoutingCreateDialog({ workspace, choices, accounts, reserved, groupModels, modelError, disabled, onCreateModel, onCreateGroup, onClose, initialType = 'model' }: {
  workspace: RoutingWorkspace; choices: RouteModelChoice[]; accounts: AccountRecord[]; reserved: string[]; groupModels: string[]
  modelError?: string; disabled: boolean; onCreateModel(model: string): Promise<boolean>; onCreateGroup(group: RouteGroup): boolean; onClose(): void; initialType?: RouteType
}) {
  const [type, setType] = React.useState<RouteType>(initialType)
  const [search, setSearch] = React.useState('')
  const [provider, setProvider] = React.useState('')
  const [selectedModel, setSelectedModel] = React.useState('')
  const [selectedMembers, setSelectedMembers] = React.useState<string[]>([])
  const [fields, setFields] = React.useState<RoutingGroupFields>({ name: '', model: '', description: '' })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const locked = disabled || busy
  const groupIds = new Set(groupModels.map(model => model.toLowerCase()))
  const configured = new Set(workspace.configuredModels.map(model => model.toLowerCase()))
  const availableModels = workspace.models.filter(model => !configured.has(model.toLowerCase()) && !groupIds.has(model.toLowerCase()))
  const memberChoices = choices.filter(choice => choice.accountCount > 0 && !groupIds.has(choice.model.toLowerCase()))
  const providerLabels = new Map(workspace.providers.map(source => [source.id, source.label]))
  for (const choice of memberChoices) providerLabels.set(choice.provider, choice.providerLabel)
  const boundSources = new Map<string, string[]>()
  for (const [provider, models] of Object.entries(workspace.modelsByProvider || {})) for (const model of models) {
    const key = model.toLowerCase()
    boundSources.set(key, [...new Set([...(boundSources.get(key) || []), provider])])
  }
  const modelChoices = new Map<string, RouteModelChoice[]>()
  for (const choice of memberChoices) for (const id of new Set([choice.model, choice.canonicalModel].filter(Boolean))) {
    const key = id!.toLowerCase()
    modelChoices.set(key, [...(modelChoices.get(key) || []), choice])
  }
  const rows = availableModels.map(model => {
    const boundProviders = workspace.modelsByProvider ? boundSources.get(model.toLowerCase()) || [] : undefined
    const matches = (modelChoices.get(model.toLowerCase()) || []).filter(choice => !boundProviders || boundProviders.includes(choice.provider))
    const sources = (boundProviders || [...new Set(matches.map(choice => choice.provider))])
      .map(provider => ({ provider, providerLabel: providerLabels.get(provider) || provider }))
    return { model, choice: matches[0], sources }
  })
  const sourceMap = new Map<string, RoutingSource>()
  for (const row of rows) for (const source of row.sources) {
    const item = sourceMap.get(source.provider) || { id: source.provider, label: source.providerLabel, models: 0 }
    item.models++
    sourceMap.set(source.provider, item)
  }
  const sources = [...sourceMap.values()].sort((left, right) => left.label.localeCompare(right.label))
  const currentProvider = sources.some(source => source.id === provider) ? provider : ''
  const models = rows.filter(row => (!currentProvider || row.sources.some(source => source.provider === currentProvider))
    && `${row.model} ${row.choice?.name || ''} ${row.choice?.developerName || ''}`.toLowerCase().includes(search.trim().toLowerCase()))
  const byKey = new Map(memberChoices.map(choice => [routeModelKey(choice), choice]))
  const picked = selectedMembers.flatMap(key => { const choice = byKey.get(key); return choice ? [choice] : [] })
  const selected = availableModels.includes(selectedModel)

  const create = async () => {
    if (locked) return
    setError('')
    if (type === 'group') {
      const message = routeGroupFieldsError(fields, reserved)
      if (message) { setError(message); return }
      if (!onCreateGroup({ id: newRouteId(), name: fields.name.trim(), model: fields.model.trim().toLowerCase(), description: fields.description.trim(),
        strategy: 'order', sticky: 'auto', enabled: false, patience: 0, members: createRouteMembers(picked, accounts) })) {
        setError(t('路由数据正在更新，请稍后重试')); return
      }
      onClose()
      return
    }
    if (!selected) { setError(t('请选择模型')); return }
    setBusy(true)
    try { if (await onCreateModel(selectedModel)) onClose() }
    catch (failure) { setError(errorMessage(failure)) }
    finally { setBusy(false) }
  }

  return <Dialog open onOpenChange={(open, details) => {
    if (open) return
    if (busy) { details.cancel(); return }
    onClose()
  }}><DialogContent className='routing-create-dialog'>
    <DialogHeader><span className='routing-dialog-symbol'><RouteIcon name='route' size={22} /></span>
      <div className='routing-dialog-heading'><DialogTitle>{t('新增路由配置')}</DialogTitle>
        <DialogDescription>{t('选择一个模型单独配置，或把多个上游组合成路由组。')}</DialogDescription></div>
    </DialogHeader>
    <DialogBody>
      <SegmentedControl aria-label={t('路由类型')} value={type} disabled={locked} className='routing-create-types' options={[
        { value: 'model', label: t('模型独立路由') }, { value: 'group', label: t('路由组') },
      ]} onValueChange={value => { setType(value); setError('') }} />
      {type === 'model' ? <>
        <p className='routing-config-note'>{t('从现有模型中创建独立配置，自动列出提供它的全部提供商；之后的修改只跟随这个模型。')}</p>
        <div className='routing-picker-tools'>
          <RoutingSourceSelect sources={sources} value={currentProvider} allCount={availableModels.length} disabled={locked}
            onChange={value => { setProvider(value); setSearch('') }} />
          <div className='routing-search-field'><RouteIcon name='search' size={15} /><Input value={search} disabled={locked} placeholder={t('搜索模型')} aria-label={t('搜索模型')}
            onChange={event => setSearch(event.currentTarget.value)} /></div>
        </div>
        <div className='routing-picker-caption'><span>{t('仅显示已登录、有账号且已获取模型的来源。')}</span><span>{t('{n} 个模型', { n: models.length })}</span></div>
        <RadioGroup className='routing-model-picker routing-independent-models routing-picker-list' value={selectedModel} disabled={locked} aria-label={t('模型独立路由')}
          onValueChange={value => setSelectedModel(value)}>
          {models.map(({ model, choice, sources: modelSources }) => <Label key={model} className='routing-single-model routing-choice-row' data-checked={selectedModel === model ? '' : undefined}>
            <RadioGroupItem value={model} aria-label={model} /><RoutingChoiceBrand choice={choice} model={model} />
            <span className='routing-choice-copy'><b>{choice?.displayName || choice?.name || model}</b><code title={model}>{model}</code>
              {modelSources.length ? <span className='routing-model-sources'>{modelSources.slice(0, 3).map(source => <span key={source.provider} title={source.providerLabel}>
                <ModelBrand id={source.provider} name={source.providerLabel} size='small' />{source.providerLabel}
              </span>)}{modelSources.length > 3 ? <Badge variant='secondary' shape='tag'>+{modelSources.length - 3}</Badge> : null}</span> : null}
            </span>
          </Label>)}
          {!models.length ? <div className='routing-picker-empty'><RouteIcon name='search' size={22} /><b>{search.trim() ? t('没有匹配的模型') : t('没有可添加的模型')}</b>
            <p>{search.trim() ? t('试试其他名称，或切换提供商。') : workspace.models.length ? t('这些模型已配置路由，可在路由列表中继续编辑。') : t('暂无可选来源，请先在账号页登录账号并获取模型。')}</p>
            {search.trim() ? <Button variant='outline' size='sm' disabled={locked} onClick={() => setSearch('')}>{t('清空搜索')}</Button> : null}
          </div> : null}
        </RadioGroup>
      </> : <>
        <RoutingGroupForm value={fields} onChange={setFields} disabled={locked} />
        <p className='routing-config-note'>{t('可以跨提供商、跨模型多选。同一提供商也可以加入不同模型。')}</p>
        <RoutingModelPicker choices={memberChoices} selected={selectedMembers} onChange={setSelectedMembers} disabled={locked} />
      </>}
      {error || type === 'model' && modelError ? <p className='routing-config-error' role='alert'>{error || modelError}</p> : null}
    </DialogBody>
    <DialogFooter><span className='routing-create-summary'>{type === 'model' ? selected ? selectedModel : t('共 {n} 个可添加的模型', { n: availableModels.length })
      : t('已选择 {n} 个模型', { n: picked.length })}</span><Button variant='outline' disabled={busy} onClick={onClose}>{t('取消')}</Button>
      <Button disabled={locked || (type === 'model' ? !selected : !fields.name.trim() || !fields.model.trim())} onClick={() => void create()}>
        {busy ? t('保存中…') : type === 'model' ? t('创建独立配置') : t('创建草稿')}
      </Button>
    </DialogFooter>
  </DialogContent></Dialog>
}
