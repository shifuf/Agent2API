export type ModelBinding = { provider: string; model: string }
export type ManagedModel = { id: string; name: string; enabled: boolean; bindings: ModelBinding[] }

export function validateManagedModel(model: ManagedModel): '' | 'id' | 'bindings' {
  if (!model.id.trim() || model.id.length > 128 || /[\s\u0000-\u001f\u007f]/.test(model.id)) return 'id'
  if (!model.bindings.length || model.bindings.some(binding => !binding.provider || !binding.model.trim())
    || new Set(model.bindings.map(binding => binding.provider)).size !== model.bindings.length) return 'bindings'
  return ''
}

export function upsertBinding(bindings: ModelBinding[], provider: string, model: string): ModelBinding[] {
  if (!model) return bindings.filter(binding => binding.provider !== provider)
  return bindings.some(binding => binding.provider === provider)
    ? bindings.map(binding => binding.provider === provider ? { provider, model } : binding)
    : [...bindings, { provider, model }]
}
