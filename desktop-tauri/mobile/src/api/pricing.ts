import type { PricingApi } from '../../../ui-shared/settings-pricing'
import { apiCall } from './client'
import { serverIdentity } from '../core/servers'

export function createPricingApi(identity = serverIdentity()): PricingApi {
  const request = <Result,>(path: string, init?: Parameters<typeof apiCall>[1]) => {
    if (serverIdentity() !== identity) return Promise.reject(new DOMException('服务器已切换', 'AbortError'))
    return apiCall<Result>(path, { ...init, noAuthReplay: Boolean(init?.method && init.method !== 'GET') || init?.noAuthReplay })
  }
  return { load: () => request('/api/model-pricing'), save: body => request('/api/model-pricing', { method: 'PUT', body }),
    refresh: async () => (await request<{ fx: Awaited<ReturnType<PricingApi['refresh']>> }>('/api/model-pricing/fx/refresh', { method: 'POST', body: {} })).fx,
    reprice: body => request('/api/model-pricing/reprice', { method: 'POST', body }) }
}

export const pricingApi: PricingApi = { load: () => createPricingApi().load(), save: body => createPricingApi().save(body),
  refresh: () => createPricingApi().refresh(), reprice: body => createPricingApi().reprice(body) }
