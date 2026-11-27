import * as React from 'react'
import { DEFAULT_BRANDING, type brandingStore, type BrandingPatch } from './panel-branding-state'

type Store = ReturnType<typeof brandingStore>
export function useBrandDocument(title: string, logoUrl: string | null) {
  React.useEffect(() => {
    document.querySelector('title')?.removeAttribute('data-i18n')
    document.title = title
    if (!logoUrl) return
    const icon = document.createElement('link'); icon.rel = 'icon'; icon.type = 'image/png'; icon.href = logoUrl
    document.head.appendChild(icon)
    return () => icon.remove()
  }, [title, logoUrl])
}

export function useBranding(store: Store) {
  const scope = store.identity()
  const value = React.useSyncExternalStore(store.subscribe, store.snapshot)
  React.useEffect(() => {
    void store.refresh()
    const refresh = () => { if (!document.hidden) void store.refresh() }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [store, scope])
  return value
}

export function BrandEditor({ store, save, t }: { store: Store; save: (scope: string, patch: BrandingPatch) => Promise<void>; t: (key: string) => string }) {
  const brand = useBranding(store)
  const scope = store.identity()
  const [name, setName] = React.useState<string | null>(null)
  const [file, setFile] = React.useState<File | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const input = React.useRef<HTMLInputElement>(null)
  if (brand === DEFAULT_BRANDING) return null
  async function submit(reset: boolean) {
    if (busy || store.identity() !== scope) return
    setBusy(true); setMessage('')
    try {
      const patch: BrandingPatch = reset ? { displayName: null, logo: null } : {}
      if (!reset && name !== null) patch.displayName = name.trim()
      if (!reset && file) {
        if (file.size > 2 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(t('支持 PNG、JPEG、WebP，最大 2 MiB'))
        patch.logo = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(t('读取失败'))); reader.readAsDataURL(file)
        })
      }
      if (store.identity() !== scope) return
      await save(scope, patch)
      setName(null); setFile(null); if (input.current) input.current.value = ''
      setMessage(t('已保存'))
    } catch (error) { setMessage(error instanceof Error ? error.message : t('保存失败')) } finally { setBusy(false) }
  }
  return <fieldset disabled={busy} style={{ display: 'grid', gap: 8, padding: 14, border: '1px solid currentColor', borderRadius: 10 }}>
    <legend>{t('面板品牌')}</legend>
    <label>{t('显示名称')} <input maxLength={64} value={name ?? brand.displayName} onChange={event => setName(event.target.value)} /></label>
    <label>{t('品牌 Logo')} <input ref={input} type='file' accept='image/png,image/jpeg,image/webp' onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
    <small>{t('支持 PNG、JPEG、WebP，最大 2 MiB')}</small>
    <div style={{ display: 'flex', gap: 12 }}><button type='button' disabled={name === null && !file} onClick={() => void submit(false)}>{t('保存')}</button>
      <button type='button' onClick={() => void submit(true)}>{t('恢复默认品牌')}</button></div>
    <output aria-live='polite'>{message}</output>
  </fieldset>
}
