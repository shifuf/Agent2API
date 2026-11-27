export type Branding = { displayName: string; logoUrl: string | null }
export type BrandingPatch = { displayName?: string | null; logo?: string | null }
export const DEFAULT_BRANDING: Branding = Object.freeze({ displayName: 'Agent2API', logoUrl: null })

export function parseBranding(value: unknown, base: string): Branding {
  const brand = value as Partial<Branding> | null
  if (typeof brand?.displayName !== 'string' || !brand.displayName.trim() || [...brand.displayName].length > 64 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(brand.displayName)) throw new Error('Invalid branding name')
  const path = brand.logoUrl
  if (path !== null && (typeof path !== 'string' || !/^\/api\/panel\/branding\/logo\?v=[a-f0-9]{64}$/.test(path))) throw new Error('Invalid branding logo')
  return { displayName: brand.displayName, logoUrl: path ? new URL(path, base).href : null }
}

export async function readBranding(base: string) {
  const response = await fetch(new URL('/api/panel/branding', base), { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000) })
  if (response.status === 404) return DEFAULT_BRANDING
  if (!response.ok) throw new Error('Branding unavailable')
  return parseBranding((await response.json()).data, base)
}

export function brandingStore(identity: () => string, read: () => Promise<Branding>) {
  let owner = '', generation = 0
  let value = DEFAULT_BRANDING
  let pending: { scope: string; request: Promise<void> } | null = null
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  const accept = (scope: string, next: Branding) => {
    if (identity() !== scope) return false
    owner = scope; generation++
    if ((value === DEFAULT_BRANDING) !== (next === DEFAULT_BRANDING) || value.displayName !== next.displayName || value.logoUrl !== next.logoUrl) { value = next; publish() }
    return true
  }
  function refresh() {
    const scope = identity()
    if (!scope) return Promise.resolve()
    if (pending?.scope === scope) return pending.request
    if (owner !== scope) { owner = scope; value = DEFAULT_BRANDING; publish() }
    const epoch = ++generation
    const request = read().then(next => { if (generation === epoch) accept(scope, next) }).catch(() => {}).finally(() => { if (pending?.request === request) pending = null })
    pending = { scope, request }; return request
  }
  return { identity, refresh, accept, snapshot: () => identity() === owner ? value : DEFAULT_BRANDING,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
}
