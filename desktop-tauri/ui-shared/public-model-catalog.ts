import type { ManagedModel, ModelCard, ModelType } from './managed-models'

export type PublicModel = { id: string; name: string; kind: string; family?: string; type?: ModelType; icon?: string; modelCard?: ModelCard }
export type PublicProvider = { id: string; name: string; models: PublicModel[] }
export type PublicModelCatalog = {
  providers: PublicProvider[]; sourceUrl: string; fetchedAt: string; updatedAt: string; stale: boolean; error?: string
}
export type ModelSource = { id: string; name: string; accountCount: number; models: Array<{ id: string; name?: string; kind?: string }> }
export type CandidateOrigin = 'directory' | 'upstream' | 'custom'
export type ModelCandidate = { provider: { id: string; name: string }; model: PublicModel; origins: CandidateOrigin[]; labels: string[]; existing?: ManagedModel }

export function filterPublicModels(providers: PublicProvider[], providerId: string, search: string): Array<{ provider: PublicProvider; model: PublicModel }> {
  const query = search.trim().toLowerCase()
  const seen = new Set<string>()
  return providers.filter(provider => !providerId || provider.id === providerId)
    .flatMap(provider => provider.models.map(model => ({ provider, model })))
    .filter(({ provider, model }) => !query || `${provider.id} ${provider.name} ${model.id} ${model.name}`.toLowerCase().includes(query))
    .filter(({ model }) => { if (seen.has(model.id)) return false; seen.add(model.id); return true })
}

/** Candidate IDs remain exact; the same model appearing in multiple sources occupies one row. */
export function modelCandidates(providers: PublicProvider[], sources: ModelSource[], saved: ManagedModel[],
  filter: { origin: CandidateOrigin | ''; manufacturer: string; search: string }): ModelCandidate[] {
  const rows = new Map<string, ModelCandidate>()
  const searchTerms = new Map<string, Set<string>>()
  const savedById = new Map(saved.map(model => [model.id, model]))
  const put = (provider: { id: string; name: string }, model: PublicModel, origin: CandidateOrigin) => {
    const existing = savedById.get(model.id)
    const terms = searchTerms.get(model.id) || new Set<string>()
    for (const term of [provider.id, provider.name, model.id, model.name, existing?.name || '']) terms.add(term)
    searchTerms.set(model.id, terms)
    const current = rows.get(model.id)
    if (current) {
      if (!current.origins.includes(origin)) current.origins.push(origin)
      if (provider.name && !current.labels.includes(provider.name)) current.labels.push(provider.name)
      if (existing) current.existing = existing
    } else rows.set(model.id, { provider, model, origins: [origin], labels: provider.name ? [provider.name] : [], existing })
  }
  if (!filter.origin || filter.origin === 'directory') {
    for (const provider of providers.filter(item => !filter.manufacturer || item.id === filter.manufacturer)) {
      for (const model of provider.models) put(provider, model, 'directory')
    }
  }
  if (!filter.manufacturer && (!filter.origin || filter.origin === 'upstream')) {
    for (const source of sources.filter(item => item.accountCount > 0)) {
      for (const model of source.models) put(source, { id: model.id, name: model.name || model.id, kind: model.kind || 'chat' }, 'upstream')
    }
  }
  if (!filter.manufacturer && (!filter.origin || filter.origin === 'custom')) {
    for (const model of saved) put({ id: 'custom', name: '' }, { id: model.id, name: model.name || model.id, kind: '' }, 'custom')
  }
  const query = filter.search.trim().toLowerCase()
  return [...rows.values()].filter(row => !query || [...searchTerms.get(row.model.id) || []].join(' ').toLowerCase().includes(query))
}

export function selectPublicModel(draft: ManagedModel, model: PublicModel): ManagedModel {
  return { ...draft, id: model.id, name: model.name || model.id }
}
