import { Button, Checkbox, Input, Textarea } from '@ui'
import { t } from '../i18n'
import type { RouteGroup, RouteMember, RoutingRule } from './routing-types'
import { RoutingEffortSelect, RoutingOption } from './routing-group-options'

export function RoutingRulesEditor({ group, members = group.members, onChange }: { group: RouteGroup; members?: RouteMember[]; onChange(rules: RoutingRule[]): void }) {
  const rules = group.rules || []
  const update = (index: number, patch: Partial<RoutingRule>) => onChange(rules.map((rule, at) => at === index ? { ...rule, ...patch } : rule))
  const move = (index: number, offset: number) => { const next = [...rules]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; onChange(next) }
  return <div className='routing-magpie-rules'>{rules.map((rule, index) => <section key={index} className='routing-magpie-rule' data-routing-rule={index}>
    <header><strong>{t('规则 {n}', { n: index + 1 })}</strong><Button size='sm' variant='ghost' disabled={index === 0} aria-label={t('上移规则')} onClick={() => move(index, -1)}>↑</Button>
      <Button size='sm' variant='ghost' disabled={index === rules.length - 1} aria-label={t('下移规则')} onClick={() => move(index, 1)}>↓</Button>
      <Button size='sm' variant='ghost' onClick={() => onChange(rules.filter((_, at) => at !== index))}>{t('删除规则')}</Button></header>
    <div className='routing-magpie-fields'>
      <RoutingOption label={t('目标成员')} full><select aria-label={t('目标成员')} value={rule.use} onChange={event => update(index, { use: event.currentTarget.value })}>
        <option value=''>{t('选择成员')}</option>{members.map(member => <option key={member.id} value={member.id}>{member.group || `${member.provider} / ${member.model}`}</option>)}</select></RoutingOption>
      <div className='routing-magpie-field routing-magpie-full'><span>{t('额外目标成员')}</span>{members.filter(member => member.id !== rule.use).map(member => <label key={member.id} className='routing-magpie-inline'>
        <Checkbox disabled={rule.pause} checked={Boolean(rule.more?.includes(member.id))} onCheckedChange={on => update(index, { more: on ? [...(rule.more || []), member.id] : (rule.more || []).filter(id => id !== member.id) })} />{member.group || `${member.provider} / ${member.model}`}</label>)}</div>
      <RoutingOption label={t('输入 Token 阈值')}><Input disabled={rule.pause} type='number' min={0} max={100000000} value={rule.tokens || 0} onChange={event => update(index, { tokens: Number(event.currentTarget.value) })} /></RoutingOption>
      <RoutingOption label={t('最低推理等级')}><RoutingEffortSelect disabled={rule.pause} value={rule.effort} label={t('最低推理等级')} onChange={effort => update(index, { effort })} /></RoutingOption>
      <label className='routing-magpie-inline'><Checkbox disabled={rule.pause} checked={Boolean(rule.images)} onCheckedChange={value => update(index, { images: value === true })} />{t('包含图片')}</label>
      <label className='routing-magpie-inline'><Checkbox disabled={rule.pause} checked={Boolean(rule.compact)} onCheckedChange={value => update(index, { compact: value === true })} />{t('上下文压缩请求')}</label>
      <RoutingOption label={t('客户端（每行一个）')}><Textarea rows={2} value={(rule.agents || []).join('\n')} onChange={event => update(index, { agents: event.currentTarget.value.split('\n') })} /></RoutingOption>
      <RoutingOption label={t('意图')}><Input disabled={rule.pause} maxLength={200} value={rule.intent || ''} onChange={event => update(index, { intent: event.currentTarget.value })} /></RoutingOption>
      <RoutingOption label={t('命中后推理等级')}><RoutingEffortSelect disabled={rule.pause} value={rule.useEffort} label={t('命中后推理等级')} onChange={useEffort => update(index, { useEffort })} /></RoutingOption>
      <label className='routing-magpie-inline'><Checkbox checked={Boolean(rule.pause)} onCheckedChange={value => update(index, value ? { pause: true, tokens: 0, images: false, effort: '', intent: '', compact: false, more: [], useEffort: '' } : { pause: false })} />{t('命中时暂停目标成员')}</label>
    </div>
    <details className='routing-magpie-details'><summary>{t('时间与文件夹条件')}</summary><label className='routing-magpie-inline'><Checkbox checked={Boolean(rule.time)} onCheckedChange={on => update(index, {
      time: on ? { from: '09:00', to: '18:00', days: [], zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } : undefined,
    })} />{t('限制时间段')}</label>
      {rule.time ? <div className='routing-magpie-fields'><RoutingOption label={t('开始时间')}><Input type='time' value={rule.time.from} onChange={event => update(index, { time: { ...rule.time!, from: event.currentTarget.value } })} /></RoutingOption>
        <RoutingOption label={t('结束时间')}><Input type='time' value={rule.time.to} onChange={event => update(index, { time: { ...rule.time!, to: event.currentTarget.value } })} /></RoutingOption>
        <RoutingOption label={t('时区')} full><Input value={rule.time.zone} onChange={event => update(index, { time: { ...rule.time!, zone: event.currentTarget.value } })} /></RoutingOption>
        <div className='routing-magpie-levels routing-magpie-full'>{[['sun', '周日'], ['mon', '周一'], ['tue', '周二'], ['wed', '周三'], ['thu', '周四'], ['fri', '周五'], ['sat', '周六']].map(([day, label]) => <label key={day}><Checkbox checked={rule.time!.days.includes(day)} onCheckedChange={on => update(index, { time: { ...rule.time!, days: on ? [...rule.time!.days, day] : rule.time!.days.filter(value => value !== day) } })} />{t(label)}</label>)}</div>
      </div> : null}
      <div className='routing-magpie-fields'><RoutingOption label={t('匹配文件夹（每行一个）')}><Textarea rows={2} value={(rule.folders || []).join('\n')} onChange={event => update(index, { folders: event.currentTarget.value.split('\n') })} /></RoutingOption>
        <RoutingOption label={t('排除文件夹（每行一个）')}><Textarea rows={2} value={(rule.exceptFolders || []).join('\n')} onChange={event => update(index, { exceptFolders: event.currentTarget.value.split('\n') })} /></RoutingOption></div>
    </details>
  </section>)}<Button variant='outline' disabled={!members.length || rules.length >= 128} onClick={() => onChange([...rules, { use: members[0]?.id || '', more: [] }])}>{t('添加条件规则')}</Button></div>
}
