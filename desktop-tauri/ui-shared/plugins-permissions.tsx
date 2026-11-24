import type { ReactNode } from 'react'
import type { PluginTranslate } from './plugin-controls'

export function PluginPermissions({ children, t }: { children: ReactNode; t: PluginTranslate }) {
  return <section className='flex min-w-0 flex-col gap-3 rounded-lg border border-hairline p-3 text-xs text-muted-foreground' aria-label={t('权限')}>
    <h3 className='text-sm font-medium text-foreground'>{t('权限')}</h3>
    {children}
  </section>
}
