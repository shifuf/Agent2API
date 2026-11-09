import * as React from 'react'
import { Field, FieldLabel, Input, SegmentedControl } from '@ui'
import { t } from '../i18n'
import { providerOf } from './accounts-domain'
import type { AccountRecord } from './accounts-shared'
import type { RouteGroup, RouteKind, RouteMember, RouteModelChoice } from './routing-types'

export type RoutingGroupFields = Pick<RouteGroup, 'name' | 'model' | 'description'>
export const ROUTING_MEMBER_LIMIT = 256
export const routeModelKey = (choice: RouteModelChoice) => `${choice.provider}\0${choice.model.toLowerCase()}`

export function accountCanRouteModel(account: AccountRecord, model: string) {
  if (account.enabled === false || account.hasCredentials === false) return false
  const group = account.keyGroup
  return !group || (group.enabled !== false && Array.isArray(group.models)
    && group.models.some(candidate => candidate.toLowerCase() === model.toLowerCase()))
}

export function newRouteId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return crypto.randomUUID()
  const bytes = globalThis.crypto?.getRandomValues(new Uint8Array(16))
  return bytes ? `route-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
    : `route-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function routeGroupFieldsError(fields: RoutingGroupFields, reserved: RouteGroup[], currentId = '') {
  const alias = fields.model.trim().toLowerCase()
  if (!fields.name.trim() || !alias) return t('请填写组名和对外模型 ID')
  if (alias.length > 256 || /[\u0000-\u001f\u007f]/.test(alias)) return t('对外模型 ID 格式不正确')
  const conflict = reserved.find(group => group.id !== currentId && group.model.toLowerCase() === alias)
  if (conflict) {
    return t('对外模型 ID 已被路由组「{name}」占用', { name: conflict.name || conflict.model })
  }
  return ''
}

export function createRouteMembers(choices: RouteModelChoice[], accounts: AccountRecord[]): RouteMember[] {
  return choices.map(choice => ({ id: newRouteId(), provider: choice.provider, model: choice.model, included: true,
    accountScope: 'selected', weight: 1,
    accounts: accounts.filter(account => providerOf(account) === choice.provider && accountCanRouteModel(account, choice.model)).map(account => account.id) }))
}

export function RoutingKindSelect({ value, onChange, disabled = false }: { value: RouteKind; onChange(value: RouteKind): void; disabled?: boolean }) {
  return <SegmentedControl aria-label={t('请求接口')} value={value} disabled={disabled} className='routing-create-types'
    options={[{ value: 'chat', label: t('对话') }, { value: 'image', label: t('图像') }]} onValueChange={onChange} />
}

export function RoutingGroupForm({ value, onChange, disabled = false }: {
  value: RoutingGroupFields; onChange(value: RoutingGroupFields): void; disabled?: boolean
}) {
  const id = React.useId()
  return <div className='routing-group-form'>
    <Field><FieldLabel htmlFor={`${id}-name`}>{t('组名')}</FieldLabel><Input id={`${id}-name`} maxLength={64} disabled={disabled}
      value={value.name} placeholder={t('例如：日常省钱')} onChange={event => onChange({ ...value, name: event.currentTarget.value })} /></Field>
    <Field><FieldLabel htmlFor={`${id}-model`}>{t('对外模型 ID')}</FieldLabel><Input id={`${id}-model`} maxLength={256} disabled={disabled}
      value={value.model} placeholder='budget-chat' onChange={event => onChange({ ...value, model: event.currentTarget.value })} /></Field>
  </div>
}
