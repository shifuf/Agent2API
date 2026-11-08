import * as React from 'react'
import { Checkbox, Input, Switch, Textarea } from '@ui'
import { t } from '../i18n'
import { routingEfforts, routingSelectableMembers, routingStrategies } from './routing-group-tools'
import { strategyLabel, stickyLabel } from './routing-ui'
import { RoutingRulesEditor } from './routing-rules-editor'
import type { RouteGroup, RouteMember, RouteModelChoice } from './routing-types'

export function RoutingOption({ label, children, full = false }: { label: string; children: React.ReactNode; full?: boolean }) {
  return <label className={`routing-magpie-field${full ? ' routing-magpie-full' : ''}`}><span>{label}</span>{children}</label>
}
export function RoutingEffortSelect({ value, onChange, label, automatic = false, disabled = false }: { value?: string; onChange(value: string): void; label: string; automatic?: boolean; disabled?: boolean }) {
  return <select disabled={disabled} aria-label={label} value={value || ''} onChange={event => onChange(event.currentTarget.value)}><option value=''>{t('跟随请求')}</option>
    {automatic ? <option value='auto'>{t('自动分类')}</option> : routingEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select>
}
export function RoutingLevels({ value, onChange }: { value?: string[]; onChange(value: string[]): void }) {
  return <div className='routing-magpie-levels'>{routingEfforts.map(level => <label key={level}><Checkbox checked={Boolean(value?.includes(level))}
    onCheckedChange={on => onChange(routingEfforts.filter(item => item === level ? on : value?.includes(item)))} />{level}</label>)}</div>
}

export function RoutingGroupOptions({ group, choices, groups, expandedMembers, disabled, update }: {
  group: RouteGroup; choices: RouteModelChoice[]; groups: RouteGroup[]; expandedMembers?: RouteMember[]; disabled: boolean; update(mutate: (group: RouteGroup) => void): void
}) {
  const change = (patch: Partial<RouteGroup>) => update(next => Object.assign(next, patch))
  const selectableMembers = routingSelectableMembers(group, expandedMembers)
  const labelMember = (member: RouteMember) => member.group ? groups.find(item => item.id === member.group)?.name || member.group : `${member.provider} / ${member.model}`
  return <fieldset disabled={disabled} className='min-w-0' data-routing-group-options>
    <div className='routing-magpie-fields'>
      <RoutingOption label={t('路由策略')}><select aria-label={t('路由策略')} value={group.strategy} onChange={event => change({ strategy: event.currentTarget.value })}>
        {routingStrategies.map(strategy => <option key={strategy} value={strategy}>{strategyLabel(strategy)}</option>)}
        {group.strategy === 'usage' ? <option value='usage'>{t('负载均衡（旧配置）')}</option> : null}</select></RoutingOption>
      <RoutingOption label={t('会话粘滞')}><select aria-label={t('会话粘滞')} value={group.sticky} onChange={event => change({ sticky: event.currentTarget.value })}>
        {['auto', 'session', 'turn', 'off', 'strict'].map(value => <option key={value} value={value}>{stickyLabel(value)}</option>)}</select></RoutingOption>
      <label className='routing-magpie-inline'><Switch checked={group.enabled !== false} onCheckedChange={enabled => change({ enabled })} />{t('路由组启用')}</label>
      <label className='routing-magpie-inline'><Checkbox checked={Boolean(group.unlists)} onCheckedChange={value => change({ unlists: value === true })} />{t('不在模型列表显示')}</label>
      {group.strategy === 'manual' ? <RoutingOption label={t('手动指定成员')} full><select aria-label={t('手动指定成员')} value={group.pick || ''} onChange={event => change({ pick: event.currentTarget.value })}>
        <option value=''>{t('第一个成员')}</option>{selectableMembers.map(member => <option key={member.id} value={member.id}>{labelMember(member)}{member.included ? '' : ` · ${t('已停用')}`}</option>)}</select></RoutingOption> : null}
    </div>
    <details className='routing-magpie-details'><summary>{t('超时与故障回退')}</summary><div className='routing-magpie-fields'>
      <RoutingOption label={t('首内容超时（秒）')}><Input type='number' min={0} max={3600} value={group.firstToken || 0} onChange={event => change({ firstToken: Number(event.currentTarget.value) })} /></RoutingOption>
      <RoutingOption label={t('短暂失败等待（秒）')}><Input type='number' min={-1} max={240} value={group.patience ?? -1} onChange={event => change({ patience: Number(event.currentTarget.value) })} /></RoutingOption>
      <RoutingOption label={t('故障下沉')}><select aria-label={t('故障下沉')} value={group.sink == null ? '' : String(group.sink)} onChange={event => change({ sink: event.currentTarget.value === '' ? null : event.currentTarget.value === 'true' })}>
        <option value=''>{t('继承全局')}</option><option value='true'>{t('启用')}</option><option value='false'>{t('关闭')}</option></select></RoutingOption>
    </div><p>{t('首内容超时 0 表示关闭；等待 -1 表示关闭，0 表示 60 秒。已返回内容后不会切换上游。')}</p></details>
    <details className='routing-magpie-details'><summary>{t('动态模型匹配')}</summary>
      <RoutingOption label={t('匹配表达式（每行一条）')}><Textarea rows={3} value={(group.match || []).join('\n')} placeholder='provider/model-*' onChange={event => change({ match: event.currentTarget.value.split('\n') })} /></RoutingOption>
      <p>{t('使用 * 通配符或 re:正则表达式匹配提供商/模型；新增匹配模型自动参与，仍受账号与 Key 限制。')}</p>
    </details>
    <details className='routing-magpie-details'><summary>{t('推理与模型信息')}</summary><div className='routing-magpie-fields'>
      <RoutingOption label={t('默认推理等级')}><RoutingEffortSelect automatic value={group.effort} label={t('默认推理等级')} onChange={effort => change({ effort })} /></RoutingOption>
      <RoutingOption label={t('上下文窗口')}><Input type='number' min={-1} max={100000000} value={group.context || 0} onChange={event => change({ context: Number(event.currentTarget.value) })} /></RoutingOption>
      <RoutingOption label={t('模型系列')}><Input value={group.family || ''} maxLength={256} onChange={event => change({ family: event.currentTarget.value })} /></RoutingOption>
      <RoutingOption label={t('说明')}><Input value={group.description || ''} onChange={event => change({ description: event.currentTarget.value })} /></RoutingOption>
      <div className='routing-magpie-field routing-magpie-full'><span>{t('允许的推理等级')}</span><RoutingLevels value={group.levels} onChange={levels => change({ levels })} /></div>
    </div></details>
    <details className='routing-magpie-details'><summary>{t('条件规则与意图分类')}</summary><div className='routing-magpie-fields'>
      <RoutingOption label={t('意图分类模型')} full><select aria-label={t('意图分类模型')} value={group.classifier || ''} onChange={event => change({ classifier: event.currentTarget.value })}>
        <option value=''>{t('不使用分类器')}</option>{choices.filter(choice => choice.accountCount > 0).map(choice => <option key={`${choice.provider}/${choice.model}`} value={`${choice.provider}/${choice.model}`}>{choice.providerLabel} / {choice.name || choice.model}</option>)}
        {groups.filter(item => item.id !== group.id).map(item => <option key={item.id} value={item.id}>{t('路由组')} / {item.name}</option>)}</select></RoutingOption>
      <RoutingOption label={t('分类超时（秒）')}><Input type='number' min={1} max={60} value={group.classifierTimeout || 8} onChange={event => change({ classifierTimeout: Number(event.currentTarget.value) })} /></RoutingOption>
    </div><p>{t('分类失败或超时后按正常策略选路；预演不会调用分类器。')}</p>
      <RoutingRulesEditor group={group} members={selectableMembers} onChange={rules => change({ rules })} />
    </details>
  </fieldset>
}

export function RoutingMemberOptions({ member, onChange, disabled }: { member: RouteMember; onChange(patch: Partial<RouteMember>): void; disabled: boolean }) {
  return <fieldset disabled={disabled} className='routing-magpie-member-settings'><div className='routing-magpie-fields'>
    <RoutingOption label={t('成员权重')}><Input type='number' min={1} max={1000} value={member.weight ?? 1} onChange={event => onChange({ weight: Number(event.currentTarget.value) })} /></RoutingOption>
    {!member.group ? <><RoutingOption label={t('账号范围')}><select aria-label={t('账号范围')} value={member.accountScope || 'selected'} onChange={event => onChange({ accountScope: event.currentTarget.value as 'selected' | 'all' })}>
      <option value='selected'>{t('仅选定账号')}</option><option value='all'>{t('全部可用账号（含新增）')}</option></select></RoutingOption>
      <RoutingOption label={t('成员推理等级')}><RoutingEffortSelect value={member.effort} label={t('成员推理等级')} onChange={effort => onChange({ effort })} /></RoutingOption>
      <label className='routing-magpie-inline'><Checkbox checked={Boolean(member.fast)} onCheckedChange={value => onChange({ fast: value === true })} />{t('快速模式')}</label>
      <div className='routing-magpie-field routing-magpie-full'><span>{t('成员推理等级范围')}</span><RoutingLevels value={member.levels} onChange={levels => onChange({ levels })} /></div></> : <p>{t('嵌套路由组保留自己的策略与推理设置。')}</p>}
  </div></fieldset>
}
