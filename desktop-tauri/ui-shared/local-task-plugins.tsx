import { useState } from 'react'

type FieldValue = string | boolean | number | string[]
type Field = { key: string; label: string; type: string; secret?: boolean; required?: boolean; placeholder?: string; description?: string; defaultValue?: FieldValue; min?: number; max?: number; when?: {key:string;equals:string}; options?: { value: string; label: string }[] }
type Plugin = { id: string; name: string; enabled: boolean; notifyAllowed: boolean; declaresNotify: boolean; domains: string[]; networkGrants: Record<string,string>; updatedAt: number; fields: Field[]; defaultCron: string; defaultTimezone: string; scriptBody: string }
type Job = { id: string; pluginId: string; name: string; enabled: boolean; nextRunAt?: number; lastStatus?: string }
type StoreItem = { id: string; name: string; version: string; sha256: string; size: number }
type Result = { plugins?: Plugin[]; jobs?: Job[]; items?: StoreItem[]; rawScript?: string; outcome?: { success: boolean; error?: string }; runs?: { status: string }[] }
export type TaskPluginRequest = (method: 'GET' | 'POST' | 'PUT', route: string, payload?: unknown) => Promise<Result>
const example = '/* @agent2api-task-plugin\n{"id":"local-example","name":"Local example","version":"0.1.0"}\n*/\nexport async function onSchedule(ctx) { return 21; }'

function parseEditor(text: string): {id: string; payload: unknown} {
  if (text.trimStart().startsWith('/*')) {
    const header = /^\s*\/\*\s*@agent2api-task-plugin\s*([\s\S]+?)\*\//.exec(text)
    return {id: header ? JSON.parse(header[1]).id : '', payload:{rawScript:text}}
  }
  const payload = JSON.parse(text)
  return {id:payload.id,payload}
}

function ProbeConsent({domain,approved,busy,save,t}:{domain:string;approved?:string;busy:boolean;save:(url?:string)=>void;t:(key:string)=>string}) {
  const [draft,setDraft]=useState(approved??`https://${domain}/`)
  return <div style={{display:'grid',gap:4,minWidth:0}}>
    <label>{domain} · {t('公开状态地址（不含秘密）')}<input type='url' value={draft} onChange={event=>setDraft(event.target.value)} autoComplete='off' spellCheck={false} /></label>
    {approved && <small>{t('已授权的直连地址')}：{approved}</small>}
    <div><button data-probe-grant type='button' disabled={busy||!draft||draft===approved} onClick={()=>save(draft)}>{t('授权直连探测')}</button>{' '}
    {approved && <button data-probe-revoke type='button' disabled={busy} onClick={()=>save()}>{t('撤销探测授权')}</button>}</div>
  </div>
}

function TaskField({field,value,change}:{field:Field;value:FieldValue|undefined;change:(value:FieldValue)=>void}) {
  const plain=typeof value==='string'||typeof value==='number'?value:''
  const input={required:field.required,placeholder:field.placeholder,autoComplete:'off'}
  let control
  if (field.secret || field.type==='password') control=<input {...input} type='password' value={plain} onChange={event=>change(event.target.value)} />
  else if (field.type==='switch') control=<input type='checkbox' checked={value===true} onChange={event=>change(event.target.checked)} />
  else if (field.type==='textarea') control=<textarea {...input} value={plain} onChange={event=>change(event.target.value)} />
  else if (field.type==='multiselect') control=<select required={field.required} multiple value={Array.isArray(value)?value:[]} onChange={event=>change(Array.from(event.target.selectedOptions,option=>option.value))}>{field.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>
  else if (field.options?.length) control=<select required={field.required} value={plain} onChange={event=>change(event.target.value)}><option value=''>—</option>{field.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>
  else if (field.type==='number') control=<input {...input} type='number' value={plain} min={field.min} max={field.max} onChange={event=>change(event.target.value===''?'':event.target.valueAsNumber)} />
  else control=<input {...input} value={plain} onChange={event=>change(event.target.value)} />
  return <label>{field.label}{control}{field.description && <small>{field.description}</small>}</label>
}

export function LocalTaskPlugins({ api, t }: { api: TaskPluginRequest; t: (key: string) => string }) {
  const [open, setOpen] = useState(false), [plugins, setPlugins] = useState<Plugin[]>([]), [jobs, setJobs] = useState<Job[]>([])
  const [active, setActive] = useState(''), [name, setName] = useState(''), [cron, setCron] = useState('0 9 * * *'), [zone, setZone] = useState('Asia/Shanghai')
  const [values, setValues] = useState<Record<string,FieldValue>>({}), [text, setText] = useState(example), [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [items,setItems] = useState<StoreItem[]>([])
  const selected = plugins.find(plugin => plugin.id === active)
  function choose(plugin?: Plugin) { setActive(plugin?.id || ''); setName(plugin?.name || ''); setCron(plugin?.defaultCron || '0 9 * * *'); setZone(plugin?.defaultTimezone || 'Asia/Shanghai'); setValues(Object.fromEntries((plugin?.fields || []).filter(field=>!field.secret && field.defaultValue!=null).map(field=>[field.key,field.defaultValue!]))) }
  const shown=selected?.fields.filter(field=>!field.when || String(values[field.when.key] ?? '')===field.when.equals) || []
  async function reload() { const [catalog, instances, store] = await Promise.all([api('GET','task-plugins'), api('GET','task-jobs'), api('GET','task-plugins/store')]); setPlugins(catalog.plugins || []); setJobs(instances.jobs || []); setItems(store.items || []) }
  async function perform(action: () => Promise<unknown>) { setBusy(true); setMessage(''); try { const result = await action() as Result | undefined; await reload(); setMessage(result?.outcome?.error || (result?.runs ? result.runs.map(run => run.status).join(', ') || '—' : t('操作成功'))) } catch (error) { setMessage(error instanceof Error ? error.message : t('操作失败')) } finally { setBusy(false) } }
  function modify(plugin: Plugin, update: Record<string,unknown>) { void perform(() => api('POST',`task-plugins/${plugin.id}/permissions`,update)) }
  return <section data-local-task-plugins style={{flex:'none',minWidth:0,padding:12}}>
    <button type='button' aria-expanded={open} onClick={() => { if (!open) void perform(async()=>undefined); setOpen(!open); setValues({}) }}>{t('本地任务插件')}</button>
    {open && <div style={{display:'grid',gap:10,minWidth:0}}>
      <p>{t('脚本没有通用 HTTP 权限。状态探测只直连已授权的固定 HTTPS 地址，每次运行最多一次，只返回状态码。预览、跳转和绑定代理的实例不联网。')}</p>
      <p>{t('编辑、停用或恢复插件后须重新授权。商店只在手动刷新或下载时联网。')}</p>
      <div><button type='button' disabled={busy} onClick={()=>void perform(()=>api('POST','task-plugins/store/refresh',{}))}>{t('刷新任务插件商店')}</button>
        {items.map(item=><div key={item.id}>{item.name} · {item.version}{' '}<button disabled={busy||plugins.some(plugin=>plugin.id===item.id)} onClick={()=>void perform(()=>api('POST','task-plugins/install-store',{id:item.id,sha256:item.sha256}))}>{t('校验签名并安装')}</button></div>)}</div>
      <label>{t('插件清单与脚本')}<textarea data-task-manifest value={text} rows={6} style={{width:'100%'}} onChange={event => setText(event.target.value)} /></label>
      <div><button disabled={busy} onClick={() => void perform(() => api('POST','task-plugins/preview',{plugin:parseEditor(text).payload}))}>{t('试跑')}</button>{' '}
        <button disabled={busy} onClick={() => void perform(() => { const {id,payload}=parseEditor(text); const exists=plugins.some(plugin=>plugin.id===id); return api(exists?'PUT':'POST',exists?`task-plugins/${id}`:'task-plugins',payload) })}>{t('保存插件')}</button></div>
      {plugins.map(plugin => <div key={plugin.id} data-probe-plugin={plugin.id}>
        <button disabled={busy} onClick={() => { choose(plugin); void perform(async()=> { const exported=await api('GET',`task-plugins/${plugin.id}/script`); setText(exported.rawScript || '') }) }}>{plugin.name}</button>{' '}
        <label><input type='checkbox' checked={plugin.enabled} disabled={busy} onChange={event => modify(plugin,{enabled:event.target.checked})} />{t('启用')}</label>{' '}
        {plugin.declaresNotify && <label><input type='checkbox' checked={plugin.notifyAllowed} disabled={busy} onChange={event => modify(plugin,{notifyAllowed:event.target.checked})} />{t('授权发送通知')}</label>}
        {plugin.domains?.map(domain=><ProbeConsent key={`${domain}:${plugin.updatedAt}`} domain={domain} approved={plugin.networkGrants?.[domain]} busy={busy} t={t} save={url=>{const networkGrants={...plugin.networkGrants}; if(url) networkGrants[domain]=url; else delete networkGrants[domain]; modify(plugin,{networkGrants,expectedUpdatedAt:plugin.updatedAt})}} />)}
      </div>)}
      {selected && <form onSubmit={event => { event.preventDefault(); void perform(async () => { await api('POST','task-jobs',{pluginId:selected.id,name,cronExpression:cron,timezone:zone,values:Object.fromEntries(shown.filter(field=>field.key in values).map(field=>[field.key,values[field.key]])),enabled:false}); choose(selected) }) }}>
        <label>{t('名称')}<input data-task-name required value={name} onChange={event=>setName(event.target.value)} /></label>
        <label>Cron <input required value={cron} onChange={event=>setCron(event.target.value)} /></label><label>{t('时区')}<input required value={zone} onChange={event=>setZone(event.target.value)} /></label>
        {shown.map(field=><TaskField key={field.key} field={field} value={values[field.key]} change={value=>setValues({...values,[field.key]:value})} />)}
        <button disabled={busy}>{t('创建停用的实例')}</button>
      </form>}
      {jobs.map(job=><div key={job.id}>{job.name} · {job.lastStatus || '—'} · {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : '—'}{' '}
        <label><input type='checkbox' disabled={busy} checked={job.enabled} onChange={event=>void perform(()=>api('PUT',`task-jobs/${job.id}`,{enabled:event.target.checked}))} />{t('定时执行')}</label>{' '}
        <button disabled={busy} onClick={()=>void perform(()=>api('POST',`task-jobs/${job.id}/run`,{}))}>{t('立即执行')}</button>{' '}
        <button onClick={()=>void perform(()=>api('POST',`task-jobs/${job.id}/stop`,{}))}>{t('停止')}</button>{' '}
        <button disabled={busy} onClick={()=>void perform(()=>api('GET',`task-jobs/${job.id}/runs`))}>{t('运行记录')}</button>
      </div>)}
      <output aria-live='polite'>{message}</output>
    </div>}
  </section>
}
