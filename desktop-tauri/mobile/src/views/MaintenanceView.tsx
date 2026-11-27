import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { MaintenancePanel } from '../../../ui-shared/maintenance-panel'
import { maintenanceApi } from '../core/api-maintenance'
import { t } from '../core/i18n'
import { serverIdentity } from '../core/servers'
import { store, useStore } from '../core/store'
import { CommonScaffold } from '../ui/components'

export function MaintenanceView({ navigation }: { navigation: ReactNode }) {
  const { revision, navTabs } = useStore()
  const identity = serverIdentity()
  const api = useMemo(() => maintenanceApi(identity), [identity])
  const current = () => identity === serverIdentity()
  return <CommonScaffold title={t('自动维护')} stickyHeader={navigation}
    onBack={!navTabs.includes('scheduled') ? () => store.returnFromSubPage() : undefined}>
    <MaintenancePanel key={identity} api={api} revision={revision}
      notify={(message, kind) => { if (current()) store.toast(message, kind === 'err' ? 'danger' : kind === 'warn' ? 'info' : 'success') }}
      onChanged={() => current() ? store.refresh(true) : undefined}
      onAccount={id => {
        if (!current()) return
        store.setTab('accounts')
        const account = store.getState().session?.accounts?.accounts?.find(item => item.id === id)
        if (account) store.openSheet({ kind: 'account-detail', account })
      }} />
  </CommonScaffold>
}
