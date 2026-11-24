import type { GeetestConfig } from './plugin-captcha-frames'

export type PluginLoginForm = {
  id: string
  title: string
  message: string
  fields: Array<{
    key: string; label: string; type: 'text' | 'select'; secret: boolean; optional: boolean
    options: Array<{ value: string; label: string }>
  }>
  captcha: GeetestConfig | null
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !value.includes('\0')
const unsafe = new Set(['__proto__', 'constructor', 'prototype'])
const invalid = (): never => { throw new Error('invalid_plugin_login_form') }

/** Consume the host's public projection, bound to the original login task. */
export function readPluginLoginForm(raw: unknown, provider: string, flow: string): PluginLoginForm | null {
  if (!record(raw) || raw.provider !== provider || raw.state !== flow || raw.managedLogin === true) return invalid()
  const value = raw.interaction
  if (value === null) return null
  if (!record(value) || !text(value.id, 128) || !value.id || !text(value.title, 256)
    || value.message !== undefined && !text(value.message, 8192)
    || !Array.isArray(value.fields) || value.fields.length > 16) return invalid()
  const keys = new Set<string>()
  const fields: PluginLoginForm['fields'] = value.fields.map(item => {
    if (!record(item) || !text(item.key, 64) || !/^[A-Za-z0-9_-]+$/.test(item.key) || unsafe.has(item.key)
      || keys.has(item.key) || !text(item.label, 256) || !['text', 'select'].includes(String(item.type))
      || item.secret !== undefined && typeof item.secret !== 'boolean'
      || item.optional !== undefined && typeof item.optional !== 'boolean') return invalid()
    keys.add(item.key)
    const declared = item.options === undefined ? [] : item.options
    if (!Array.isArray(declared) || declared.length > 64 || item.type === 'select' && !declared.length) return invalid()
    const choices = new Set<string>()
    const options = declared.map(option => {
      if (!record(option) || !text(option.value, 1024) || !option.value || choices.has(option.value)
        || !text(option.label, 256)) return invalid()
      choices.add(option.value)
      return { value: option.value, label: option.label }
    })
    return { key: item.key, label: item.label, type: item.type as 'text' | 'select', secret: item.secret === true,
      optional: item.optional === true, options }
  })
  let captcha: GeetestConfig | null = null
  if (value.captcha !== undefined && value.captcha !== null) {
    const config = value.captcha
    if (!record(config) || !text(config.gt, 128) || !config.gt || !text(config.challenge, 256) || !config.challenge
      || typeof config.success !== 'boolean' || typeof config.new_captcha !== 'boolean' || keys.has('captcha')) return invalid()
    captcha = { gt: config.gt, challenge: config.challenge, success: config.success, new_captcha: config.new_captcha }
  }
  return { id: value.id, title: value.title, message: typeof value.message === 'string' ? value.message : '', fields, captcha }
}
