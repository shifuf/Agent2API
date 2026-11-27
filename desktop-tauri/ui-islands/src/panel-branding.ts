import { brandingStore, parseBranding, readBranding, type BrandingPatch } from '../../ui-shared/panel-branding-state'

type Bridge = { platform?: string; waitForBackend?: () => Promise<{ port?: number }>; saveBranding?: (patch: BrandingPatch) => Promise<unknown> }
const bridge = () => (window as unknown as { workbuddyDesktop?: Bridge }).workbuddyDesktop
async function base() {
  const api = bridge()
  if (!api?.platform || api.platform === 'web') return location.origin
  const port = (await api.waitForBackend?.())?.port
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Gateway unavailable')
  return `http://127.0.0.1:${port}`
}
export const desktopBrand = brandingStore(() => location.origin, async () => readBranding(await base()))
export async function saveDesktopBrand(scope: string, patch: BrandingPatch) {
  const api = bridge()
  if (!api?.saveBranding) throw new Error('Gateway unavailable')
  const origin = await base()
  desktopBrand.accept(scope, parseBranding(await api.saveBranding(patch), origin))
}
