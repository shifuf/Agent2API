import { useMemo, useState } from 'react'
import { imageToolApi } from '../core/api-images'
import { serverIdentity } from '../core/servers'
import { t } from '../core/i18n'
import { CommonCard } from '../ui/components'
import { ImageGenerationPanel } from '../../../ui-shared/tools-image-config'

export function ImageToolsSettings() {
  const [open, setOpen] = useState(false)
  const identity = serverIdentity()
  const api = useMemo(() => imageToolApi(identity), [identity])
  return <CommonCard>
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className='cursor-pointer text-sm font-semibold'>{t('图片生成与编辑')}</summary>
      {open ? <div className='mt-4'><ImageGenerationPanel key={identity} api={api} /></div> : null}
    </details>
  </CommonCard>
}
