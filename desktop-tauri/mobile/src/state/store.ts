import { store as core, useStore as useCoreStore, type TabId } from '../core/store'
import type { SessionPayload } from '../api/gateway'
export type { ThemeMode } from '../core/store'
export type { Route } from '../lib/routes'
const aliases: Record<string, TabId> = { home: 'dashboard', assistant: 'chat', more: 'settings', tasks: 'scheduled' }
function snapshot() {
  const state = core.getState()
  return { ...state, route: { screen: state.tab, params: state.routeParams }, serverRevision: state.revision,
    session: state.session as SessionPayload | null, toast: null, stack: [] }
}
export const store = {
  ...core,
  get: snapshot,
  push(screen: string, params?: Record<string, string>) { core.setTab(aliases[screen] || screen as TabId, params) },
  back() { core.returnFromSubPage() },
  navigate(screen: string, params?: Record<string, string>) { core.setTab(aliases[screen] || screen as TabId, params) },
  toast(text: string, tone: 'ok' | 'err' | 'warn' = 'ok') { core.toast(text, tone === 'err' ? 'danger' : tone === 'ok' ? 'success' : 'info') },
}
export function useStore() { useCoreStore(); return snapshot() }
export function bootstrapTheme() {}
