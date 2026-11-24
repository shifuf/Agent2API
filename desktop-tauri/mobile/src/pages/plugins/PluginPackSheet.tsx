import { useState } from 'react'
import { Badge, Button, Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@ui'
import { apiCall } from '../../api/client'
import type { PackSummary } from '../../api/plugins'
import { locale, t } from '../../i18n'
import { PluginProviderSettings } from '../../../../ui-shared/plugin-provider-settings'
import { PluginHelpers } from '../../../../ui-shared/plugin-helpers'
import type { PluginRequest } from '../../../../ui-shared/plugin-controls'

const request: PluginRequest = (method, path, body) => apiCall(path, {
  method, ...(body === undefined ? {} : { body }),
})

export function PluginPackSheet({ pack, disabled, onClose }: { pack: PackSummary; disabled: boolean; onClose: () => void }) {
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [helpersBusy, setHelpersBusy] = useState(false)
  const locked = disabled || settingsBusy || helpersBusy
  return <Sheet open onOpenChange={(open, details) => { if (!open) { if (locked) details.cancel(); else onClose() } }}>
    <SheetContent showCloseButton={!locked}>
      <SheetHeader><SheetTitle>{t(pack.name)} · {t('设置')}</SheetTitle></SheetHeader>
      <SheetBody className='flex flex-col gap-4'>
        <div className='flex flex-wrap gap-2 text-xs text-muted-foreground'>
          <span>v{pack.version}</span><Badge variant='outline'>{pack.enabled ? t('已启用') : t('已停用')}</Badge>
        </div>
        <PluginProviderSettings packId={pack.id} providers={pack.providers} request={request} t={t} locale={locale()}
          disabled={locked} onBusyChange={setSettingsBusy} />
        <PluginHelpers packId={pack.id} providers={pack.providers} enabled={pack.enabled} request={request} t={t}
          disabled={locked} onBusyChange={setHelpersBusy} />
      </SheetBody>
      <SheetFooter><Button variant='outline' disabled={locked} onClick={onClose}>{t('关闭')}</Button></SheetFooter>
    </SheetContent>
  </Sheet>
}
