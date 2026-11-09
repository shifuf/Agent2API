/** Provider multipliers are manifest credits such as "x0.11 credits".
 * Missing data and unrelated prices are not free. Keep reported precision. */
export function modelRate(credits: unknown): { label: string; free: boolean } | null {
  if (typeof credits !== 'string') return null
  const match = /^\s*[x×]\s*(\d+(?:\.\d+)?|\.\d+)(?=\s|$)/i.exec(credits)
  if (!match || !Number.isFinite(Number(match[1]))) return null
  const [whole, fraction = ''] = match[1].split('.')
  return { label: `${whole.replace(/^0+(?=\d)/, '') || '0'}.${fraction.padEnd(2, '0')}x`, free: Number(match[1]) === 0 }
}
