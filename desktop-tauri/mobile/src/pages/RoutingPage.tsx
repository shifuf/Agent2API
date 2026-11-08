import * as React from 'react'
import { Button, Input, Switch } from '@ui'
import { t } from '../i18n'
import { store } from '../state/store'
import { routingApi, fetchRoutingWorkspace } from '../api/routing'
import { groupDirty, useRouteGroups } from '../../../ui-islands/src/islands/routing-group-state'
import { RoutingGroupsDashboard } from '../../../ui-islands/src/islands/routing-groups-dashboard'
import { RoutingGroupOptions, RoutingMemberOptions, RoutingOption } from '../../../ui-islands/src/islands/routing-group-options'
import { RoutingMemberDialog, RoutingMemberAccounts } from '../../../ui-islands/src/islands/routing-group-dialogs'
import { newRouteId } from '../../../ui-islands/src/islands/routing-group-form'
import type { RouteGroup, RoutingWorkspace } from '../../../ui-islands/src/islands/routing-types'
import { RoutingPreviewPanel } from '../../../ui-islands/src/islands/routing-preview-panel'
import { useRoutingPreviewMembers } from '../../../ui-islands/src/islands/routing-preview-members'

export function RoutingPage() {
  const [workspace, setWorkspace] = React.useState<RoutingWorkspace | null>(null)
  const [view, setView] = React.useState('')
  const [dialog, setDialog] = React.useState<'add' | string | null>(null)
  const refresh = React.useCallback(() => { void fetchRoutingWorkspace().then(setWorkspace).catch(error => store.toast(String(error), 'err')) }, [])
  const removed = React.useCallback(() => setView(''), [])
  const editor = useRouteGroups(refresh, removed, routingApi)
  React.useEffect(refresh, [refresh])
  const open = (id: string) => { editor.select(id); setView(id) }
  const group = view ? editor.draft?.group : undefined
  const preview = useRoutingPreviewMembers(group, editor.data, routingApi.previewRouting)
  const groups = Object.values(editor.drafts).map(draft => draft.group)
  const accounts = workspace?.accounts || []
  const locked = editor.busy || editor.loading
  const mutate = (patch: Partial<RouteGroup>) => editor.update(next => Object.assign(next, patch))
  const member = group?.members.find(item => item.id === dialog)
  return <div className='routing-magpie-mobile'>
    {!group ? <RoutingGroupsDashboard editor={editor} onOpen={open} onCreate={() => {
      const id = newRouteId()
      if (editor.create({ id, name: t('新路由组'), model: `group-${id.slice(0, 8)}`, description: '', strategy: 'order', sticky: 'auto', enabled: false, patience: 0, members: [] })) open(id)
    }} /> : <section className='routing-magpie-mobile-editor' data-mobile-routing-editor>
      <div className='routing-magpie-toolbar'><Button variant='outline' onClick={() => setView('')}>{t('返回路由组')}</Button>
        <Button variant='ghost' disabled={locked} onClick={() => void editor.load()}>{t('刷新目录，保留草稿')}</Button></div>
      <fieldset disabled={locked} className='routing-magpie-fields'><RoutingOption label={t('组名')}><Input value={group.name} onChange={event => mutate({ name: event.currentTarget.value })} /></RoutingOption>
        <RoutingOption label={t('对外模型 ID')}><Input value={group.model} onChange={event => mutate({ model: event.currentTarget.value })} /></RoutingOption></fieldset>
      <RoutingGroupOptions group={group} choices={editor.data?.catalog || []} groups={groups} expandedMembers={preview.expandedMembers} disabled={locked} update={editor.update} />
      <RoutingPreviewPanel model={group.model} group={group} preview={preview.preview} onOpenScope={model => {
        const target = groups.find(item => item.model === model)
        if (target) open(target.id)
      }} />
      <div className='routing-magpie-toolbar'><h3>{t('成员模型')}</h3><Button variant='outline' disabled={locked} onClick={() => setDialog('add')}>{t('添加成员')}</Button></div>
      {group.members.map((item, index) => <article key={item.id} className='routing-magpie-card'>
        <header><strong className='break-all'>{item.group ? groups.find(child => child.id === item.group)?.name || item.group : item.model}</strong>
          <Switch checked={item.included} aria-label={t('{model} 参与本路由', { model: item.model || item.group || '' })} disabled={locked} onCheckedChange={included => editor.update(next => { next.members[index].included = included })} /></header>
        <small>{item.group ? t('嵌套路由组') : item.provider}</small>
        <RoutingMemberOptions member={item} disabled={locked} onChange={patch => editor.update(next => Object.assign(next.members[index], patch))} />
        <footer><Button size='sm' variant='outline' disabled={locked || index === 0} aria-label={t('提高优先级')} onClick={() => editor.update(next => { [next.members[index - 1], next.members[index]] = [next.members[index], next.members[index - 1]] })}>↑</Button>
          <Button size='sm' variant='outline' disabled={locked || index === group.members.length - 1} aria-label={t('降低优先级')} onClick={() => editor.update(next => { [next.members[index + 1], next.members[index]] = [next.members[index], next.members[index + 1]] })}>↓</Button>
          {!item.group ? <Button size='sm' variant='outline' disabled={locked || item.accountScope === 'all'} onClick={() => setDialog(item.id)}>{t('参与账号')}</Button> : null}
          <Button size='sm' variant='ghost' disabled={locked || group.rules?.some(rule => rule.use === item.id || rule.more?.includes(item.id))} onClick={() => editor.update(next => { next.members.splice(index, 1) })}>{t('移除成员')}</Button></footer>
      </article>)}
      {editor.error ? <p className='routing-config-error' role='alert'>{editor.error}</p> : null}
      <div className='routing-magpie-toolbar'><Button variant='outline' disabled={locked} onClick={editor.discard}>{t('撤销修改')}</Button>
        <Button disabled={locked || !editor.draft || !groupDirty(editor.draft)} onClick={() => void editor.save()}>{t('保存路由')}</Button>
        <Button variant='ghost' disabled={locked} onClick={() => void editor.remove()}>{t('删除路由组')}</Button></div>
    </section>}
    {group && dialog === 'add' ? <RoutingMemberDialog choices={editor.data?.catalog || []} members={group.members} accounts={accounts}
      groups={Object.values(editor.drafts).filter(draft => draft.baseline).map(draft => draft.group)} currentId={group.id}
      onAdd={members => editor.update(next => next.members.push(...members))} onClose={() => setDialog(null)} /> : null}
    {member ? <RoutingMemberAccounts member={member} accounts={accounts} onSave={ids => editor.update(next => { const row = next.members.find(item => item.id === member.id); if (row) row.accounts = ids })} onClose={() => setDialog(null)} /> : null}
  </div>
}
