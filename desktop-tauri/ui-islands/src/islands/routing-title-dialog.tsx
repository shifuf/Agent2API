import * as React from 'react'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Spinner, confirmDialog } from '@ui'
import { t } from '../i18n'

type Rule = { enabled: boolean; model: string; clients: string[]; fallback: 'error' }
type Config = { enabled: boolean; rules: Rule[] }
type View = { config: Config; revision: string; models: { id: string }[]; clients: { id: string; label: string }[] }
export type TitleRoutesApi = { getTitleRoutes(): Promise<View>; saveTitleRoutes(input: { config: Config; revision: string }): Promise<View> }

export function TitleRouteSettings({ api }: { api?: TitleRoutesApi }) {
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<View>(), [draft, setDraft] = React.useState<Config>()
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const dirty = !!view && JSON.stringify(view.config) !== JSON.stringify(draft)
  const service = () => api || (window as unknown as { workbuddyDesktop: TitleRoutesApi }).workbuddyDesktop
  const load = async () => {
    setOpen(true); setBusy(true); setError('')
    try { const next = await service().getTitleRoutes(); setView(next); setDraft(next.config) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const close = async () => {
    if (busy || (dirty && !await confirmDialog(t('放弃未保存的修改？')))) return
    setOpen(false); setView(undefined); setDraft(undefined)
  }
  const save = async () => {
    if (!draft || !view) return
    setBusy(true); setError('')
    try { const next = await service().saveTitleRoutes({ config: draft, revision: view.revision }); setView(next); setDraft(next.config); setOpen(false) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const update = (index: number, patch: Partial<Rule>) => draft && setDraft({ ...draft, rules: draft.rules.map((rule, at) => at === index ? { ...rule, ...patch } : rule) })
  const move = (index: number, offset: number) => {
    if (!draft) return
    const rules = [...draft.rules]; [rules[index], rules[index + offset]] = [rules[index + offset], rules[index]]; setDraft({ ...draft, rules })
  }
  return <><Button variant='outline' size='sm' onClick={() => void load()}>{t('标题生成')}</Button>
    <Dialog open={open} onOpenChange={next => { if (!next) void close() }}><DialogContent className='w-[min(560px,calc(100vw-24px))]'>
      <DialogHeader><DialogTitle>{t('标题生成')}</DialogTitle></DialogHeader>
      <DialogBody className='grid gap-3 overflow-y-auto'>
        {busy && !view ? <Spinner /> : null}
        {error ? <p role='alert' className='text-danger'>{error}</p> : null}
        {view && draft ? <fieldset disabled={busy} className='grid gap-3'>
          <p>{t('只改写被识别为标题生成的小请求，普通对话不受影响。')}</p><p>{t('目标不可用或未授权时返回错误，不回退原模型。')}</p>
          <label><input type='checkbox' checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /> {t('启用')}</label>
          {draft.rules.map((rule, index) => <fieldset key={index} className='grid gap-2 rounded-md border border-border p-3'>
            <legend>{t('优先级 {index}', { index: index + 1 })}</legend>
            <label><input type='checkbox' checked={rule.enabled} onChange={event => update(index, { enabled: event.target.checked })} /> {t('启用规则')}</label>
            <div className='flex flex-wrap gap-2'>{view.clients.map(client => <label key={client.id}>
              <input type='checkbox' checked={rule.clients.includes(client.id)} onChange={event => update(index, { clients: event.target.checked ? [...rule.clients, client.id] : rule.clients.filter(id => id !== client.id) })} /> {client.label}
            </label>)}</div>
            <label>{t('标题模型')} <select className='max-w-full' value={rule.model} onChange={event => update(index, { model: event.target.value })}>
              <option value=''>{t('选择模型')}</option>
              {rule.model && !view.models.some(model => model.id === rule.model) ? <option value={rule.model}>{rule.model} · {t('不可用')}</option> : null}
              {view.models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
            </select></label>
            <div className='flex flex-wrap gap-2'><Button size='sm' variant='outline' aria-label={t('提高优先级')} disabled={!index} onClick={() => move(index, -1)}>↑</Button>
              <Button size='sm' variant='outline' aria-label={t('降低优先级')} disabled={index === draft.rules.length - 1} onClick={() => move(index, 1)}>↓</Button>
              <Button size='sm' variant='ghost' onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, row) => row !== index) })}>{t('移除')}</Button></div>
          </fieldset>)}
          <Button variant='outline' disabled={draft.rules.length >= 32} onClick={() => setDraft({ ...draft, rules: [...draft.rules, { enabled: true, clients: [], model: '', fallback: 'error' }] })}>{t('添加规则')}</Button>
        </fieldset> : null}
      </DialogBody><DialogFooter><Button variant='outline' disabled={busy} onClick={() => void close()}>{t('取消')}</Button>
        {error ? <Button variant='outline' disabled={busy} onClick={async () => { if (!dirty || await confirmDialog(t('放弃未保存的修改？'))) void load() }}>{t('重新读取')}</Button> : null}
        <Button disabled={busy || !dirty} onClick={() => void save()}>{t('保存')}</Button></DialogFooter>
    </DialogContent></Dialog></>
}
