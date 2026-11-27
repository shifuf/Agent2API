import { useState } from 'react'

type PriceData = { currency: string; modelPrices: Record<string, unknown>; modelSameAs: Record<string, unknown>; providerPricing: Record<string, unknown>; fx: { rate: number; fallback: boolean } }
export type PricingApi = { load: () => Promise<PriceData>; save: (body: unknown) => Promise<PriceData>; refresh: () => Promise<PriceData['fx']>; reprice: (range: { fromMs: number; toMs: number }) => Promise<{ updated: number; skipped: number }> }

export function PricingPanel({ api, t }: { api: PricingApi; t: (key: string) => string }) {
  const [loaded, setLoaded] = useState<PriceData | null>(null)
  const [draft, setDraft] = useState('')
  const [currency, setCurrency] = useState('usd')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  function install(data: PriceData) {
    const { modelPrices, modelSameAs, providerPricing } = data
    setLoaded(data); setCurrency(data.currency); setDraft(JSON.stringify({ modelPrices, modelSameAs, providerPricing }, null, 2))
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setMessage('')
    try { await action() } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('操作失败')) }
    finally { setBusy(false) }
  }
  return <details data-pricing-panel onToggle={event => { if (event.currentTarget.open && !loaded && !busy) void perform(async () => install(await api.load())) }}>
    <summary>{t('模型计价')}</summary>
    {loaded && <div className='field-grid'>
      <label>{t('显示货币')} <select value={currency} onChange={event => setCurrency(event.target.value)}><option value='usd'>USD</option><option value='cny'>CNY</option></select></label>
      <span>1 USD = {loaded.fx.rate} CNY {loaded.fx.fallback && `(${t('离线参考值')})`}</span>
      <button disabled={busy} onClick={() => void perform(async () => { const fx = await api.refresh(); setLoaded({ ...loaded, fx }) })}>{t('刷新汇率')}</button>
      <label>{t('计价规则（每百万 Token）')}<textarea rows={9} value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} style={{ display: 'block', width: '100%' }} /></label>
      <code>{'"modelPrices": {"*/model-id": {"input": 1, "output": 2, "cacheRead": 0.1}}'}</code>
      <button data-pricing-save disabled={busy} onClick={() => void perform(async () => { const rules: unknown = JSON.parse(draft); if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error(t('计价规则必须为 JSON 对象')); install(await api.save({ ...rules, currency })); setMessage(t('已保存')) })}>{t('保存')}</button>
      <fieldset>
        <legend>{t('按已保存单价重算所选日期的估价')}</legend>
        <label>{t('开始日期')} <input data-reprice-from type='date' value={fromDate} max={toDate || undefined} onChange={event => setFromDate(event.target.value)} /></label>
        <label>{t('结束日期（含当天）')} <input data-reprice-to type='date' value={toDate} min={fromDate || undefined} onChange={event => setToDate(event.target.value)} /></label>
        <button data-pricing-reprice disabled={busy || !fromDate || !toDate || fromDate > toDate} onClick={() => void perform(async () => {
          const end = new Date(`${toDate}T00:00:00`); end.setDate(end.getDate() + 1)
          const result = await api.reprice({ fromMs: new Date(`${fromDate}T00:00:00`).getTime(), toMs: end.getTime() })
          setMessage(t('重算 {updated} 条，跳过 {skipped} 条').replace('{updated}', String(result.updated)).replace('{skipped}', String(result.skipped)))
        })}>{t('重算估价')}</button>
      </fieldset>
    </div>}
    <span role='status'>{message}</span>
  </details>
}
