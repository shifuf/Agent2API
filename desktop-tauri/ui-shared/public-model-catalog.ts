import type { ManagedModel } from './managed-models'

export type PublicModel = { id: string; name: string; kind: string }
export type PublicProvider = { id: string; name: string; models: PublicModel[] }
export type PublicModelCatalog = {
  providers: PublicProvider[]; sourceUrl: string; fetchedAt: string; updatedAt: string; stale: boolean; error?: string
}

export function filterPublicModels(providers: PublicProvider[], providerId: string, search: string): Array<{ provider: PublicProvider; model: PublicModel }> {
  const query = search.trim().toLowerCase()
  return providers.filter(provider => !providerId || provider.id === providerId)
    .flatMap(provider => provider.models.map(model => ({ provider, model })))
    .filter(({ provider, model }) => !query || `${provider.id} ${provider.name} ${model.id} ${model.name}`.toLowerCase().includes(query))
}

export function selectPublicModel(draft: ManagedModel, model: PublicModel): ManagedModel {
  return { ...draft, id: model.id, name: model.name || model.id }
}
