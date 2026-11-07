import { accountRequest, shared } from './add-account-bridge'
import { ModelsWorkspace } from '../../../ui-shared/models-workspace'
import { t } from '../i18n'

function onChanged() {
  void shared().wbApp?.refresh?.()
  const keys = (window as unknown as { wbKeysPanel?: { load?: () => Promise<void> } }).wbKeysPanel
  void keys?.load?.()
}
export function ManagedModelsPage({ onSources }: { onSources: () => void }) {
  return <ModelsWorkspace request={accountRequest} onSources={onSources} onChanged={onChanged} t={t} />
}
