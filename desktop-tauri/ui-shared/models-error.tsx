import { Alert, Button } from '@ui'
import type { Translate } from './models-types'

export function ModelError({ error, busy, onRefresh, t }: { error: string; busy: boolean; onRefresh: () => void; t: Translate }) {
  return error ? <Alert variant='destructive'><div className='flex flex-wrap items-center justify-between gap-3'>
    <span>{error}</span><Button size='sm' variant='outline' disabled={busy} onClick={onRefresh}>{t('刷新目录，保留草稿')}</Button>
  </div></Alert> : null
}
