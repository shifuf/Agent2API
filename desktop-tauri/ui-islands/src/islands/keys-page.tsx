import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Badge, Button, Card, CardHeader, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ui'
import { mountOnPage } from '../island-lazy'
import { t } from '../i18n'
import { TableFooter, useClientPaging } from './table-shell'
import { KeyEditorDialog, KeyViewDialog } from './keys-dialogs'
import { errorMessage, filterKeys, type KeyEntry, type KeysBridge, type KeysPayload, type ProviderOption } from './keys-data'

// Keep the shared page/column bridge used by app.js and table-columns.js.
type Align = 'left' | 'center' | 'right'
type ColumnDecl = { key: string; label: string; align?: Align }
type ColSettingsHandle = { apply<C extends { key: string }>(columns: C[]): (C & { align: Align })[] }
type SharedWindow = {
  workbuddyDesktop?: KeysBridge
  wbApp?: { toast?: (message: string, kind?: 'err' | 'ok') => void; formatTime?: (value: unknown) => string; renderTopbarStatus?: () => void; readonly currentPage?: string }
  wbConfirm?: { ask?: (options: { title?: string; html?: string; okText?: string; okClass?: string }) => Promise<boolean> }
  wbColSettings?: {
    register(spec: { id: string; label?: string; columns: readonly ColumnDecl[]; mount?: () => Element | null; onChange?: () => void }): ColSettingsHandle
    syncStaticHead(id: string, table: Element | null | undefined): void
  }
}
const shared = () => window as unknown as SharedWindow
const toast = (message: string, kind?: 'err' | 'ok') => shared().wbApp?.toast?.(message, kind)
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch))
}
const COLUMNS: readonly ColumnDecl[] = [
  { key: 'name', label: t('名称') }, { key: 'key', label: 'Key' },
  { key: 'time', label: t('创建时间') }, { key: 'state', label: t('状态') },
  { key: 'act', label: t('操作'), align: 'right' },
]
const CELL_CLASS: Record<string, string> = { name: 'cell-name', key: 'cell-key', time: 'cell-time', state: 'cell-state state', act: 'cell-act r' }
const SECTION = '.page[data-page="keys"]'
let colSettings: ColSettingsHandle | null = null
let onColumnsChanged: (() => void) | null = null
function visibleColumns(): (ColumnDecl & { align: Align })[] {
  return colSettings ? colSettings.apply([...COLUMNS]) : COLUMNS.map(column => ({ ...column, align: column.align ?? 'left' }))
}
function syncHead(): void {
  shared().wbColSettings?.syncStaticHead?.('keys', document.querySelector('table.keys-table'))
}
function setupColumns(): void {
  if (colSettings) return
  colSettings = shared().wbColSettings?.register({
    id: 'keys', label: t('网关 Key 表'), columns: COLUMNS,
    mount: () => document.querySelector('.page[data-page="keys"] .panel-head .head-actions'),
    onChange: () => { syncHead(); onColumnsChanged?.() },
  }) ?? null
  if (colSettings) syncHead()
}
const keysOf = (payload: KeysPayload | null): KeyEntry[] => Array.isArray(payload?.keys) ? payload.keys : []
const providersOf = (payload: KeysPayload | null): ProviderOption[] => Array.isArray(payload?.providers) ? payload.providers : []
const modelsByProviderOf = (payload: KeysPayload | null): Record<string, string[]> => payload?.modelsByProvider || {}
const channelLabel = (provider: ProviderOption): string => provider.removed ? t('已移除渠道：{id}', { id: provider.id }) : t(provider.label || provider.id)
function restrictionText(key: KeyEntry, labelOf: (id: string) => string): string {
  const channels = key.allowedProviders || []
  const models = key.allowedModels || []
  if (!channels.length && !models.length) return t('不限制')
  return [channels.length ? channels.map(labelOf).join(t('、')) : '', models.length ? t('{n} 个模型', { n: models.length }) : ''].filter(Boolean).join(' / ')
}
function restrictionTitle(key: KeyEntry, labelOf: (id: string) => string): string {
  const channels = key.allowedProviders || []
  const models = key.allowedModels || []
  if (!channels.length && !models.length) return t('这把 Key 可用全部渠道与全部已发布模型')
  return [channels.length ? t('可用渠道：{names}', { names: channels.map(labelOf).join(t('、')) }) : '',
    models.length ? t('可用模型：{names}', { names: models.join(t('、')) }) : ''].filter(Boolean).join('\n')
}

/* ─── 页面本体 ───────────────────────────────── */

/** 组件挂载后登记的入口：对外契约的 load / render 都经它转发 */
type PageHandle = {
  load(): Promise<void>
  /** 旧实现的重绘入口（当前无外部调用点，保留契约） */
  render(): void
}

let handle: PageHandle | null = null

/** app.js 切到本页时调它拉一次（挂载前的调用见文件末尾的说明） */
async function load(): Promise<void> {
  await handle?.load()
}

/** 保留旧实现的能力：按当前数据重绘一次 */
function render(): void {
  handle?.render()
}

function KeysPage() {
  const [data, setData] = React.useState<KeysPayload | null>(null)
  const [search, setSearch] = React.useState('')
  const [status, setStatus] = React.useState('all')
  /** 在途操作的行（按钮与开关禁用）；同步守卫读下面的 ref */
  const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set())
  const [modal, setModal] = React.useState<{ mode: 'create' | 'edit' | 'view' | 'scope'; key?: KeyEntry } | null>(null)
  /** 列设置改了 / 契约 render() 被调 → 强制重画（数据没变但可见列变了） */
  const [, setVersion] = React.useState(0)

  const pendingRef = React.useRef<Set<string>>(new Set())
  const loadingRef = React.useRef(false)

  const applyData = React.useCallback((next: KeysPayload | null) => {
    setData(next)
  }, [])

  /** 写接口返回的最新列表：形状不对（读失败）时保持原样，与旧实现的 accept 同口径 */
  const accept = React.useCallback((next: KeysPayload | null | undefined) => {
    if (next && Array.isArray(next.keys)) applyData(next)
  }, [applyData])

  const loadPanel = React.useCallback(async (): Promise<void> => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const api = shared().workbuddyDesktop
      if (!api) throw new Error(t('后端桥不可用'))
      applyData((await api.getKeys()) ?? null)
    } catch (error) {
      toast(t('读取 Key 列表失败：{reason}', { reason: errorMessage(error) }), 'err')
    } finally {
      loadingRef.current = false
    }
  }, [applyData])

  /** 行内异步操作的统一外壳：置忙 → 跑 → 用返回值刷新 → 收忙（失败只 toast） */
  async function runRowAction(
    id: string,
    run: () => Promise<KeysPayload | null | undefined>,
    doneText?: string,
  ): Promise<void> {
    if (pendingRef.current.has(id)) return
    pendingRef.current.add(id)
    setPending(new Set(pendingRef.current))
    try {
      accept(await run())
      if (doneText) toast(doneText)
    } catch (error) {
      toast(t('操作失败：{reason}', { reason: errorMessage(error) }), 'err')
    } finally {
      pendingRef.current.delete(id)
      setPending(new Set(pendingRef.current))
    }
  }

  /** 删除：原生 confirm 在 Tauri 的 WebView 里不弹窗、直接放行（等于没有确认） */
  async function removeKey(k: KeyEntry): Promise<void> {
    const api = shared().workbuddyDesktop
    const ask = shared().wbConfirm?.ask
    if (!api || !ask) return
    const label = escapeHtml(k.name || k.masked || k.id)
    const confirmed = await ask({
      title: t('删除网关 Key'),
      html: t('确定删除 Key「<strong>{name}</strong>」？使用它的客户端会立刻无法访问。', { name: label }),
      okText: t('删除'),
      okClass: 'danger',
    })
    if (!confirmed) return
    void runRowAction(k.id, () => api.deleteKey(k.id), t('Key 已删除'))
  }

  /** 开关：写接口回的是最新列表，就地替换（与旧实现的 runRowAction 同路） */
  function toggleEnabled(k: KeyEntry, next: boolean): void {
    const api = shared().workbuddyDesktop
    if (!api) return
    void runRowAction(
      k.id,
      () => api.updateKey(k.id, { enabled: next }),
      next ? t('Key 已启用') : t('Key 已停用'),
    )
  }

  /* ─── 挂载期的两件事：契约登记 + 列设置（见文件头）────── */

  React.useLayoutEffect(() => {
    handle = {
      load: loadPanel,
      render: () => setVersion(version => version + 1),
    }
    onColumnsChanged = () => setVersion(version => version + 1)
    setupColumns()
    // 注册完必须再画一次：首帧的 visibleColumns() 还是「列设置未就绪」的回退值
    // （全部列、声明顺序），用户藏过列的话表头与表体会对不上。layout effect 里的
    // setState 是同步重画，发生在浏览器绘制之前，看不到这一帧。
    setVersion(version => version + 1)
    return () => {
      handle = null
      onColumnsChanged = null
    }
  }, [loadPanel])

  /**
   * 首屏自持加载：app.js 的 showPage 在本脚本加载前就执行过（那时 window.wbKeysPanel
   * 还不存在，切页那次调用落空），用户上次若停在本页，这里补一次 —— 与旧实现文件
   * 末尾的 `if (wbApp.currentPage === 'keys') load()` 等价。
   */
  React.useEffect(() => {
    if (shared().wbApp?.currentPage === 'keys') void loadPanel()
  }, [loadPanel])

  /** 顶栏那枚是本页徽标的镜像（app.js 的 renderTopbarStatus 按 id 读文案与 data-tone）：
   *  数据一变就让它跟上，否则要等下一次主状态轮询（20 秒）才同步 */
  React.useEffect(() => {
    shared().wbApp?.renderTopbarStatus?.()
  }, [data])

  /* ─── 渲染 ─────────────────────────────── */

  const keys = keysOf(data)
  const labelOfChannel = (id: string): string => {
    const option = providersOf(data).find(item => item.id.toLowerCase() === id.toLowerCase())
    return option ? channelLabel(option) : channelLabel({ id, removed: true })
  }
  /** 客户端分页（通用表格外壳）：Key 通常只有几把，但口径与其它五张表保持一致 */
  const filtered = filterKeys(keys, search, status)
  const paging = useClientPaging(filtered.length, 'keys')
  const list = paging.paged ? paging.slice(filtered) : filtered
  const columns = visibleColumns()
  const enabledCount = data?.usableKeyCount ?? keys.filter(item => item.enabled !== false).length
  const hasUsableKey = enabledCount > 0
  const badgeText = hasUsableKey
    ? t('已启用鉴权 · {n} 把 Key 生效', { n: enabledCount })
    : t('没有可用的 API Key，请先在「网关 Key」页创建并启用')

  /** 一个单元格的内容（不含 <td> 外壳）；「某一列长什么样」只有这一处实现 */
  function cell(columnKey: string, k: KeyEntry, busyRow: boolean): React.ReactNode {
    switch (columnKey) {
      case 'name':
        return (
          <>
            <div className='mid'><span className='t'>{k.name || t('未命名')}</span></div>
            <div className='mname' title={restrictionTitle(k, labelOfChannel)}>{restrictionText(k, labelOfChannel)}</div>
          </>
        )
      case 'key': {
        return (
          <div className='keycell'>
            <code className='kv'>{k.masked || '••••••••'}</code>
            <Button size='sm' variant='ghost' onClick={() => setModal({ mode: 'view', key: k })}>
              {t('查看')}
            </Button>
            {/* data-copy 是 clipboard.js 的委托钩子 */}
            <Button size='sm' variant='ghost' data-copy={k.key} title={t('复制 Key')}>{t('复制')}</Button>
          </div>
        )
      }
      case 'time':
        return (
          <span className='muted'>{k.createdAt ? shared().wbApp?.formatTime?.(k.createdAt) : '—'}</span>
        )
      case 'state':
        return (
          <div className='inline-flex items-center gap-2'><Switch checked={k.enabled !== false} disabled={busyRow}
            aria-label={t('启用「{name}」', { name: k.name || t('未命名') })}
            onCheckedChange={next => toggleEnabled(k, next)} />
            <span className='text-xs'>{k.enabled !== false ? t('已启用') : t('已停用')}</span></div>
        )
      case 'act':
        return (
          <div className='row-actions'>
            <Button size='sm' variant='ghost' disabled={busyRow} onClick={() => setModal({ mode: 'edit', key: k })}>{t('编辑')}</Button>
            <Button size='sm' variant='ghost' disabled={busyRow} onClick={() => setModal({ mode: 'scope', key: k })}>
              {t('可用范围')}
            </Button>
            <Button size='sm' variant='destructive' disabled={busyRow}
              onClick={() => void removeKey(k)}>
              {t('删除')}
            </Button>
          </div>
        )
      default:
        return null
    }
  }

  return (
    <Card render={<section />} className='panel'>
      <CardHeader className='panel-head'>
        <h2>{t('API Key 列表')}</h2>
        {/* id 与 data-tone 保留：app.js 的 renderTopbarStatus 按 id 镜像这枚徽标的文案
            与配色（data-tone 有值走它，不去拆组件库 Badge 那串 Tailwind 类名） */}
        <Badge id='keys-status' variant={hasUsableKey ? 'success' : 'warning'}
          data-tone={hasUsableKey ? 'ok' : 'warn'}>
          {badgeText}
        </Badge>
        <div className='head-actions'>
          {/* 列设置的触发按钮由 wbColSettings.register 插进这个容器的最前面（命令式，
              与模型管理页同一手法：插入位置由那边决定，本岛只留容器） */}
          <Button variant='default' onClick={() => setModal({ mode: 'create' })}>
            {t('＋ 新建 Key')}
          </Button>
        </div>
      </CardHeader>

      <div className='flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3'>
        <Input aria-label={t('搜索 Key')} placeholder={t('搜索 Key 名称…')} value={search} className='w-full sm:w-[260px]'
          onChange={event => { setSearch(event.target.value); paging.goto(1) }} />
        <Select value={status} onValueChange={value => { setStatus(value || 'all'); paging.goto(1) }} items={{ all: t('全部状态'), enabled: t('已启用'), disabled: t('已停用') }}>
          <SelectTrigger aria-label={t('Key 状态')} className='w-[130px]'><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value='all'>{t('全部状态')}</SelectItem><SelectItem value='enabled'>{t('已启用')}</SelectItem><SelectItem value='disabled'>{t('已停用')}</SelectItem></SelectContent>
        </Select>
        {(search || status !== 'all') && <Button variant='ghost' onClick={() => { setSearch(''); setStatus('all'); paging.goto(1) }}>{t('重置筛选')}</Button>}
      </div>

      <div className='models-table-wrap'>
        <Table container={false} className='models-table keys-table'>
          {/* colgroup / thead 由本文件渲染，但 data-col 一个不少：列设置的就地重排
              （syncStaticHead）与列宽层（table-columns.js）都按它定位列 */}
          <colgroup>
            <col className='k-name' data-col='name' />
            <col className='k-key' data-col='key' />
            <col className='k-time' data-col='time' />
            <col className='k-state' data-col='state' />
            <col className='k-act' data-col='act' />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead data-col='name'>{t('名称')}</TableHead>
              {/* 「Key」是产品固定叫法（无中文），不进词典 */}
              <TableHead data-col='key'>Key</TableHead>
              <TableHead data-col='time'>{t('创建时间')}</TableHead>
              <TableHead data-col='state'>{t('状态')}</TableHead>
              <TableHead className='r' data-col='act'>{t('操作')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.length ? list.map(k => {
              const busyRow = pending.has(k.id)
              return (
                <TableRow key={k.id} className={k.enabled !== false ? '' : 'off'} data-id={k.id}>
                  {columns.map(column => (
                    <TableCell key={column.key} className={`${CELL_CLASS[column.key] ?? ''} ta-${column.align}`}>
                      {cell(column.key, k, busyRow)}
                    </TableCell>
                  ))}
                </TableRow>
              )
            }) : (
              // 空态的 colspan 跟着可见列数走：写死 5 之后藏起两列，这一格会比表体宽出
              // 两格，把整张表顶出横向滚动
              <TableRow>
                <TableCell colSpan={columns.length} className='empty'>
                  {data ? keys.length ? t('没有匹配的 Key') : t('没有可用的 API Key，请先在「网关 Key」页创建并启用') : t('加载中…')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <TableFooter
        leading={(
          // 行内 <code> / <b> 拆片段保住（与 docs-page 脚注同一手法）；
          // 片段里的空格是 JSX 折行产生的原文空隙，照抄
          <span>
            {t('客户端请求需带 ')}
            <code>{'Authorization: Bearer <key>'}</code>
            {t(' 或 ')}
            <code>{'x-api-key: <key>'}</code>
            {t('；修改后立即生效。模型测试、助手和日活保活必须选择 Key，受限 Key 不能访问管理接口。每把 Key 可单独限制')}
            <b>{t('可用渠道')}</b>
            {t('与')}
            <b>{t('可用模型')}</b>
            {t('（行内「可用范围」）：未选择渠道 = 全部渠道，未选择模型 = 全部已发布模型，两项同时设置时按交集生效。模型来自手动目录；删除渠道不会自动扩大已有 Key 的权限。')}
          </span>
        )}
        total={filtered.length}
        range={paging.paged ? { start: paging.rangeStart, end: paging.rangeEnd } : null}
        page={paging.page}
        pageCount={paging.pageCount}
        size={paging.size}
        onSizeChange={paging.setSize}
        onPageChange={paging.goto}
      />

      {modal?.mode === 'view' && modal.key ? <KeyViewDialog target={modal.key} onClose={() => setModal(null)} /> : modal ? (
        <KeyEditorDialog
          key={`${modal.mode}:${modal.key?.id || 'new'}`}
          mode={modal.mode as 'create' | 'edit' | 'scope'}
          target={modal.key}
          api={shared().workbuddyDesktop}
          providers={providersOf(data)}
          modelsByProvider={modelsByProviderOf(data)}
          onClose={() => setModal(null)}
          onSaved={next => {
            accept(next)
            setModal(next?.created ? { mode: 'view', key: next.created } : null)
            toast(modal.mode === 'create' ? t('✅ Key 已创建，记得复制给客户端') : modal.mode === 'scope' ? t('✅ 可用范围已保存') : t('Key 已更新'))
          }}
        />
      ) : null}
    </Card>
  )
}

/* ─── 挂载：接管 index.html 里既有的页面区块 ─────── */

let mounted = false

/**
 * 把 React root 直接建在页面区块上（不套宿主 div：页面 CSS 用 `.page > *` 这组直接
 * 子选择器分配高度，中间插一层会打断它）。先清掉骨架里的静态子节点 —— 下面按同样的
 * 类名重新渲染，留着会与 React 打架。
 */
function mount(): void {
  if (mounted) return
  const section = document.querySelector<HTMLElement>(SECTION)
  if (!section) return
  mounted = true
  section.replaceChildren()
  createRoot(section).render(<KeysPage />)
}

// 首次切到本页时才挂载（见 island-lazy）：隐藏页不在首屏渲染，也不拉数据。
mountOnPage('keys', SECTION, mount)

declare global {
  interface Window {
    /** 网关 Key 面板（替换 ui/keys-panel.js，接口与原实现一致） */
    wbKeysPanel?: {
      /** 切到本页时拉一次（app.js:151） */
      load(): Promise<void>
      /** 按当前数据重绘（旧实现的能力，保留） */
      render(): void
      /** 当前可见的列（table-columns.js 的列宽层按它算覆盖值与末列把手） */
      visibleColumns(): (ColumnDecl & { align: Align })[]
    }
  }
}

window.wbKeysPanel = { load, render, visibleColumns }
