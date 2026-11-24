export type DesktopImport = {
  provider: 'chatglm'
  intent: string
  phase: 'awaiting_confirmation' | 'reading' | 'normalizing' | 'saving' | 'saved' | 'failed' | 'canceled' | 'expired'
  saved: boolean | null
  expiresAt: number
  remainingMs: number
  message: string
  account: { id: string; provider: 'chatglm' } | null
  package: { id: string; version: string; archiveDigest: string; moduleDigest: string; declarationDigest: string }
  scope: { platform: 'windows'; application: 'chatglm'; root: 'current_user_roaming'; access: 'read_only'
    files: string[]; cookieHost: '.chatglm.cn'; cookieNames: string[]; excludes: string[]; credentialsReturnedToUi: false }
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, limit = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)
const invalid = (): never => { throw new Error('invalid_desktop_import_receipt') }
const list = (value: unknown, expected: string[]) => Array.isArray(value) && value.length === expected.length && expected.every((item, i) => value[i] === item)

export function readDesktopImport(value: unknown, intent?: string): DesktopImport {
  if (!object(value) || value.provider !== 'chatglm' || typeof value.intent !== 'string' || !/^[a-f0-9]{48}$/.test(value.intent)
    || intent !== undefined && value.intent !== intent || !['awaiting_confirmation', 'reading', 'normalizing', 'saving', 'saved', 'failed', 'canceled', 'expired'].includes(String(value.phase))
    || value.saved !== null && typeof value.saved !== 'boolean' || value.saved === true && value.phase !== 'saved'
    || value.phase === 'saved' && value.saved !== true || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0
    || typeof value.remainingMs !== 'number' || !Number.isFinite(value.remainingMs) || value.remainingMs < 0 || value.remainingMs > 90000
    || typeof value.message !== 'string' || value.message.length > 8192) return invalid()
  const pack = value.package
  if (!object(pack) || !text(pack.id, 128) || !text(pack.version, 128)
    || ['archiveDigest', 'moduleDigest', 'declarationDigest'].some(key => typeof pack[key] !== 'string' || !/^[a-f0-9]{64}$/.test(pack[key]))) return invalid()
  const scope = value.scope
  if (!object(scope) || scope.platform !== 'windows' || scope.application !== 'chatglm' || scope.root !== 'current_user_roaming'
    || scope.access !== 'read_only' || scope.cookieHost !== '.chatglm.cn' || scope.credentialsReturnedToUi !== false
    || !list(scope.files, ['chatglm/Local State', 'chatglm/Network/Cookies'])
    || !list(scope.cookieNames, ['chatglm_token', 'chatglm_refresh_token'])
    || !list(scope.excludes, ['other_apps', 'browser_profiles', 'other_windows_users'])) return invalid()
  let account: DesktopImport['account'] = null
  if (value.phase === 'saved') {
    if (!object(value.account) || !text(value.account.id) || value.account.provider !== 'chatglm') return invalid()
    account = { id: value.account.id, provider: 'chatglm' }
  }
  return { provider: 'chatglm', intent: value.intent, phase: value.phase as DesktopImport['phase'], saved: value.saved,
    expiresAt: value.expiresAt, remainingMs: value.remainingMs, message: value.message, account,
    package: { id: pack.id, version: pack.version, archiveDigest: pack.archiveDigest as string, moduleDigest: pack.moduleDigest as string,
      declarationDigest: pack.declarationDigest as string },
    scope: { platform: 'windows', application: 'chatglm', root: 'current_user_roaming', access: 'read_only',
      files: [...scope.files as string[]], cookieHost: '.chatglm.cn', cookieNames: [...scope.cookieNames as string[]],
      excludes: [...scope.excludes as string[]], credentialsReturnedToUi: false } }
}
