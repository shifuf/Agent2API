import { Badge, Button, Checkbox, Input } from '@ui'
import { t } from '../i18n'
import { routingEfforts, routingSelectableMembers } from './routing-group-tools'
import type { RouteClassification, RouteGroup, RouteMember, RouteRequestFacts, RouteRuleTrace } from './routing-types'
import './routing-preview-rules.css'

export function RoutingPreviewFacts({ facts, classification, imagesRequired, onFacts, onClassification }: {
  facts: RouteRequestFacts; classification?: RouteClassification; imagesRequired: boolean
  onFacts(facts: RouteRequestFacts): void; onClassification(value: RouteClassification | undefined): void
}) {
  const change = (patch: Partial<RouteRequestFacts>) => onFacts({ ...facts, ...patch })
  const date = facts.atMs ? new Date(facts.atMs) : null
  const localTime = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
  const effortOptions = <><option value=''>{t('未指定')}</option>{routingEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</>
  return <details className='routing-preview-rule-details' data-routing-preview-inputs><summary>{t('规则预演输入')}</summary>
    <div className='routing-preview-facts-grid'>
      <label><span>{t('预演输入 Token 数')}</span><Input type='number' min={0} max={100000000} value={facts.tokens || 0}
        onChange={event => change({ tokens: Math.max(0, Math.min(100000000, Math.floor(Number(event.currentTarget.value) || 0))) })} /></label>
      <label><span>{t('预演请求推理等级')}</span><select value={facts.effort || ''} onChange={event => change({ effort: event.currentTarget.value })}>{effortOptions}</select></label>
      <label><span>{t('预演客户端')}</span><Input value={facts.agent || ''} maxLength={200} onChange={event => change({ agent: event.currentTarget.value })} /></label>
      <label><span>{t('预演时间（本地时间）')}</span><Input type='datetime-local' value={localTime} onChange={event => {
        const atMs = event.currentTarget.value ? new Date(event.currentTarget.value).getTime() : undefined
        change({ atMs: atMs !== undefined && Number.isFinite(atMs) ? atMs : undefined })
      }} /></label>
      <label className='routing-preview-facts-toggle'><Checkbox checked={imagesRequired || Boolean(facts.images)} disabled={imagesRequired} onCheckedChange={value => change({ images: value === true })} />{t('预演包含图片')}</label>
      <label className='routing-preview-facts-toggle'><Checkbox checked={Boolean(facts.compact)} onCheckedChange={value => change({ compact: value === true })} />{t('预演上下文压缩')}</label>
      <label><span>{t('预演工作目录')}</span><Input value={facts.folder || ''} onChange={event => change({ folder: event.currentTarget.value })} /></label>
      <label><span>{t('预演用户目录')}</span><Input value={facts.home || ''} onChange={event => change({ home: event.currentTarget.value })} /></label>
      <label className='routing-preview-facts-toggle routing-preview-facts-full'><Checkbox checked={Boolean(classification)} onCheckedChange={value => onClassification(value ? { intent: '', effort: '' } : undefined)} />{t('提供模拟分类结果')}</label>
      {classification ? <>
        <label><span>{t('模拟分类意图')}</span><Input maxLength={200} value={classification.intent} onChange={event => onClassification({ ...classification, intent: event.currentTarget.value })} /></label>
        <label><span>{t('模拟分类推理等级')}</span><select value={classification.effort} onChange={event => onClassification({ ...classification, effort: event.currentTarget.value })}>{effortOptions}</select></label>
      </> : null}
    </div>
    <p>{t('时间留空时使用当前时间；用户目录用于展开 ~。预演不会调用意图分类器。')}</p>
    <Button variant='ghost' size='sm' onClick={() => { onFacts({}); onClassification(undefined) }}>{t('重置预演输入')}</Button>
  </details>
}

export function RoutingPreviewRuleTrace({ rules, group, expandedMembers, loading }: { rules?: RouteRuleTrace[]; group: RouteGroup; expandedMembers?: RouteMember[]; loading: boolean }) {
  const members = routingSelectableMembers(group, expandedMembers)
  const memberLabel = (id: string) => {
    const member = members.find(member => member.id === id)
    return member ? member.group || `${member.provider} / ${member.model}` : id
  }
  return <details className='routing-preview-rule-details' data-routing-rule-trace><summary>{t('规则命中记录')}</summary>
    {loading ? <p>{t('计算中…')}</p> : !rules?.length ? <p>{t('没有规则预演结果')}</p> : rules.map(trace => <section className='routing-preview-rule-trace' key={trace.groupId} data-rule-trace-group={trace.groupId}>
      <header><strong>{trace.groupId === group.id ? group.name : trace.groupId}</strong><Badge shape='tag' variant='secondary'>{trace.classifier?.state === 'provided-for-preview' ? t('使用模拟分类结果') : t('预演未调用分类器')}</Badge></header>
      {trace.decision.matched.length ? trace.decision.matched.map(match => <article key={match.index} data-rule-match={match.index}>
        <b>{t('规则 {n}', { n: match.index + 1 })} · {match.pause ? t('暂停成员') : t('优先成员')}</b>
        <p>{match.targets.map(memberLabel).join(' → ')}</p>
        <ul>{match.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
      </article>) : <p>{t('没有命中规则')}</p>}
      {trace.decision.preferred.length ? <p>{t('优先成员')}：{trace.decision.preferred.map(memberLabel).join(' → ')}</p> : null}
      {trace.decision.excluded.length ? <p>{t('暂停成员')}：{trace.decision.excluded.map(memberLabel).join('、')}</p> : null}
      {trace.decision.effort ? <p>{t('分类推理等级')}：{trace.decision.effort}</p> : null}
      {Object.entries(trace.decision.effortByMember).map(([member, effort]) => <p key={member}>{memberLabel(member)} · {t('命中后推理等级')}：{effort}</p>)}
      {trace.decision.intents.length ? <p>{t('待判断意图')}：{trace.decision.intents.join('、')}</p> : null}
    </section>)}
  </details>
}
