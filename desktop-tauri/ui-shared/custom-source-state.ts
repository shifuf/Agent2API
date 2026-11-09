type Request = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>
type Source = { id: string; models: Array<{ id: string; enabled?: boolean; [key: string]: unknown }>; mappings?: Array<{ alias?: string; [key: string]: unknown }> }

/** Change source availability without changing the accounts or models allowed by each Key group. */
export async function setCustomSourceEnabled(request: Request, providerId: string, modelId: string, enabled: boolean): Promise<void> {
  const response = await request('GET', '/api/custom-providers') as { providers?: Source[] }
  const provider = response.providers?.find(item => item.id === providerId)
  if (!provider || !Array.isArray(provider.models) || !provider.models.some(model => model.id === modelId)) {
    throw new Error('上游模型不存在')
  }
  const saved = await request('POST', '/api/custom-providers/models', {
    providerId,
    models: provider.models.map(model => model.id === modelId ? { ...model, enabled } : model),
    // Explicitly enabling the physical source replaces its retired same-ID alias,
    // matching the old source switch. Preserve every other mapping and Key scope.
    mappings: (provider.mappings || []).map(mapping => enabled && mapping.alias?.trim().toLowerCase() === modelId.trim().toLowerCase()
      ? { ...mapping, enabled: false } : mapping),
  }) as { provider?: Source }
  if (saved.provider?.id !== providerId || saved.provider.models?.find(model => model.id === modelId)?.enabled !== enabled) {
    throw new Error('上游模型状态保存失败')
  }
}
