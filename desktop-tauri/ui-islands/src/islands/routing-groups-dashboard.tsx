import * as React from 'react'
import { Badge, Button, Checkbox, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Empty, Input, Label, Switch, Textarea } from '@ui'
import { ModelBrand } from '../../../ui-shared/model-brand'
import { t } from '../i18n'
import { groupDirty, type RouteGroupEditor } from './routing-group-state'
import { exportRoutingGroups, parseRoutingImport, routingGroupMatches, routingTemplate } from './routing-group-tools'
import { newRouteId } from './routing-group-form'
import { RouteIcon, strategyLabel, stickyLabel } from './routing-ui'
import { errorMessage, type RouteGroup } from './routing-types'
import './routing-magpie.css'

export function RoutingGroupsDashboard({ editor, onOpen, onCreate }: { editor: RouteGroupEditor; onOpen(id: string): void; onCreate(): void }) {
  const [search, setSearch] = React.useState('')
  const [hidden, setHidden] = React.useState(false)
  const [dialog, setDialog] = React.useState<'import' | 'export' | 'templates' | null>(null)
  const [text, setText] = React.useState('')
  const [error, setError] = React.useState('')
  const all = Object.values(editor.drafts).map(draft => draft.group)
  const found = (editor.data?.foundGroups || []).filter(row => !all.some(group => group.id === row.group.id))
  const visible = (group: RouteGroup) => (hidden || !group.hidden) && routingGroupMatches(group, search, editor.data?.catalog || [], all)
  const groups = all.filter(visible)
  const suggestions = found.filter(row => visible(row.group))
  const locked = editor.busy || editor.loading || !editor.data
  const open = (group: RouteGroup, suggested = false) => { if (!suggested || editor.create(group)) onOpen(group.id) }
  const share = (selection: RouteGroup[]) => { setText(exportRoutingGroups(selection, all)); setError(''); setDialog('export') }
  const reorder = (id: string, offset: number) => {
    const ids = (editor.data?.groups || []).map(row => row.group.id), index = ids.indexOf(id), target = index + offset
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    void editor.action({ action: 'arrange', ids })
  }
  const card = (group: RouteGroup, suggested: boolean) => {
    const draft = editor.drafts[group.id], dirty = draft ? groupDirty(draft) : false
    const index = (editor.data?.groups || []).findIndex(row => row.group.id === group.id)
    const saved = Boolean(draft?.baseline)
    return <article key={group.id} className='routing-magpie-card' data-routing-group={group.id} data-enabled={group.enabled !== false ? '' : undefined}>
      <header><span className='routing-group-symbol'><RouteIcon name='route' size={18} /></span>
        <button type='button' className='routing-magpie-card-title' onClick={() => open(group, suggested)}><strong>{group.name}</strong><code>{group.model}</code></button>
        {suggested ? <Badge variant='secondary' shape='tag'>{t('自动发现')}</Badge> : <div className='routing-card-state'>
          <span data-enabled={group.enabled !== false ? '' : undefined}>{!saved ? t('草稿') : group.enabled !== false ? t('已启用') : t('已停用')}</span>
          <Switch aria-label={t('启用路由组 {name}', { name: group.name })} checked={group.enabled !== false} disabled={locked || dirty}
            onCheckedChange={enabled => void editor.toggle(group.id, enabled)} /></div>}
      </header>
      <div className='routing-magpie-tags'><Badge variant='secondary' shape='tag'>{group.kind === 'image' ? t('图像') : t('对话')}</Badge><Badge variant='secondary' shape='tag'>{strategyLabel(group.strategy)}</Badge><span>{t('粘滞 {mode}', { mode: stickyLabel(group.sticky) })}</span>
        {group.rules?.length ? <span>{t('{n} 条规则', { n: group.rules.length })}</span> : null}
        {dirty ? <Badge variant='warning' shape='tag'>{t('有未保存的修改')}</Badge> : null}</div>
      {group.description ? <p className='routing-magpie-description'>{group.description}</p> : null}
      <div className='routing-card-members'>
        <div className='routing-card-members-head'><span>{t('参与模型')}</span><span>{t('{n} 个成员', { n: group.members.length })}</span></div>
        {group.members.slice(0, 3).map(member => {
          const nested = member.group ? all.find(child => child.id === member.group) : undefined
          const choice = editor.data?.catalog.find(choice => choice.provider === member.provider && choice.model.toLowerCase() === member.model.toLowerCase())
          const provider = choice?.providerLabel || editor.data?.catalog.find(choice => choice.provider === member.provider)?.providerLabel || member.provider
          return <div key={member.id} className='routing-card-member' data-excluded={member.included === false ? '' : undefined}>
            {member.group ? <span className='routing-nested-symbol'><RouteIcon name='route' size={14} /></span> : <ModelBrand id={member.provider} name={provider} size='small' />}
            <div><b title={member.group ? nested?.name || member.group : choice?.name || member.model}>{member.group ? nested?.name || member.group : choice?.name || member.model}</b>
              <small>{member.group ? nested?.model || t('嵌套路由组') : provider}</small></div>
            {member.included === false ? <span className='routing-member-state'>{t('未参与')}</span> : !member.group && (!choice || choice.accountCount <= 0) ? <span className='routing-member-state'>{t('不可用')}</span> : null}
          </div>
        })}
        {group.members.length > 3 ? <button type='button' className='routing-card-more' onClick={() => open(group, suggested)}>{t('查看全部 {n} 个成员', { n: group.members.length })}<RouteIcon name='chevronRight' size={12} /></button> : null}
        {!group.members.length ? <p className='routing-card-no-members'>{t('尚未添加成员，打开编辑后选择上游模型。')}</p> : null}
      </div>
      <footer><Button size='sm' variant='outline' disabled={locked} onClick={() => open(group, suggested)}>{suggested ? t('保存为路由组') : t('编辑路由组')}</Button>
        {!suggested && saved ? <div className='routing-card-tools'><Button size='icon-sm' variant='ghost' disabled={locked || dirty} aria-label={t('复制路由组')} title={t('复制路由组')} onClick={() => void editor.action({ action: 'copy', id: group.id })}><RouteIcon name='copy' size={14} /></Button><Button size='sm' variant='ghost' onClick={() => share([group])}>{t('导出')}</Button>
          <span className='routing-card-tool-divider' />
          <Button size='icon-sm' variant='ghost' disabled={locked || index <= 0} aria-label={t('上移 {name}', { name: group.name })} title={t('上移 {name}', { name: group.name })} onClick={() => reorder(group.id, -1)}>↑</Button>
          <Button size='icon-sm' variant='ghost' disabled={locked || index >= (editor.data?.groups.length || 0) - 1} aria-label={t('下移 {name}', { name: group.name })} title={t('下移 {name}', { name: group.name })} onClick={() => reorder(group.id, 1)}>↓</Button></div> : null}
        {suggested ? <Button size='sm' variant='ghost' disabled={locked} onClick={() => void editor.action({ action: 'hide', id: group.id, hidden: !group.hidden })}>{group.hidden ? t('恢复显示') : t('隐藏')}</Button> : null}
      </footer>
    </article>
  }
  return <section className='routing-magpie-dashboard' data-routing-dashboard>
    <header className='routing-magpie-toolbar routing-dashboard-heading'><div><div className='routing-dashboard-title'><h2>{t('路由组')}</h2><Badge variant='secondary' shape='tag'>{all.length}</Badge></div><p>{t('把模型组合成入口，按策略与条件选择上游。')}</p></div>
      <div className='routing-magpie-toolbar-actions'><Button variant='outline' disabled={locked} onClick={() => { setDialog('templates'); setError('') }}>{t('路由模板')}</Button>
        <Button variant='outline' disabled={locked} onClick={() => { setDialog('import'); setText(''); setError('') }}>{t('导入')}</Button>
        <Button variant='outline' disabled={!all.length} onClick={() => share(all)}>{t('导出全部')}</Button><Button disabled={locked} onClick={onCreate}><RouteIcon name='plus' size={14} />{t('新建路由组')}</Button></div>
    </header>
    <div className='routing-magpie-discovery'><div className='routing-discovery-copy'><label><Switch checked={Boolean(editor.data?.autoGroupsEnabled)} disabled={locked}
      onCheckedChange={enabled => void editor.action({ action: 'discovery', enabled })} /><b>{t('启用自动同模型路由')}</b></label>
      <p>{t('将两个以上已连接渠道中的同一模型组成 auto/ 入口；关闭时仅显示建议。')}</p></div>
      <div className='routing-discovery-meta'><Button size='sm' variant='ghost' disabled={locked} onClick={() => void editor.action({ action: 'refreshMetadata' })}><RouteIcon name='refresh' size={13} />{t('刷新模型信息')}</Button>
        {editor.data?.metadata ? <small>{editor.data.metadata.source} · {t('{n} 个模型', { n: editor.data.metadata.count })}{editor.data.metadata.stale ? ` · ${t('使用缓存')}` : ''}</small> : null}
        {editor.data?.metadata?.error ? <small role='status'>{t('模型信息更新失败，继续使用缓存。')}</small> : null}</div>
    </div>
    <div className='routing-magpie-toolbar routing-dashboard-filter'><div className='routing-search-field'><RouteIcon name='search' size={15} /><Input value={search} onChange={event => setSearch(event.currentTarget.value)} placeholder={t('搜索路由组、厂商或模型')} aria-label={t('搜索路由组、厂商或模型')} /></div>
      <label className='routing-magpie-inline'><Checkbox checked={hidden} onCheckedChange={value => setHidden(value === true)} />{t('显示隐藏项')}</label></div>
    {editor.error ? <p role='alert' className='routing-config-error'>{editor.error}<Button variant='link' disabled={locked} onClick={() => void editor.load()}>{t('刷新目录，保留草稿')}</Button></p> : null}
    <div className='routing-magpie-cards'>{groups.map(group => card(group, false))}</div>
    {suggestions.length ? <><div className='routing-dashboard-section-title'><h3>{t('自动发现建议')}</h3><Badge variant='secondary' shape='tag'>{suggestions.length}</Badge></div><div className='routing-magpie-cards'>{suggestions.map(row => card(row.group, true))}</div></> : null}
    {!groups.length && !suggestions.length ? <div className='routing-dashboard-empty'><span className='routing-group-symbol'><RouteIcon name='route' size={22} /></span><Empty>{editor.loading ? t('加载中…') : t('没有匹配的路由组')}</Empty>
      {!editor.loading ? <><p>{search.trim() ? t('试试其他名称，或清空搜索。') : t('新建路由组，将多个模型组合为一个对外入口。')}</p>{search.trim() ? <Button variant='outline' disabled={locked} onClick={() => setSearch('')}>{t('清空搜索')}</Button> : null}</> : null}
    </div> : null}
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value && !editor.busy) setDialog(null) }}><DialogContent className='w-[min(720px,calc(100vw-32px))]'>
      <DialogHeader><DialogTitle>{dialog === 'templates' ? t('路由模板') : dialog === 'export' ? t('导出路由组') : t('导入路由组')}</DialogTitle></DialogHeader>
      <DialogBody>{dialog === 'templates' ? <div className='routing-magpie-template-list'>{[['fallback', '顺序回退'], ['balanced', '均衡分担'], ['fast', '低延迟优先'], ['budget', '免费优先']].map(([kind, label]) =>
        <Button key={kind} variant='outline' disabled={!editor.data?.catalog.some(choice => choice.accountCount > 0 && (choice.kind || 'chat') === 'chat')} onClick={() => {
          const draft = routingTemplate(kind, editor.data?.catalog || [], newRouteId()); draft.name = t(label)
          if (editor.create(draft)) { setDialog(null); onOpen(draft.id) }
        }}>{t(label)}</Button>)}<p>{t('模板使用已连接的模型生成停用草稿，确认后保存。')}</p></div> : <>
          <p className='text-xs text-subtle'>{dialog === 'export' ? t('分享文件不包含凭证或账号 ID；含本地文件夹条件的规则会整条排除。导入后请检查账号范围。') : t('粘贴 version: 1 路由组 JSON，每次最多 100 组。导入后的路由组默认停用。')}</p>
          <Label htmlFor='routing-transfer-json'>{t('路由组 JSON')}</Label><Textarea id='routing-transfer-json' className='font-mono text-xs' rows={14} value={text} readOnly={dialog === 'export'} onChange={event => setText(event.currentTarget.value)} />
        </>}{error ? <p role='alert' className='routing-config-error'>{error}</p> : null}</DialogBody>
      <DialogFooter><Button variant='outline' disabled={editor.busy} onClick={() => setDialog(null)}>{t('关闭')}</Button>
        {dialog === 'import' ? <Button disabled={locked || !text.trim()} onClick={async () => {
          try { const rows = parseRoutingImport(text); if (await editor.action({ action: 'import', groups: rows })) setDialog(null) }
          catch (failure) { setError(t(errorMessage(failure))) }
        }}>{t('导入路由组')}</Button> : dialog === 'export' ? <Button onClick={() => {
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const anchor = document.createElement('a')
          anchor.href = url; anchor.download = 'routing-groups.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
        }}>{t('下载 JSON')}</Button> : null}</DialogFooter>
    </DialogContent></Dialog>
  </section>
}
