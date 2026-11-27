import * as React from 'react'
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Spinner, confirmDialog } from '@ui'
import { t } from '../i18n'

const endpoint = '/api/tools/image-generation/config'
type Target = { model: string }
type Limits = 'max_images' | 'max_concurrency' | 'retention_hours' | 'storage_mb'
type Config = Record<Limits, number> & { generation: Target; editing: Target | null }
type View = { config: Config | null; models: { id: string; supports_image_generation?: boolean; supports_image_editing?: boolean }[] }
export type ImageConfigApi = (method: 'GET' | 'PUT' | 'DELETE', path: string, body?: Config) => Promise<View>
const defaults: Config = { generation: { model: '' }, editing: null, max_images: 1, max_concurrency: 2, retention_hours: 1, storage_mb: 64 }

export function ToolImageConfig({ api }: { api: ImageConfigApi }) {
  const [view, setView] = React.useState<View>(), [draft, setDraft] = React.useState(defaults)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [notice, setNotice] = React.useState('')
  const adopt = (next: View) => { setView(next); setDraft(next.config || defaults) }
  React.useEffect(() => { let active = true; api('GET', endpoint).then(next => { if (active) adopt(next) }).catch(reason => { if (active) setError(String(reason)) }); return () => { active = false } }, [api])
  const persist = async (clear: boolean) => {
    if (clear && !await confirmDialog(t('清除配置？'))) return
    setBusy(true); setError(''); setNotice('')
    try { adopt(await api(clear ? 'DELETE' : 'PUT', endpoint, clear ? undefined : draft)); setNotice(t('配置已保存')) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  const limits: [Limits, string, number, number][] = [['max_images', t('每次最多生成图片数'), 1, 4], ['max_concurrency', t('最大并发任务数'), 1, 4],
    ['retention_hours', t('保留时间（小时）'), 1, 24], ['storage_mb', t('存储上限（MB）'), 64, 512]]
  return <Card><CardHeader><CardTitle>{t('图片生成与编辑')}</CardTitle></CardHeader><CardContent>
    <p className='mb-2 text-xs text-subtle'>{t('仅可选择已发布的图片路由组；每次调用仍检查网关 Key 权限。')}</p>
    {!view && !error ? <Spinner /> : null}{error ? <Alert variant='destructive'>{error}</Alert> : null}{notice ? <p role='status'>{notice}</p> : null}
    {view ? <form className='grid gap-3' onSubmit={event => { event.preventDefault(); void persist(false) }}>
      {(['generation', 'editing'] as const).map(field => { const label = field === 'generation' ? t('图片生成路由组') : t('图片编辑路由组'); const flag = field === 'generation' ? 'supports_image_generation' : 'supports_image_editing'
        return <label key={field} className='grid gap-1'>{label}<select aria-label={label} required={field === 'generation'} value={draft[field]?.model || ''} onChange={event => { const model = event.target.value; setDraft({ ...draft, [field]: model || field === 'generation' ? { model } : null }); setNotice('') }}>
          <option value=''>{field === 'generation' ? t('请选择') : t('未启用')}</option>{view.models.filter(model => model[flag]).map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
        </select></label> })}
      {limits.map(([key, label, min, max]) => <label key={key}>{label}<Input type='number' required min={min} max={max} value={draft[key] || ''} onChange={event => { setDraft({ ...draft, [key]: Number(event.target.value) }); setNotice('') }} /></label>)}
      <div className='flex gap-2'><Button size='sm' type='submit' disabled={busy || !draft.generation.model}>{t('保存')}</Button><Button size='sm' type='button' variant='outline' disabled={busy || !view.config} onClick={() => void persist(true)}>{t('清除配置')}</Button></div>
    </form> : null}</CardContent></Card>
}
