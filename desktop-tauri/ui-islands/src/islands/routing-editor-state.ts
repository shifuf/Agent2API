import * as React from 'react'
import { t } from '../i18n'
import { bridge, errorMessage, host, notify, type RouteProfile, type RoutingWorkspace } from './routing-types'
import { adoptAccountSorting } from './accounts-sort'
import type { AccountRecord, AccountSorting } from './accounts-shared'
import { canSyncSortingRevision, syncRoutingSorting } from './routing-sorting-state'

export type RoutingDraft = { mode: 'inherit' | 'custom'; profile: RouteProfile; baseline: RouteProfile | null; revision: string; workspace: RoutingWorkspace }
const clone = (value: RouteProfile) => structuredClone(value)
export function editableProfile(workspace: RoutingWorkspace): RouteProfile {
  const profile = clone(workspace.profile)
  if (!workspace.model) { profile.strategy = workspace.settings.routingStrategy; profile.sticky = workspace.settings.routingSticky }
  return profile
}
export function draftDirty(draft: RoutingDraft) {
  return JSON.stringify(draft.mode === 'inherit' ? null : draft.profile) !== JSON.stringify(draft.baseline)
}
/** 全局网关设置草稿；对外模型和成员路由统一由路由组管理。 */
export function useRoutingEditor(onSaved: () => void) {
  const [scope, setScope] = React.useState('')
  const [drafts, setDrafts] = React.useState<Record<string, RoutingDraft>>({})
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const sequence = React.useRef(0)
  const refs = React.useRef({ drafts, scope, busy, loading })
  refs.current = { drafts, scope, busy, loading }
  const load = React.useCallback(async (_model: string, force = false) => {
    if (refs.current.busy) return
    const model = ''
    setScope(model)
    const id = ++sequence.current
    if (!force && refs.current.drafts[model] && draftDirty(refs.current.drafts[model])) { setError(''); setLoading(false); return }
    setLoading(true); setError('')
    try {
      const workspace = await bridge().getRoutingWorkspace(model || undefined)
      if (id !== sequence.current) return
      if (!workspace.revision) throw new Error(t('路由配置版本不可用，请更新网关后重试'))
      const profile = editableProfile(workspace)
      const independent = true
      setDrafts(current => ({ ...current, [model]: { workspace, mode: independent ? 'custom' : 'inherit', profile,
        baseline: independent ? clone(profile) : null, revision: workspace.revision! } }))
    } catch (failure) { if (id === sequence.current) setError(errorMessage(failure)) }
    finally { if (id === sequence.current) setLoading(false) }
  }, [])
  const update = (mutate: (draft: RoutingDraft) => RoutingDraft) => {
    if (refs.current.busy || refs.current.loading) return
    setDrafts(current => current[scope] ? { ...current, [scope]: mutate(current[scope]) } : current)
  }
  const syncAccounts = React.useCallback((accounts: AccountRecord[], updatedAt?: number) => {
    setDrafts(current => Object.fromEntries(Object.entries(current).map(([model, draft]) => [model,
      updatedAt != null && updatedAt < draft.workspace.updatedAt ? draft : { ...draft, workspace: { ...draft.workspace, accounts } },
    ])))
  }, [])
  const syncSorting = React.useCallback((sorting: AccountSorting) => {
    if (!sorting?.rules || !sorting.accountOrder) return
    setDrafts(current => Object.fromEntries(Object.entries(current).map(([model, draft]) => [model,
      model ? syncRoutingSorting(draft, sorting) : draft,
    ])))
  }, [])
  const syncWorkspace = React.useCallback((workspace: RoutingWorkspace, convertedGlobalAccounts = false) => {
    setDrafts(current => {
      const model = workspace.model?.toLowerCase() || '', draft = current[model]
      if (!draft) return current
      const dirty = draftDirty(draft), profile = editableProfile(workspace)
      if (!model && convertedGlobalAccounts) return { ...current, [model]: { ...draft, workspace,
        profile: dirty ? { ...draft.profile, providerScope: 'all', disabledProviders: [], excludedAccounts: [] } : profile,
        baseline: clone(profile), revision: workspace.revision || draft.revision } }
      if ((workspace.updatedAt || 0) < (draft.workspace.updatedAt || 0)) return current
      const synced = syncRoutingSorting(draft, workspace.sorting)
      const refreshOrder = workspace.sorting.updatedAt >= draft.workspace.sorting.updatedAt
        && canSyncSortingRevision(draft.workspace, workspace)
      return { ...current, [model]: { ...synced, revision: refreshOrder ? workspace.revision || draft.revision : draft.revision,
        workspace: { ...synced.workspace, accounts: workspace.accounts,
          ...(refreshOrder ? { profile: workspace.profile, inheritedProfile: workspace.inheritedProfile, revision: workspace.revision } : {}),
          accountStates: workspace.accountStates, metrics: workspace.metrics, queue: workspace.queue, updatedAt: workspace.updatedAt,
          globalAccountControl: workspace.globalAccountControl, legacyGlobalParticipation: workspace.legacyGlobalParticipation } } }
    })
  }, [])
  const save = async () => {
    const draft = refs.current.drafts[scope]
    if (!draft || refs.current.busy || refs.current.loading || !draftDirty(draft)) return
    refs.current.busy = true
    setBusy(true); setError('')
    try {
      const workspace = await bridge().saveRoutingProfile({ model: null, profile: draft.mode === 'inherit' ? null : draft.profile, revision: draft.revision })
      if (!workspace?.revision) throw new Error(t('保存响应不完整，请刷新当前配置确认结果'))
      const profile = editableProfile(workspace), independent = !scope || workspace.customized
      setDrafts(current => ({ ...current, [scope]: { workspace, mode: independent ? 'custom' : 'inherit', profile,
        baseline: independent ? clone(profile) : null, revision: workspace.revision! } }))
      adoptAccountSorting(workspace.sorting)
      if (!scope) void host().wbApp?.refresh?.()
      notify(t('路由配置已保存，仅影响后续选路'))
      onSaved()
    } catch (failure) { setError(errorMessage(failure)) }
    finally { refs.current.busy = false; setBusy(false) }
  }
  const discard = () => {
    const draft = drafts[scope]
    if (!draft || busy || loading) return
    update(current => ({ ...current, mode: current.baseline ? 'custom' : 'inherit', profile: current.baseline ? clone(current.baseline) : editableProfile(current.workspace) }))
    setError('')
  }
  React.useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (Object.values(refs.current.drafts).some(draftDirty)) event.preventDefault()
    }
    window.addEventListener('beforeunload', listener)
    return () => { sequence.current++; window.removeEventListener('beforeunload', listener) }
  }, [])
  return { scope, load, draft: drafts[scope], drafts, update, syncAccounts, syncSorting, syncWorkspace, save, discard, loading, busy, error,
    dirtyCount: Object.values(drafts).filter(draftDirty).length }
}
export type RoutingEditorState = ReturnType<typeof useRoutingEditor>
