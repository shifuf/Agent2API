import * as React from 'react'
import { DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@ui'
import '../styles/channel-dialog.css'

type ChannelPanelContextValue = {
  host: HTMLDivElement | null
  activeId: string | null
  openPanel: (id: string, trigger?: HTMLElement) => void
  closePanel: () => void
  releasePanel: (id: string) => void
  intent: React.MutableRefObject<number>
}

const ChannelPanelContext = React.createContext<ChannelPanelContextValue | null>(null)

export function useChannelPanel() {
  const context = React.useContext(ChannelPanelContext)
  if (!context) throw new Error('Channel panels require ChannelDialogContent')
  return context
}

/** The form stays centered; group operations expand a panel inside the same dialog. */
export function ChannelDialogContent({ title, description, children, footer, sidebar, open = true, scope = '', keepMounted = false }: {
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  footer: React.ReactNode
  sidebar?: React.ReactNode
  open?: boolean
  scope?: string
  keepMounted?: boolean
}) {
  const [host, setHost] = React.useState<HTMLDivElement | null>(null)
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const opener = React.useRef<HTMLElement | null>(null)
  const intent = React.useRef(0)
  const openPanel = React.useCallback((id: string, trigger?: HTMLElement) => {
    intent.current++
    opener.current = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setActiveId(id)
  }, [])
  const closePanel = React.useCallback(() => {
    intent.current++
    const target = opener.current
    // Move focus before removing the focused panel; otherwise the dialog's
    // removed-focus recovery may subsequently override a deferred restoration.
    if (target?.isConnected) target.focus({ preventScroll: true })
    setActiveId(null)
  }, [])
  const releasePanel = React.useCallback((id: string) => {
    intent.current++
    setActiveId(previous => previous === id ? null : previous)
  }, [])
  React.useEffect(() => { intent.current++; setActiveId(null) }, [open, scope])
  const context = React.useMemo(() => ({ host, activeId, openPanel, closePanel, releasePanel, intent }), [host, activeId, openPanel, closePanel, releasePanel])

  return <ChannelPanelContext.Provider value={context}>
    <DialogContent overlayForceRender keepMounted={keepMounted} data-channel-dialog
      data-panel-open={Boolean(activeId)} data-has-sidebar={Boolean(sidebar)} className='acct-add-form-dialog channel-dialog'
      onPointerDownCapture={event => {
        if (event.target instanceof Element && event.target.closest('[data-channel-panel]')) intent.current++
      }}
      onKeyDownCapture={event => {
        if (event.target instanceof Element && event.target.closest('[data-channel-panel]')) intent.current++
        // A nested editor owns its own Escape handling, even though portals bubble through React.
        if (event.key === 'Escape' && activeId && event.target instanceof Element
          && event.target.closest('[role="dialog"]') === event.currentTarget) {
          event.preventDefault()
          event.stopPropagation()
          closePanel()
        }
      }}>
      <DialogHeader>
        <div className='min-w-0 flex-1'>
          <DialogTitle>{title}</DialogTitle>
          {description && <p className='mt-1 text-xs text-subtle'>{description}</p>}
        </div>
      </DialogHeader>
      <div className='channel-dialog-workspace'>
        {sidebar && <aside className='channel-dialog-sidebar'>{sidebar}</aside>}
        <DialogBody className='channel-dialog-form'>{children}</DialogBody>
        <div ref={setHost} className='channel-dialog-panel' hidden={!activeId} />
      </div>
      <DialogFooter><div className='acct-add-foot-host'>{footer}</div></DialogFooter>
    </DialogContent>
  </ChannelPanelContext.Provider>
}
