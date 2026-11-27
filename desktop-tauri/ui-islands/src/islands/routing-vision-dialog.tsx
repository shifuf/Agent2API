import * as React from 'react'
import { Button, Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, confirmDialog } from '@ui'
import { t } from '../i18n'
import { VisionSpecialPanel } from './routing-special-panels'
import { useSpecialEditor, type VisionConfig, type VisionView } from './routing-special-state'

export type VisionApi = (method: 'GET' | 'PUT', path: string, body?: { config: VisionConfig; revision: string; consent: boolean }) => Promise<VisionView>
const endpoint = '/api/vision-compatibility'

export function VisionAssistSettings({ api }: { api: VisionApi }) {
  const [open, setOpen] = React.useState(false)
  const adapter = React.useMemo(() => ({
    load: () => api('GET', endpoint),
    save: (body: { config: VisionConfig; revision: string }) => api('PUT', endpoint, { ...body, consent: true }),
  }), [api])
  const editor = useSpecialEditor(adapter, open)
  const close = async () => {
    if (!editor.saving && (!editor.dirty || await confirmDialog(t('放弃未保存的修改？')))) {
      editor.discard()
      setOpen(false)
    }
  }
  return <><Button size='sm' variant='outline' onClick={() => setOpen(true)}>{t('视觉辅助')}</Button><Dialog open={open} onOpenChange={next => { if (!next) void close() }}>
    <DialogContent className='w-[min(960px,calc(100vw-24px))]'><DialogHeader><DialogTitle>{t('视觉辅助')}</DialogTitle></DialogHeader><DialogBody className='grid gap-3'>
      <p>{t('文本组收到内嵌图片时，先调用视觉组描述图片，再由原文本组回答。两次上游调用分别计费；原生视觉组无需额外调用。')}</p>
      <p>{t('隐私模式不转发图片；无法识别或未获授权时不会改用其他组。')}</p>
      <VisionSpecialPanel editor={editor} />
      </DialogBody></DialogContent></Dialog></>
}
