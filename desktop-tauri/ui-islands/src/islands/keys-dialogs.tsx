import * as React from 'react'
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@ui'
import { t } from '../i18n'
import { errorMessage, stringList, type KeyEntry, type KeyRestrictions, type KeysBridge, type KeysPayload, type ProviderOption } from './keys-data'
import { KeyScopeFields } from './keys-selection-dialog'

type EditorProps = {
  mode: 'create' | 'edit' | 'scope'
  target?: KeyEntry
  api?: KeysBridge
  providers: ProviderOption[]
  modelsByProvider: Record<string, string[]>
  onClose(): void
  onSaved(payload: KeysPayload | null | undefined): void
}

export function KeyEditorDialog({ mode, target, api, providers, modelsByProvider, onClose, onSaved }: EditorProps) {
  const [name, setName] = React.useState(target?.name || '')
  const [keyValue, setKeyValue] = React.useState('')
  const [restrictions, setRestrictions] = React.useState<KeyRestrictions>(() => ({
    allowedProviders: stringList(target?.allowedProviders), allowedModels: stringList(target?.allowedModels),
  }))
  const [error, setError] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const savingRef = React.useRef(false)
  const title = mode === 'create' ? t('新建 API Key') : mode === 'edit' ? t('编辑 Key') : t('可用范围 · {name}', { name: target?.name || t('未命名') })

  async function save(): Promise<void> {
    if (savingRef.current) return
    const customKey = keyValue.trim()
    if (mode === 'create' && customKey && customKey.length < 8) {
      setError(t('Key 至少需要 8 个字符'))
      return
    }
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      if (!api) throw new Error(t('后端桥不可用'))
      const next = mode === 'create'
        ? await api.createKey({ name: name.trim(), key: customKey || undefined, ...restrictions })
        : target ? await api.updateKey(target.id, mode === 'scope' ? restrictions : { name: name.trim() }) : undefined
      onSaved(next)
    } catch (cause) {
      setError(t('保存失败：{reason}', { reason: errorMessage(cause) }))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return <Dialog open onOpenChange={(open, details) => {
    if (!open) {
      if (savingRef.current) details.cancel()
      else onClose()
    }
  }}>
    <DialogContent data-key-editor={mode}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <DialogBody>
        {mode !== 'scope' && <div className='space-y-2'>
          <Label htmlFor='key-name'>{t('名称')}</Label>
          <Input id='key-name' autoFocus maxLength={60} placeholder={t('例如 Cursor / 公司电脑')} autoComplete='off' value={name}
            disabled={saving} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save() }} />
        </div>}
        {mode === 'create' && <>
          <p className='text-xs text-subtle'>{t('创建后自动生成 Key，可在详情中查看和复制。')}</p>
          <details className='rounded-md border border-border p-3'>
            <summary className='cursor-pointer text-xs font-medium'>{t('高级选项')}</summary>
            <div className='mt-3 space-y-2'>
              <Label htmlFor='key-value'>{t('自定义 Key')}</Label>
              <Input id='key-value' type='password' autoComplete='new-password' spellCheck={false} value={keyValue} disabled={saving}
                placeholder={t('留空自动生成；手填至少 8 个字符')} onChange={event => setKeyValue(event.target.value)} />
            </div>
          </details>
        </>}
        {mode !== 'edit' && <KeyScopeFields value={restrictions} onChange={setRestrictions} providers={providers} modelsByProvider={modelsByProvider} disabled={saving} />}
        {mode === 'edit' && <p className='text-xs text-subtle'>{t('模型和渠道权限可通过列表中的「可用范围」调整。')}</p>}
        {error && <p role='alert' className='text-xs text-destructive'>{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant='outline' disabled={saving} onClick={onClose}>{t('取消')}</Button>
        <Button disabled={saving} onClick={() => void save()}>{saving ? t('保存中…') : mode === 'create' ? t('创建') : mode === 'scope' ? t('保存范围') : t('保存')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function KeyViewDialog({ target, onClose }: { target: KeyEntry; onClose(): void }) {
  const [revealed, setRevealed] = React.useState(false)
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent data-key-view>
      <DialogHeader><DialogTitle>{t('查看 Key')}</DialogTitle></DialogHeader>
      <DialogBody>
        <div className='flex items-center gap-2'><span className='min-w-0 flex-1 break-words font-medium'>{target.name || t('未命名')}</span>
          <Badge variant={target.enabled !== false ? 'success' : 'secondary'}>{target.enabled !== false ? t('已启用') : t('已停用')}</Badge>
        </div>
        <div className='space-y-2'>
          <Label htmlFor='key-credential'>{t('Key 凭据')}</Label>
          <Input id='key-credential' readOnly type={revealed ? 'text' : 'password'} value={target.key || ''} className='font-mono' />
          <div className='flex justify-end gap-2'>
            <Button size='sm' variant='outline' onClick={() => setRevealed(value => !value)}>{revealed ? t('隐藏') : t('显示')}</Button>
            <Button size='sm' data-copy={target.key} disabled={!target.key}>{t('复制 Key')}</Button>
          </div>
        </div>
        <div className='space-y-2 rounded-md border border-border bg-surface-inset p-3 text-xs'>
          <p className='text-subtle'>{t('客户端请求需携带以下任一请求头：')}</p>
          <code className='block break-all'>Authorization: Bearer {revealed ? target.key : '<key>'}</code>
          <code className='block break-all'>x-api-key: {revealed ? target.key : '<key>'}</code>
        </div>
      </DialogBody>
      <DialogFooter><Button variant='outline' onClick={onClose}>{t('完成')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
