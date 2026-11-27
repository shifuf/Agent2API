import * as React from 'react'
import { Button, Dialog, DialogContent, DialogBody, DialogHeader, DialogTitle, DialogFooter, Input, Spinner, confirmDialog } from '@ui'
import { t } from '../i18n'

type Field = 'client' | 'model' | 'provider'
type Condition = { id: string; field: Field; op: string; values: string[] }
type Rule = { id: string; name: string; enabled: boolean; logic: 'all' | 'any'; conditions: Condition[]; mode: 'append' | 'custom' | 'passthrough'; text: string }
type Sample = Record<Field, string>
type View = { rules: Rule[]; revision: string; error?: string }
export type ConditionalApi = { getPromptRules(): Promise<View>; savePromptRules(body: { rules: Rule[]; revision: string }): Promise<View>;
  previewPromptRules(body: { rules: Rule[]; sample: Sample }): Promise<{ ruleId: string | null }> }

const id = () => `rule-${Array.from(crypto.getRandomValues(new Uint32Array(3)), word => word.toString(16)).join('-')}`
const condition = (): Condition => ({ id: id(), field: 'model', op: 'is', values: [] })
const fieldNames = () => ({ model: t('对外模型'), client: t('客户端'), provider: t('提供商') })
const operators = () => ({ is: t('是'), is_not: t('不是'), contains: t('包含'), not_contains: t('不包含'), glob: t('通配匹配'), regex: t('正则匹配') })

export function ConditionalPrompts({ api }: { api?: ConditionalApi }) {
  const [open, setOpen] = React.useState(false), [view, setView] = React.useState<View>(), [rules, setRules] = React.useState<Rule[]>([])
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [preview, setPreview] = React.useState<string>()
  const [sample, setSample] = React.useState<Sample>({ model: '', provider: '', client: '' })
  const dirty = !!view && JSON.stringify(view.rules) !== JSON.stringify(rules)
  const bridge = () => api || (window as unknown as { workbuddyDesktop: ConditionalApi }).workbuddyDesktop
  const perform = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) } }
  const adopt = (next: View) => { setView(next); setRules(next.rules); setError(next.error || ''); setPreview(undefined) }
  const load = () => perform(async () => { setOpen(true); adopt(await bridge().getPromptRules()) })
  const save = () => view && perform(async () => { adopt(await bridge().savePromptRules({ revision: view.revision, rules })); setOpen(false) })
  const discard = async () => !dirty || await confirmDialog(t('放弃未保存的修改？'))
  const close = async () => { if (!busy && await discard()) { setOpen(false); setView(undefined); setRules([]); setPreview(undefined) } }
  const update = (next: Rule[]) => { setRules(next); setPreview(undefined) }
  const patch = (index: number, next: Partial<Rule>) => update(rules.map((row, at) => at === index ? { ...row, ...next } : row))
  const move = (index: number, offset: number) => { const next = [...rules]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; update(next) }
  const fields = fieldNames(), ops = operators()
  return <><Button size='sm' variant='outline' onClick={() => void load()}>{t('条件提示词')}</Button><Dialog open={open} onOpenChange={next => { if (!next) void close() }}>
    <DialogContent className='w-[min(680px,calc(100vw-24px))]'><DialogHeader><DialogTitle>{t('条件提示词')}</DialogTitle></DialogHeader><DialogBody className='grid gap-3 overflow-y-auto'>
      {busy && !view ? <Spinner /> : null}{error ? <p role='alert' className='text-danger'>{error}</p> : null}
      {view ? <fieldset className='grid gap-3' disabled={busy}><p>{t('按顺序匹配规则；未命中时沿用原系统提示词。')}</p>
        {rules.map((rule, index) => {
          const change = (at: number, next: Partial<Condition>) => patch(index, { conditions: rule.conditions.map((item, row) => row === at ? { ...item, ...next } : item) })
          return <fieldset key={rule.id} className='grid gap-2 rounded-md border border-border p-3'><legend>{t('优先级 {index}', { index: index + 1 })}</legend>
            <label><input type='checkbox' checked={rule.enabled} onChange={event => patch(index, { enabled: event.target.checked })} /> {t('启用规则')}</label>
            <label>{t('规则名称')}<Input value={rule.name} maxLength={80} onChange={event => patch(index, { name: event.target.value })} /></label>
            <select aria-label={t('匹配条件')} value={rule.logic} onChange={event => patch(index, { logic: event.target.value as Rule['logic'] })}><option value='all'>{t('满足全部条件')}</option><option value='any'>{t('满足任一条件')}</option></select>
            {rule.conditions.map((item, at) => <div key={item.id} className='flex flex-wrap items-center gap-2'>
              <select aria-label={t('字段')} value={item.field} onChange={event => change(at, { field: event.target.value as Field, op: 'is', values: [] })}>{Object.entries(fields).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
              <select aria-label={t('匹配方式')} value={item.op} onChange={event => change(at, { op: event.target.value })}>{Object.entries(ops).filter(([key]) => item.field === 'model' || ['is', 'is_not'].includes(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
              <Input className='w-44 max-w-full' aria-label={t('条件值')} placeholder={item.field === 'client' ? 'codex, claude-code' : fields[item.field]} value={item.values.join(',')} onChange={event => change(at, { values: event.target.value ? item.field === 'model' ? [event.target.value] : event.target.value.split(',') : [] })} />
              <Button variant='ghost' size='sm' onClick={() => patch(index, { conditions: rule.conditions.filter((_, row) => row !== at) })}>{t('移除条件')}</Button>
            </div>)}
            <Button variant='outline' size='sm' disabled={rule.conditions.length >= 32} onClick={() => patch(index, { conditions: [...rule.conditions, condition()] })}>{t('添加条件')}</Button>
            <label>{t('模式')} <select value={rule.mode} onChange={event => patch(index, { mode: event.target.value as Rule['mode'] })}><option value='append'>{t('追加')}</option><option value='custom'>{t('替换')}</option><option value='passthrough'>{t('透传')}</option></select></label>
            {rule.mode !== 'passthrough' ? <label>{t('提示词正文')}<textarea className='w-full rounded-md border border-border p-2' rows={3} value={rule.text} onChange={event => patch(index, { text: event.target.value })} /></label> : null}
            <div className='flex gap-2'><Button size='sm' variant='outline' aria-label={t('提高优先级')} disabled={!index} onClick={() => move(index, -1)}>↑</Button>
              <Button size='sm' variant='outline' aria-label={t('降低优先级')} disabled={index === rules.length - 1} onClick={() => move(index, 1)}>↓</Button>
              <Button size='sm' variant='ghost' onClick={() => update(rules.filter((_, at) => at !== index))}>{t('移除规则')}</Button></div>
          </fieldset>})}
        <Button variant='outline' disabled={rules.length >= 200} onClick={() => update([...rules, { id: id(), name: '', enabled: true, conditions: [condition()], logic: 'all', mode: 'append', text: '' }])}>{t('添加规则')}</Button>
        <fieldset className='grid gap-2 rounded-md border border-border p-3'><legend>{t('命中测试')}</legend>
          {(['model', 'client', 'provider'] as const).map(field => <label key={field}>{fields[field]}<Input value={sample[field]} onChange={event => { setPreview(undefined); setSample({ ...sample, [field]: event.target.value }) }} /></label>)}
          <Button size='sm' variant='outline' onClick={() => void perform(async () => { const result = await bridge().previewPromptRules({ rules, sample }); setPreview(result.ruleId ? rules.find(rule => rule.id === result.ruleId)?.name || result.ruleId : t('未命中')) })}>{t('预览')}</Button>
          {preview !== undefined ? <output>{preview}</output> : null}
        </fieldset>
      </fieldset> : null}
    </DialogBody><DialogFooter><Button variant='outline' disabled={busy} onClick={() => void close()}>{t('取消')}</Button>
      {error ? <Button variant='outline' disabled={busy} onClick={async () => { if (await discard()) void load() }}>{t('重新读取')}</Button> : null}
      <Button disabled={busy || !dirty} onClick={() => void save()}>{t('保存')}</Button></DialogFooter></DialogContent>
  </Dialog></>
}
