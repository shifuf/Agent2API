import * as React from 'react'
import { Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ui'
import { t } from '../i18n'
import type { AccountRecord } from './accounts-shared'
import { createRouteMembers, newRouteId, routeGroupFieldsError, routeModelKey, RoutingGroupForm, RoutingKindSelect, type RoutingGroupFields } from './routing-group-form'
import { RoutingModelPicker } from './routing-model-picker'
import { RouteIcon } from './routing-ui'
import type { RouteGroup, RouteKind, RouteModelChoice } from './routing-types'

export function RoutingCreateDialog({ choices, accounts, reserved, disabled, onCreateGroup, onClose }: {
  choices: RouteModelChoice[]; accounts: AccountRecord[]; reserved: RouteGroup[]
  disabled: boolean; onCreateGroup(group: RouteGroup): boolean; onClose(): void
}) {
  const [kind, setKind] = React.useState<RouteKind>('chat')
  const [selectedMembers, setSelectedMembers] = React.useState<string[]>([])
  const [fields, setFields] = React.useState<RoutingGroupFields>({ name: '', model: '', description: '' })
  const [error, setError] = React.useState('')
  const memberChoices = choices.filter(choice => choice.accountCount > 0 && (choice.kind || 'chat') === kind)
  const byKey = new Map(memberChoices.map(choice => [routeModelKey(choice), choice]))
  const picked = selectedMembers.flatMap(key => { const choice = byKey.get(key); return choice ? [choice] : [] })
  const create = () => {
    if (disabled) return
    const message = routeGroupFieldsError(fields, reserved)
    if (message) { setError(message); return }
    if (!onCreateGroup({ id: newRouteId(), kind, name: fields.name.trim(), model: fields.model.trim(), description: fields.description.trim(),
      strategy: 'order', sticky: 'auto', enabled: false, patience: 0, members: createRouteMembers(picked, accounts) })) {
      setError(t('路由数据正在更新，请稍后重试')); return
    }
    onClose()
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className='routing-create-dialog'>
    <DialogHeader><span className='routing-dialog-symbol'><RouteIcon name='route' size={22} /></span>
      <div className='routing-dialog-heading'><DialogTitle>{t('新建路由组')}</DialogTitle>
        <DialogDescription>{t('设置对外模型 ID，再选择提供此路由的上游模型。')}</DialogDescription></div>
    </DialogHeader>
    <DialogBody>
      <RoutingGroupForm value={fields} onChange={setFields} disabled={disabled} />
      <RoutingKindSelect value={kind} disabled={disabled} onChange={value => { setKind(value); setSelectedMembers([]); setError('') }} />
      <p className='routing-config-note'>{kind === 'image' ? t('图像路由用于图片生成与编辑，仅列出图像模型。') : t('对话路由用于文本和多模态对话，仅列出对话模型。')}</p>
      <RoutingModelPicker key={kind} choices={memberChoices} selected={selectedMembers} onChange={setSelectedMembers} disabled={disabled} />
      {error ? <p className='routing-config-error' role='alert'>{error}</p> : null}
    </DialogBody>
    <DialogFooter><span className='routing-create-summary'>{t('已选择 {n} 个模型', { n: picked.length })}</span>
      <Button variant='outline' onClick={onClose}>{t('取消')}</Button>
      <Button disabled={disabled || !fields.name.trim() || !fields.model.trim()} onClick={create}>{t('创建草稿')}</Button>
    </DialogFooter>
  </DialogContent></Dialog>
}
