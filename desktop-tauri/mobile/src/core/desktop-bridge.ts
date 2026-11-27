import { apiCall, authHeaders, refreshPanelAuth, refreshPanelAuthIfExpiring, type RequestInitLite } from './client'
import { apiBase, serverIdentity } from './servers'
import { store } from './store'

export function installDesktopBridge() {
  const request = (method: RequestInitLite['method'], path: string, body?: unknown) => apiCall(path, { method, body })
  const current = window as unknown as Record<string, unknown>
  current.wbMobileRequest = (method: RequestInitLite['method'], path: string, body?: unknown, options?: { retry?: string }) =>
    apiCall(path, { method, body, noAuthReplay: options?.retry === 'never' })
  current.wbMobileBase = apiBase
  current.wbProviders = {
    customRequest: request,
    all: () => store.getState().session?.accounts?.providers || [],
    labelOf: (id: string) => store.getState().session?.accounts?.providers?.find(provider => provider.id === id)?.label || id,
  }
  current.wbApp = {
    get currentPage() { return store.getState().tab },
    getState: () => store.getState().session,
    refresh: async () => { await store.refresh(true); return true },
    refreshPluginPages: async () => { await store.refresh(true) },
    toast: (message: string, kind?: string) => store.toast(message, kind === 'err' ? 'danger' : kind === 'ok' ? 'success' : 'info'),
    showPage: (page: string) => store.setTab(page === 'scheduled' ? 'scheduled' : 'plugins'),
  }
  current.workbuddyDesktop = {
    ...(current.workbuddyDesktop as object || {}),
    platform: 'mobile',
    serverIdentity,
    directCredentials: async (refresh = false) => {
      const identity = serverIdentity()
      if (refresh) await refreshPanelAuth()
      else await refreshPanelAuthIfExpiring()
      if (serverIdentity() !== identity) throw new DOMException('服务器已切换', 'AbortError')
      return authHeaders()
    },
    getModelApiKeys: () => request('GET', '/api/model-access/keys'),
    getLocalDirectStatus: () => request('GET', '/api/agents/local-direct'),
    saveLocalDirectSettings: (body: unknown) => request('PUT', '/api/agents/local-direct', body),
    syncLocalDirect: (body?: unknown) => apiCall('/api/agents/local-direct/sync', { method: 'POST', body: body ?? {}, noAuthReplay: true }),
    getCaptchaSetting: () => request('GET', '/api/captcha'),
    saveCaptchaSetting: (body: unknown) => request('PUT', '/api/captcha', body),
    getPrivacy: () => request('GET', '/api/privacy'),
    savePrivacy: (body: unknown) => request('PUT', '/api/privacy', body),
    testPrivacy: (body: unknown) => request('POST', '/api/privacy/test', body),
    getSanitize: () => request('GET', '/api/sanitize'),
    saveSanitize: (body: unknown) => request('PUT', '/api/sanitize', body),
    getCloudSync: () => request('GET', '/api/cloud-sync'),
    saveCloudSync: (body: unknown) => request('PUT', '/api/cloud-sync', body),
    testCloudSync: (body: unknown) => request('POST', '/api/cloud-sync/test', body),
    getCloudSyncRemote: () => request('GET', '/api/cloud-sync/remote'),
    cloudSyncUpload: () => request('POST', '/api/cloud-sync/upload', {}),
    cloudSyncDownload: () => request('POST', '/api/cloud-sync/download', {}),
    importCloudSyncKey: (password: string) => request('POST', '/api/cloud-sync/import-key', { password }),
  }
}
