import * as React from 'react'
import { Button } from '@ui'
import { t } from '../i18n'
import { isCustomProviderId } from './accounts-domain'
import { shared, toast } from './accounts-shared'
import { ChannelKeyGroupsDialog } from './channel-key-groups'

/** Discovery belongs with the credentialed source; publication belongs to routing groups. */
export function AccountModelFetchButton({ provider, name, disabled, compact = false }: {
  provider?: string; name?: string; disabled?: boolean; compact?: boolean
}) {
  const [editing, setEditing] = React.useState(false)
  const open = () => {
    if (provider && isCustomProviderId(provider)) { setEditing(true); return }
    const modal = window.wbModelsFetchModal
    if (!modal) { toast(t('模型目录刷新不可用，请重新打开面板'), 'err'); return }
    modal.open({
      providerId: provider || '', providers: provider ? [provider] : undefined,
      name: name || t('内置提供商'),
      onRefreshed: () => { void shared().wbApp?.refresh?.() },
    })
  }
  return <>
    <Button id={compact ? undefined : 'btn-fetch-upstream-models'} variant='outline' size={compact ? 'xs' : 'default'}
      disabled={disabled} onClick={open}>{t('获取上游模型')}</Button>
    {editing && provider && <ChannelKeyGroupsDialog providerId={provider} onClose={() => setEditing(false)} />}
  </>
}
