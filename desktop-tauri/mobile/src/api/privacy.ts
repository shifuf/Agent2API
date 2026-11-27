import type { PrivacyApi } from '../../../ui-shared/privacy-settings'
import type { TurnstileApi } from '../../../ui-shared/turnstile-settings'
import type { OAuthApi } from '../../../ui-shared/panel-oauth'
import { apiCall } from './client'

export const mobilePrivacy: PrivacyApi = { load: () => apiCall('/api/privacy'), save: body => apiCall('/api/privacy', { method: 'PUT', body }), preview: text => apiCall('/api/privacy/test', { method: 'POST', body: { text } }) }
export const mobileTurnstile: TurnstileApi = { load: () => apiCall('/api/captcha/turnstile'), save: body => apiCall('/api/captcha/turnstile', {method:'PUT',body}) }
export const mobileOauth: OAuthApi = {load:()=>apiCall('/api/panel-oauth'),save:body=>apiCall('/api/panel-oauth',{method:'PUT',body})}
