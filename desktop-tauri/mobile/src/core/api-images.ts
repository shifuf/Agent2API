import { apiCall, authHeaders, refreshPanelAuthIfExpiring, resolveUrl } from './client'
import { serverIdentity } from './servers'
import { downloadToolImageBlob } from '../../../ui-shared/tools-image-history'
import type { ImageToolApi } from '../../../ui-shared/tools-image-types'

const BASE = '/api/tools/image-generation'

export function imageToolApi(identity = serverIdentity()): ImageToolApi {
  const requireCurrent = () => {
    if (serverIdentity() !== identity) throw new DOMException('服务器已切换', 'AbortError')
  }
  const request = <Result,>(path: string, init?: Parameters<typeof apiCall>[1]) => {
    requireCurrent()
    return apiCall<Result>(path, init)
  }
  return {
    load: () => request(`${BASE}/config`),
    save: config => request(`${BASE}/config`, { method: 'PUT', body: config, noAuthReplay: true }),
    jobs: () => request(`${BASE}/jobs`),
    remove: id => request(`${BASE}/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', noAuthReplay: true }),
    download: async file => {
      requireCurrent()
      await refreshPanelAuthIfExpiring()
      requireCurrent()
      const response = await fetch(resolveUrl(`${BASE}/files/${encodeURIComponent(file.id)}`), { headers: authHeaders() })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      requireCurrent()
      downloadToolImageBlob(file, blob)
    },
  }
}
