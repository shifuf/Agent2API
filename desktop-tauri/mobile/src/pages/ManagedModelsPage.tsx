import { ModelsWorkspace } from '../../../ui-shared/models-workspace'
import type { ModelRequest } from '../../../ui-shared/models-types'
import { apiCall } from '../api/client'
import { t } from '../i18n'
const request: ModelRequest = (method, path, body) => apiCall(path, { method, body })
export function ManagedModelsPage({ onSources }: { onSources: () => void }) {
  return <div className='m-page'><ModelsWorkspace request={request} onSources={onSources} t={t} /></div>
}
