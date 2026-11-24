import type { ProxyUsage } from './proxy-usage'
import type { ClashProxySnapshot } from './clash-proxy'

export type ProxyBindingAccount = {
  id: string
  name: string
  provider: string
  providerLabel: string
  enabled: boolean
  proxy: { source?: string; proxyId?: string; all?: boolean; proxyIds?: string[]; label?: string; error?: string | null; config?: { source?: string; proxyId?: string; all?: boolean; proxyIds?: string[] } } | null
}
export type BindingPoolItem = ProxyUsage & {
  id: string; name: string; source: string; enabled: boolean; providerId?: string; node?: string
  port?: number | null; orphan?: boolean; resolveError?: string | null; bindingError?: string | null
}
export type ProxyBindingPayload<Item extends BindingPoolItem = BindingPoolItem> = {
  accounts: ProxyBindingAccount[]; items: Item[]; kernelInstalled?: boolean; clash?: ClashProxySnapshot; changed?: number
}

export const MAX_BINDING_ACCOUNTS = 200
export const MAX_BINDING_PROXIES = 64

export function accountBindingIds(account: ProxyBindingAccount, items: BindingPoolItem[]): string[] {
  const config = account.proxy?.config || account.proxy
  if (config?.source === 'pool') return config.proxyId ? [config.proxyId] : []
  if (config?.source !== 'rotate') return []
  return config.all !== false ? items.filter(item => item.enabled).map(item => item.id) : [...new Set(config.proxyIds || [])]
}

export function bindingAccountGroups(accounts: ProxyBindingAccount[], query = ''): Array<{ provider: string; label: string; accounts: ProxyBindingAccount[] }> {
  const groups = new Map<string, { provider: string; label: string; accounts: ProxyBindingAccount[] }>()
  const search = query.trim().toLowerCase()
  for (const account of accounts) {
    if (search && ![account.name, account.id, account.provider, account.providerLabel].join(' ').toLowerCase().includes(search)) continue
    const group = groups.get(account.provider) || { provider: account.provider, label: account.providerLabel || account.provider, accounts: [] }
    group.accounts.push(account)
    groups.set(account.provider, group)
  }
  return [...groups.values()]
}

export function bindingTargetError(item: BindingPoolItem): string {
  if (item.bindingError) return item.bindingError
  if (!item.enabled) return '已禁用'
  if (item.orphan) return '所属订阅已删除'
  if (item.source === 'subscription' && item.port == null) return ''
  return item.resolveError || ''
}
