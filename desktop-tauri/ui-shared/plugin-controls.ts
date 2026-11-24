import type { PluginDocumentText } from './provider-docs'

export type PluginTranslate = (key: string, params?: Record<string, string | number>) => string
export type PluginRequest = <T>(method: 'GET' | 'PATCH' | 'POST', path: string, body?: unknown) => Promise<T>
export type PluginSettingValue = string | number | boolean | null
export type PluginSettingField = {
  key: string
  label: PluginDocumentText
  description?: PluginDocumentText | null
  type: 'string' | 'number' | 'boolean' | 'select'
  default: PluginSettingValue
  minimum?: number | null
  maximum?: number | null
  max_length?: number | null
  options: Array<{ value: string; label: PluginDocumentText }>
}
export type PluginSettingsRow = {
  provider: string
  label: string
  group?: { id: string; label?: PluginDocumentText | null; providers: Array<{ id: string; label: string; enabled?: boolean }> }
  error?: string
  schema?: { title: PluginDocumentText; description?: PluginDocumentText | null; storage_provider?: string | null; fields: PluginSettingField[] }
  values?: Record<string, PluginSettingValue>
  effective?: Record<string, PluginSettingValue>
  invalid?: Record<string, boolean>
  overrides?: Record<string, { source: string; value: PluginSettingValue }>
  revision?: string
  saved?: boolean
}

export const pluginSettingsKey = (row: PluginSettingsRow): string => row.group?.id || row.schema?.storage_provider || row.provider
export const pluginSettingsMembers = (row: PluginSettingsRow): Array<{ id: string; label: string }> =>
  row.group?.providers?.length ? row.group.providers : [{ id: row.provider, label: row.label }]
