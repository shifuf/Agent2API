import type { PricingApi } from '../../../ui-shared/settings-pricing'
import { apiCall } from './client'

export const pricingApi: PricingApi = { load: () => apiCall('/api/model-pricing'), save: body => apiCall('/api/model-pricing', { method: 'PUT', body }), refresh: () => apiCall('/api/model-pricing/fx', { method: 'POST' }), reprice: body => apiCall('/api/model-pricing/reprice', { method: 'POST', body }) }
