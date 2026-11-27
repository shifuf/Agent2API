import { apiCall } from './client'
import { serverIdentity } from './servers'
import type { MaintenanceApi } from '../../../ui-shared/maintenance-types'

export function maintenanceApi(identity = serverIdentity()): MaintenanceApi {
  const request = <Result,>(path: string, init?: Parameters<typeof apiCall>[1]) => {
    if (serverIdentity() !== identity) return Promise.reject(new DOMException('服务器已切换', 'AbortError'))
    return apiCall<Result>(path, init)
  }
  return {
    overview: query => {
      const params = new URLSearchParams(Object.entries(query).map(([name, value]) => [name, String(value)]))
      return request(`/api/maintenance?${params}`)
    },
    detail: id => request(`/api/maintenance/records/${encodeURIComponent(id)}`),
    run: id => request(`/api/maintenance/run/${encodeURIComponent(id)}`, { method: 'POST', body: {}, noAuthReplay: true }),
    retry: (id, itemId) => request(`/api/maintenance/records/${encodeURIComponent(id)}/retry`, { method: 'POST', body: itemId ? { itemId } : {}, noAuthReplay: true }),
    save: (id, patch) => request(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { method: 'POST', body: patch, noAuthReplay: true }),
  }
}
