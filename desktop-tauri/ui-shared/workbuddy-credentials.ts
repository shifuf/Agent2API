/** Infer a WorkBuddy credential's region; explicit exported provider is handled by the caller. */
export function workbuddyCredentialEdition(record: Record<string, unknown>): 'cn' | 'intl' | null {
  const auth = record.auth
  const nested = auth && typeof auth === 'object' && !Array.isArray(auth)
    ? auth as Record<string, unknown> : null
  const domain = (typeof nested?.domain === 'string' ? nested.domain.trim() : '')
    || (typeof record.domain === 'string' ? record.domain.trim() : '')
  if (/workbuddy\.ai|codebuddy\.ai/i.test(domain)) return 'intl'
  if (/workbuddy\.cn|codebuddy\.cn|copilot\.tencent\.com/i.test(domain)) return 'cn'
  const realm = [record.realm, record.region, record.edition]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    ?.trim().toLowerCase()
  if (realm && ['intl', 'international', 'global', 'ai', 'workbuddy-ai', 'workbuddyai', 'en'].includes(realm)) return 'intl'
  if (realm && ['cn', 'china', 'mainland', 'workbuddy', 'zh', 'cn-intl'].includes(realm)) return 'cn'
  return null
}
