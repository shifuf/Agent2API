import type { PrivacyApi, PrivacyPatch, PrivacySettings } from '../../../ui-shared/privacy-settings'
import type { TurnstileApi, TurnstilePatch, TurnstileSettings } from '../../../ui-shared/turnstile-settings'
import type { OAuthApi, OAuthPatch, OAuthSettings } from '../../../ui-shared/panel-oauth'

function bridge() {
  const desktop = (window as unknown as { workbuddyDesktop?: {
    getTurnstile(): Promise<TurnstileSettings>
    getPanelOauth(): Promise<OAuthSettings>
    savePanelOauth(patch: OAuthPatch): Promise<OAuthSettings>
    saveTurnstile(value: TurnstilePatch): Promise<TurnstileSettings>
    getPrivacy(): Promise<PrivacySettings>
    savePrivacy(patch: PrivacyPatch): Promise<PrivacySettings>
    previewPrivacy(payload: { text: string }): Promise<{ text: string }>
  } }).workbuddyDesktop
  if (!desktop) throw new Error('Gateway unavailable')
  return desktop
}

export const desktopPrivacy: PrivacyApi = { load: () => bridge().getPrivacy(), save: patch => bridge().savePrivacy(patch), preview: text => bridge().previewPrivacy({ text }) }
export const desktopTurnstile: TurnstileApi = { load: () => bridge().getTurnstile(), save: value => bridge().saveTurnstile(value) }
export const desktopOauth: OAuthApi = {load:()=>bridge().getPanelOauth(), save:value=>bridge().savePanelOauth(value)}
