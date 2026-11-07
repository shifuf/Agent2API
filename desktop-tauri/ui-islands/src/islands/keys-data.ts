import type { MultiSelectOption } from '@ui'
import { t } from '../i18n'

export type KeyEntry = {
  id: string
  name?: string
  key?: string
  masked?: string
  enabled?: boolean
  createdAt?: number
  allowedProviders?: string[]
  allowedModels?: string[]
}

export type ProviderOption = { id: string; label?: string; removed?: boolean; unavailable?: boolean; enabled?: boolean; count?: number }
export type KeysPayload = {
  keys?: KeyEntry[]
  authRequired?: boolean
  usableKeyCount?: number
  providers?: ProviderOption[]
  modelsByProvider?: Record<string, string[]>
  created?: KeyEntry
}
export type KeyRestrictions = { allowedProviders: string[]; allowedModels: string[] }
export type KeysBridge = {
  getKeys(): Promise<KeysPayload | null | undefined>
  createKey(payload: KeyRestrictions & { name: string; key?: string }): Promise<KeysPayload | null | undefined>
  updateKey(id: string, patch: Partial<KeyRestrictions> & { name?: string; enabled?: boolean }): Promise<KeysPayload | null | undefined>
  deleteKey(id: string): Promise<KeysPayload | null | undefined>
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function filterKeys(keys: KeyEntry[], query: string, status: string): KeyEntry[] {
  const search = query.trim().toLowerCase()
  return keys.filter(key => (!search || (key.name || '').toLowerCase().includes(search))
    && (status === 'all' || (key.enabled !== false) === (status === 'enabled')))
}

/** The server catalog is the sole source of selectable models. */
export function modelOptions(table: Record<string, string[]>, providers: readonly string[], _selected: readonly string[] = []): MultiSelectOption[] {
  const names = new Map<string, string>()
  const entries = new Map(Object.entries(table).map(([id, models]) => [id.toLowerCase(), models]))
  for (const id of providers.length ? providers : Object.keys(table)) {
    for (const value of entries.get(id.toLowerCase()) || []) {
      const name = value.trim()
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
    }
  }
  return [...names.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(value => ({ value, label: value }))
}

export function channelOptions(providers: ProviderOption[], _retained: readonly string[] = []): MultiSelectOption[] {
  return providers.filter(item => !item.removed && !item.unavailable && item.enabled !== false && item.count !== 0)
    .map(item => ({ value: item.id, label: t(item.label || item.id) }))
}

/** Canonicalize available values, retaining restrictions absent from the catalog. */
export function pickedFromOptions(values: readonly string[], options: readonly MultiSelectOption[]): string[] {
  const canonical = new Map(options.map(option => [option.value.toLowerCase(), option.value]))
  const chosen = new Map<string, string>()
  for (const value of values) {
    const text = value.trim()
    if (text && !chosen.has(text.toLowerCase())) chosen.set(text.toLowerCase(), canonical.get(text.toLowerCase()) || text)
  }
  return [...options.filter(option => chosen.has(option.value.toLowerCase())).map(option => option.value),
    ...[...chosen].filter(([key]) => !canonical.has(key)).map(([, value]) => value)]
}

export function hiddenSelections(values: readonly string[], options: readonly MultiSelectOption[]): string[] {
  const available = new Set(options.map(option => option.value.toLowerCase()))
  return values.filter(value => !available.has(value.toLowerCase()))
}

export function retainHiddenSelections(current: readonly string[], next: string[], options: readonly MultiSelectOption[]): string[] {
  return pickedFromOptions([...next, ...hiddenSelections(current, options)], options)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
