import { useEffect } from 'react'
import { apiCall } from '../core/client'
import { serverIdentity } from '../core/servers'
import { PrivacyPanel } from '../../../ui-islands/src/islands/settings-privacy'
import { SanitizePanel } from '../../../ui-islands/src/islands/settings-sanitize'
import { renderPrivacy, renderSanitize, useSettings } from '../../../ui-islands/src/islands/settings-state'

export function PrivacySettings() {
  const snap = useSettings()
  const identity = serverIdentity()
  useEffect(() => {
    let active = true
    renderPrivacy(null)
    renderSanitize(null)
    const accept = (apply: (data: unknown) => void) => (data: unknown) => {
      if (active && serverIdentity() === identity) apply(data)
    }
    void apiCall('/api/privacy').then(accept(renderPrivacy)).catch(accept(renderPrivacy))
    void apiCall('/api/sanitize').then(accept(renderSanitize)).catch(accept(renderSanitize))
    return () => { active = false }
  }, [identity])
  return <><PrivacyPanel snap={snap} /><SanitizePanel snap={snap} /></>
}
