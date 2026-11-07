import * as React from 'react'
import { Button, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@ui'
import { t } from '../i18n'

/** Shared shell for channel creation and group editing; the caller owns the Sheet root. */
export function ChannelDrawerContent({ title, description, children, footer, keepMounted = false }: {
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  footer: React.ReactNode
  keepMounted?: boolean
}) {
  const body = React.useRef<HTMLDivElement>(null)
  const scrollToSection = (section: string) => {
    const target = Array.from(body.current?.querySelectorAll<HTMLElement>(`[data-channel-section="${section}"]`) || [])
      .find(node => node.getClientRects().length > 0)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return <SheetContent side='left' showHandle={false} overlayForceRender keepMounted={keepMounted}
    className='acct-add-form-dialog w-[min(900px,100vw)] max-w-full rounded-none'>
    <SheetHeader className='min-h-16'>
      <div className='min-w-0 flex-1'>
        <SheetTitle>{title}</SheetTitle>
        {description && <p className='mt-1 text-xs text-subtle'>{description}</p>}
      </div>
    </SheetHeader>
    <div className='flex min-h-0 flex-1'>
      <nav aria-label={t('渠道配置')} className='hidden w-36 shrink-0 flex-col gap-1 border-r border-hairline bg-surface-2 px-3 py-4 sm:flex'>
        <Button variant='ghost' className='justify-start' onClick={() => scrollToSection('details')}>{t('基本配置')}</Button>
        <Button variant='ghost' className='justify-start' onClick={() => scrollToSection('keys')}>{t('API Key 分组')}</Button>
      </nav>
      <SheetBody ref={body} className='min-w-0 gap-5'>{children}</SheetBody>
    </div>
    <SheetFooter className='justify-end'>{footer}</SheetFooter>
  </SheetContent>
}
