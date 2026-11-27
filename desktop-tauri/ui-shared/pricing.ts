export type PricingAmount = { costUsd?: number | null; costCny?: number | null; pricingCurrency?: string }

export function formatEstimate(data: PricingAmount | undefined): string {
  const cny = data?.pricingCurrency === 'cny'
  const unit = cny ? 'CN¥' : 'US$'
  const value = cny ? data?.costCny : data?.costUsd
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value > 0 && value < 0.000001) return '< ' + unit + '0.000001'
  return unit + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}
