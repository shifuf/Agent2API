import type { PricingApi } from '../../../ui-shared/settings-pricing'

function bridge() {
  const api = (window as unknown as { workbuddyDesktop?: { getPricing: PricingApi['load']; savePricing: PricingApi['save']; refreshPricingFx: PricingApi['refresh']; repriceRequests: PricingApi['reprice'] } }).workbuddyDesktop
  if (!api) throw new Error('Gateway unavailable')
  return api
}

export const pricingApi: PricingApi = { load: () => bridge().getPricing(), save: body => bridge().savePricing(body), refresh: () => bridge().refreshPricingFx(), reprice: range => bridge().repriceRequests(range) }
