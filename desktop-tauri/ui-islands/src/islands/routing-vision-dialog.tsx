import * as React from 'react'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Spinner, confirmDialog } from '@ui'
import { t } from '../i18n'

type Config = { enabled: boolean; sources: string[]; target: string }
type View = { config: Config; models: { id: string; supports_images: boolean }[] }
export type VisionApi = (method: 'GET' | 'PUT', path: string, body?: Config) => Promise<View>
const endpoint = '/api/vision-compatibility'

export function VisionAssistSettings({ api }: { api: VisionApi }) {
  const [open, setOpen] = React.useState(false), [view, setView] = React.useState<View>(), [draft, setDraft] = React.useState<Config>()
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const run = async (save: boolean) => { setBusy(true); setError(''); setOpen(true)
    try { const result = await api(save ? 'PUT' : 'GET', endpoint, save ? draft : undefined); setView(result); setDraft(result.config); if (save) setOpen(false) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) } }
  const close = async () => { if (!busy && (JSON.stringify(view?.config) === JSON.stringify(draft) || await confirmDialog(t('放弃未保存的修改？')))) setOpen(false) }
  return <><Button size='sm' variant='outline' onClick={() => void run(false)}>{t('视觉辅助')}</Button><Dialog open={open} onOpenChange={next => { if (!next) void close() }}>
    <DialogContent><DialogHeader><DialogTitle>{t('视觉辅助')}</DialogTitle></DialogHeader><DialogBody className='grid gap-3'>
      <p>{t('文本组收到内嵌图片时，先调用视觉组描述图片，再由原文本组回答。两次上游调用分别计费；原生视觉组无需额外调用。')}</p>
      <p>{t('隐私模式不转发图片；无法识别或未获授权时不会改用其他组。')}</p>
      {busy && !view ? <Spinner /> : null}{error ? <p role='alert'>{error}</p> : null}
      {view && draft ? <fieldset disabled={busy} className='grid gap-3'><label><input type='checkbox' checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled:event.target.checked })} /> {t('启用')}</label>
        <label>{t('视觉目标组')}<select aria-label={t('视觉目标组')} value={draft.target} onChange={event => setDraft({ ...draft,target:event.target.value,sources:draft.sources.filter(id=>id!==event.target.value) })}><option value=''>{t('请选择')}</option>{view.models.filter(model=>model.supports_images).map(model=><option key={model.id} value={model.id}>{model.id}</option>)}</select></label>
        <fieldset className='grid gap-1'><legend>{t('来源路由组')}</legend>{view.models.filter(model=>model.id!==draft.target).map(model=><label key={model.id}><input type='checkbox' checked={draft.sources.includes(model.id)} onChange={event=>setDraft({...draft,sources:event.target.checked?[...draft.sources,model.id]:draft.sources.filter(id=>id!==model.id)})} /> {model.id}</label>)}</fieldset>
      </fieldset> : null}</DialogBody><DialogFooter><Button variant='outline' disabled={busy} onClick={()=>void close()}>{t('取消')}</Button><Button disabled={busy || !draft || (draft.enabled && (!draft.target || !draft.sources.length))} onClick={()=>void run(true)}>{t('保存')}</Button></DialogFooter></DialogContent></Dialog></>
}
