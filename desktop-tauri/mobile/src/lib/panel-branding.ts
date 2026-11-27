import { brandingStore, parseBranding, readBranding, type BrandingPatch } from '../../../ui-shared/panel-branding-state'
import { apiCall } from '../api/client'
import { apiBase, isPackaged, serverIdentity } from './servers'

const base = () => isPackaged() ? apiBase() : location.origin
const scope = () => isPackaged() ? serverIdentity() : location.origin
export const mobileBrand = brandingStore(scope, () => readBranding(base()))
export async function saveMobileBrand(identity: string, patch: BrandingPatch) {
  if (scope() !== identity) return
  const origin = base()
  const value = await apiCall('/api/branding', { method: 'PUT', body: patch })
  mobileBrand.accept(identity, parseBranding(value, origin))
}
