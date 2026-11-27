import { useEffect, useRef, useState } from 'react'
import { readFileAsDataUrl } from './file-read'
import type { PluginRequest } from './plugin-controls'

type Archive = { name: string; version: string; entry: string; sha256: string; previousSha256?: string | null }
const archivesPath = '/api/plugins/community/archives'

export function CommunityInspector({ request, t, canAbort }: { request: PluginRequest; t: (key: string) => string; canAbort: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [digest, setDigest] = useState('')
  const [source, setSource] = useState('file')
  const [name, setName] = useState('')
  const [revision, setRevision] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [items, setItems] = useState<Archive[]>([])
  const [checked, setChecked] = useState<Archive | null>(null)
  const [executionAvailable, setExecutionAvailable] = useState(false)
  const [probing, setProbing] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => { controller.current?.abort(); controller.current = null }, [])
  async function refresh() {
    const snapshot = await request<{ items: Archive[]; executionAvailable: boolean }>('GET', archivesPath)
    setExecutionAvailable(snapshot.executionAvailable === true); setItems(snapshot.items)
  }
  async function probe(item: Archive) {
    if (!executionAvailable || !canAbort || busy || controller.current || !window.confirm(`${t('仅在隔离客体中试运行，不启用此插件。')}\n${item.name}@${item.version}\nSHA-256: ${item.sha256}`)) return
    const attempt = new AbortController(); controller.current = attempt
    setProbing(true); setBusy(true); setMessage('')
    try {
      const result = await request<{status: string; hook: string; sha256: string; metadataOnly: boolean; installed: boolean}>('POST', '/api/plugins/community/probe', { name: item.name, sha256: item.sha256 }, attempt.signal)
      if (result.status !== 'completed' || result.sha256 !== item.sha256 || result.hook !== 'server' || result.metadataOnly !== true || result.installed !== false) throw new Error(t('操作失败'))
      if (controller.current === attempt && !attempt.signal.aborted) setMessage(t('隔离试跑完成，未启用插件。'))
    } catch (error) { if (controller.current === attempt && !attempt.signal.aborted) setMessage(error instanceof Error ? error.message : t('操作失败')) }
    finally { if (controller.current === attempt) { controller.current = null; setProbing(false); setBusy(false) } }
  }
  async function inspect(retain = false) {
    if (busy || (source === 'file' && !file)) return
    setBusy(true); setMessage('')
    try {
      const encoded = source === 'file' && file ? await readFileAsDataUrl(file, t('读取失败')) : ''
      const previous = items.find(item => item.name === checked?.name)
      const options = { retain, sha256: digest.trim(), previousSha256: retain ? previous?.sha256 : undefined }
      const result = await request<Archive>('POST', `/api/plugins/community/${source === 'file' ? 'inspect' : 'inspect-source'}`, source === 'file' ? { archive: encoded.slice(encoded.indexOf(',') + 1), ...options } : { kind: source, name: name.trim(), revision: revision.trim(), ...options })
      await refresh()
      setChecked(retain ? null : result)
      setMessage(`${result.name}@${result.version} · ${result.entry}`)
    } catch (error) { setChecked(null); setMessage(error instanceof Error ? error.message : t('操作失败')) }
    finally { setBusy(false) }
  }
  async function change(item: Archive, action: 'rollback' | 'remove') {
    if (busy || !window.confirm(`${t(action === 'rollback' ? '恢复前一份归档' : '删除')} ${item.name}@${item.version}?`)) return
    setBusy(true); setMessage(''); setChecked(null)
    try { await request('POST', archivesPath, { action, name: item.name, sha256: item.sha256 }); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : t('操作失败')) }
    finally { setBusy(false) }
  }
  return <details data-community-inspector onChangeCapture={() => setChecked(null)} onToggle={event => { if (event.currentTarget.open) void refresh().catch(error => setMessage(error instanceof Error ? error.message : t('操作失败'))) }}>
    <summary>{t('社区脚本验包')}</summary>
    <p>{t('只检查归档，不安装、不运行。请从可信发布者另行取得 SHA-256。')}</p>
    <select aria-label={t('来源')} disabled={busy} value={source} onChange={event => { setSource(event.target.value); setMessage(''); setDigest(''); setName(''); setRevision('') }}><option value='file'>.tgz / .tar.gz</option><option value='npm'>npm</option><option value='github'>GitHub</option></select>
    {source === 'file' ? <label>.tgz / .tar.gz (≤ 4 MiB) <input disabled={busy} type='file' accept='.tgz,.tar.gz' onChange={event => { setFile(event.target.files?.[0] ?? null); setMessage('') }} /></label> : <>
      <label>{source === 'npm' ? 'npm (@scope/package)' : 'GitHub (owner/repo)'} <input disabled={busy} value={name} onChange={event => { setName(event.target.value); setMessage('') }} /></label>
      <label>{source === 'npm' ? t('版本') : 'Commit SHA'} <input disabled={busy} value={revision} onChange={event => { setRevision(event.target.value); setMessage('') }} /></label>
    </>}
    <label>SHA-256 <input disabled={busy} type='text' value={digest} maxLength={64} spellCheck={false} onChange={event => { setDigest(event.target.value); setMessage('') }} /></label>
    <button type='button' disabled={busy || (source === 'file' ? !file || file.size > 4 * 1024 * 1024 : !name.trim() || !revision.trim()) || !/^[0-9a-f]{64}$/i.test(digest)} onClick={() => void inspect()}>{t('检查归档')}</button>
    {checked && <button type='button' disabled={busy} onClick={() => void inspect(true)}>{t('保存已检查的归档（不启用）')}</button>}
    <output aria-live='polite'>{message}</output>
    {probing && <button type='button' onClick={() => { controller.current?.abort(); setMessage(t('已取消')) }}>{t('取消')}</button>}
    {items.map(item => <p key={item.name}><code>{item.name}@{item.version} · {item.sha256.slice(0, 12)}</code> {executionAvailable && canAbort && <button type='button' disabled={busy} onClick={() => void probe(item)}>{t('隔离试跑')}</button>} {item.previousSha256 && <button type='button' disabled={busy} onClick={() => void change(item, 'rollback')}>{t('恢复前一份归档')}</button>} <button type='button' disabled={busy} onClick={() => void change(item, 'remove')}>{t('删除')}</button></p>)}
  </details>
}
