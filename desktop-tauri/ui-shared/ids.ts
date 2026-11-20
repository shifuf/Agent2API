/** HTTP panels do not expose randomUUID; getRandomValues works in those contexts. */
export function newId(): string {
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(12))
  if (bytes) return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
