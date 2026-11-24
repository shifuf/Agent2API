export type ProxyService = 'update' | 'kernelDownload'

export type ProxyUsage = {
  usedBy?: Array<{ id?: string; name?: string; provider?: string; providerLabel?: string; enabled?: boolean }>
  usedByServices?: ProxyService[]
}

/** The same binding names are searchable in desktop and mobile exit lists. */
export function proxyBindingSearchText(item: ProxyUsage): string {
  return (item.usedBy || []).flatMap(account => [account.id, account.name, account.provider, account.providerLabel]).filter(Boolean).join(' ').toLowerCase()
}

export function hasProxyUsage(item: ProxyUsage): boolean {
  return Boolean(item.usedBy?.length || item.usedByServices?.length)
}

export function proxyServiceLabels(item: ProxyUsage, t: (key: string) => string): string[] {
  return [...new Set(item.usedByServices || [])].filter(service => service === 'update' || service === 'kernelDownload').map(service => {
    switch (service) {
      case 'update': return t('软件 / 插件更新')
      case 'kernelDownload': return t('代理内核下载')
    }
  })
}
