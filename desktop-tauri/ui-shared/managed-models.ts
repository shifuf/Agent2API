import type { ModelCandidate } from './public-model-catalog'

export type ModelBinding = { provider: string; model: string }
export type ModelType = 'chat' | 'embedding' | 'rerank' | 'image_generation' | 'video_generation'
export type ModelStatus = 'enabled' | 'disabled' | 'archived'
export type ModelCard = {
  reasoning?: { supported?: boolean; default?: boolean }; reasoningEfforts?: string[]
  toolCall?: boolean; temperature?: boolean; vision?: boolean
  modalities?: { input?: string[]; output?: string[] }
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  limit?: { context?: number; output?: number }
  knowledge?: string; releaseDate?: string; lastUpdated?: string
}
export type ManagedModel = {
  id: string; name: string; enabled: boolean; bindings: ModelBinding[]
  developer?: string; type?: ModelType; icon?: string; group?: string; remark?: string
  modelCard?: ModelCard; archived?: boolean; createdAt?: string; updatedAt?: string
}

export const blankManagedModel = (): ManagedModel => ({ id: '', name: '', enabled: false, bindings: [],
  developer: 'custom', type: 'chat', icon: '', group: '', remark: '', modelCard: {}, archived: false })

export function managedModelStatus(model: ManagedModel): ModelStatus {
  return model.archived ? 'archived' : model.enabled ? 'enabled' : 'disabled'
}

export function withModelStatus(model: ManagedModel, status: ModelStatus): ManagedModel {
  return { ...model, enabled: status === 'enabled', archived: status === 'archived' }
}

export function modelFromCandidate(draft: ManagedModel, candidate: ModelCandidate): ManagedModel {
  const { model, provider, origins } = candidate
  const developer = origins.includes('directory') ? provider.id : draft.developer || 'custom'
  return { ...draft, id: model.id, name: model.name || model.id, developer,
    type: model.type || (model.kind === 'image' ? 'image_generation' : 'chat'),
    icon: model.icon || developer, group: model.family || developer,
    modelCard: model.modelCard ? structuredClone(model.modelCard) : {} }
}

export function filterManagedModels(models: ManagedModel[], filter: { query: string; developer: string; status: ModelStatus | '' }): ManagedModel[] {
  const query = filter.query.trim().toLowerCase()
  return models.filter(model => (!filter.developer || (model.developer || 'custom') === filter.developer)
    && (!filter.status || managedModelStatus(model) === filter.status)
    && (!query || [model.id, model.name, model.developer, model.group, model.remark,
      ...model.bindings.flatMap(binding => [binding.provider, binding.model])].join(' ').toLowerCase().includes(query)))
}

export function validateManagedModel(model: ManagedModel): '' | 'id' | 'bindings' {
  if (!model.id.trim() || model.id.length > 128 || /[\s\u0000-\u001f\u007f]/.test(model.id)) return 'id'
  if (model.bindings.length > 256 || model.bindings.some(binding => !binding.provider || !binding.model.trim())
    || new Set(model.bindings.map(binding => binding.provider.toLowerCase())).size !== model.bindings.length) return 'bindings'
  return ''
}

export function upsertBinding(bindings: ModelBinding[], provider: string, model: string): ModelBinding[] {
  if (!model) return bindings.filter(binding => binding.provider !== provider)
  return bindings.some(binding => binding.provider === provider)
    ? bindings.map(binding => binding.provider === provider ? { provider, model } : binding)
    : [...bindings, { provider, model }]
}
