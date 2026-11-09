import { modelReasoning } from '../../../ui-shared/models-reasoning'
import { setCustomSourceEnabled } from '../../../ui-shared/custom-source-state'
import { InputGroup, InputGroupInput, InputGroupAddon } from '@ui'
import { useMemo, useRef, useState } from 'react'
import { PageIntro, IconButton, Empty, ErrorNote, SkeletonList } from '../components/ui'
import { ProviderLogo } from '../components/ProviderLogo'
import { Icon } from '../components/Icon'
import { PullIndicator, usePullToRefresh } from '../components/PullToRefresh'
import { store } from '../state/store'
import { providerLabel } from '../lib/providers'
import { fetchManage, refreshModels, setModelEnabled, type ManageModel } from '../api/gateway'
import { usePolling } from '../lib/usePolling'
import { t } from '../i18n'
import { Card, Button } from '@ui'
import { apiCall } from '../api/client'
import { ChannelKeyGroupsDialog, type ChannelRequest } from '../../../ui-islands/src/islands/channel-key-groups'
import { Switch as UiSwitch } from '@ui'
import { Badge as UiBadge } from '@ui'
import { Toggle as UiToggle } from '@ui'

/**
 * 模型管理。
 *
 * ── 折叠分组代替左栏 + 宽表 ──────────────────────────────────
 * 桌面端是「左侧提供商栏 + 右侧宽表」，手机上改成按提供商折叠的卡片：
 * 一行一个模型，只留扫读需要的四个事实 —— 模型 ID、上下文窗口、来源、
 * 是否展示。映射与能力位编辑进抽屉（在桌面端做）。
 *
 * ── 两个开关要分开 ────────────────────────────────────────────
 * 「启用」决定这个模型对客户端是否可用；「可见性」是上游官方客户端是否
 * 展示它 —— 两者在桌面端是两列，手机上用小标签表达，不合并成一个开关。
 */

type Filter = 'all' | 'enabled' | 'hidden'

type CustomSource = {
  id: string; name?: string
  models?: Array<{ id: string; enabled?: boolean; capabilities?: unknown }>
}
const channelRequest: ChannelRequest = (method, path, body) => apiCall(path, { method, body })

export function ModelsPage() {
  const [customProviders, setCustomProviders] = useState<CustomSource[]>([])
  const [editingProvider, setEditingProvider] = useState('')
  const [models, setModels] = useState<ManageModel[] | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState('')
  const revision = useRef(0)
  const [refreshResults, setRefreshResults] = useState<Array<{ provider: string; providerLabel?: string; status: string; message?: string }>>([])

  const load = async () => {
    const current = ++revision.current
    try {
      const [view, custom] = await Promise.all([fetchManage(), apiCall<{ providers: CustomSource[] }>('/api/custom-providers')])
      if (current !== revision.current) return
      setCustomProviders(custom.providers || [])
      setModels([...(view.models || []).filter(model => !String(model.provider).startsWith('custom-')),
        ...(custom.providers || []).flatMap(provider => (provider.models || []).map(model => ({
          ...model, provider: provider.id, providerLabel: provider.name, source: 'custom',
        })))])
      setError('')
    } catch (failure) {
      if (current !== revision.current) return
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  usePolling(load, 120_000)

  const pull = usePullToRefresh({ onRefresh: load })

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (models || []).filter(item => {
      if (filter === 'enabled' && !item.enabled) return false
      if (filter === 'hidden' && item.visibility !== 'hidden') return false
      if (!keyword) return true
      return `${item.id || ''} ${item.providerLabel || ''} ${item.provider || ''}`.toLowerCase().includes(keyword)
    })
  }, [models, filter, query])

  const groups = useMemo(() => {
    const map = new Map<string, ManageModel[]>()
    filtered.forEach(item => {
      const provider = String(item.provider || 'unknown')
      const list = map.get(provider) || []
      list.push(item)
      map.set(provider, list)
    })
    return [...map.entries()].map(([provider, list]) => ({
      provider,
      label: list[0]?.providerLabel,
      list: [...list].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    }))
  }, [filtered])

  const enabledCount = (models || []).filter(item => item.enabled).length
  const hiddenCount = (models || []).filter(item => item.visibility === 'hidden').length

  const toggle = async (model: ManageModel, next: boolean) => {
    if (!model.id || !model.provider || busy) return
    setBusy(`${model.provider}:${model.id}`)
    try {
      if (model.provider.startsWith('custom-')) {
        await setCustomSourceEnabled(channelRequest, model.provider, model.id, next)
        await load()
      } else {
      const view = await setModelEnabled({ id: model.id, provider: model.provider, enabled: next })
      revision.current++
      setModels(previous => [...(view.models || []).filter(item => !String(item.provider).startsWith('custom-')),
        ...(previous || []).filter(item => String(item.provider).startsWith('custom-'))])
      }
      store.toast(next ? t('已启用 {name}', { name: model.id }) : t('已禁用 {name}', { name: model.id }))
    } catch (failure) {
      store.toast(failure instanceof Error ? failure.message : String(failure), 'err')
    } finally {
      setBusy('')
    }
  }

  const refresh = async () => {
    if (busy) return
    setBusy('refresh')
    setRefreshResults([])
    try {
      const result = await refreshModels() as { results?: Array<{ provider: string; providerLabel?: string; status: string; message?: string }> }
      if (!Array.isArray(result?.results) || result.results.length === 0 || result.results.some(item => !item || typeof item.provider !== 'string'
        || !item.provider || !['refreshed', 'failed', 'skipped'].includes(item.status))
        || new Set(result.results.map(item => item.provider)).size !== result.results.length) {
        throw new Error(t('网关未返回逐家模型目录刷新结果'))
      }
      setRefreshResults(result.results)
      await load()
      const done = result.results.filter(item => item.status === 'refreshed').length
      const failed = result.results.filter(item => item.status === 'failed').length
      store.toast(t('{total} 家 · 成功 {done} · 失败 {failed}', { total: result.results.length, done, failed }), failed ? 'err' : done ? 'ok' : 'warn')
    } catch (failure) {
      store.toast(failure instanceof Error ? failure.message : String(failure), 'err')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className='m-page m-fixed' ref={pull.bindRef}>
      <PullIndicator pull={pull.pull} refreshing={pull.refreshing} />
      <div className='m-sticky'>
        <PageIntro actions={<IconButton name='refresh' label={t('刷新清单')} onClick={() => void refresh()} />}
        />

      <div className='m-section' style={{ marginTop: 0 }}>
        <InputGroup>
          <InputGroupInput value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索模型 ID / 提供商')} />
          <InputGroupAddon><Icon name='search' style={{ width: 16, height: 16 }} /></InputGroupAddon>

        </InputGroup>
      </div>

      <div className='m-chips' style={{ padding: '10px 16px 12px' }}>
        <Chip label={t('全部')} count={(models || []).length} on={filter === 'all'} onClick={() => setFilter('all')} />
        <Chip label={t('已启用')} count={enabledCount} on={filter === 'enabled'} onClick={() => setFilter('enabled')} />
        <Chip label={t('不展示')} count={hiddenCount} on={filter === 'hidden'} onClick={() => setFilter('hidden')} />
      </div>
      </div>

      <div className='m-body'>
      <div className='m-section'>
        <p className='mb-2 text-xs text-subtle'>{t('这里只维护上游来源；对外模型 ID 统一在路由组中配置。')}</p>
        <Button variant='outline' onClick={() => store.push('routing')}>{t('管理路由组')}</Button>
      </div>
      {error ? <ErrorNote text={error} /> : null}
      {refreshResults.length ? <div className='m-section'><Card className='m-card m-card-pad'>
        <div className='text-xs font-medium'>{t('模型目录刷新结果')}</div>
        {refreshResults.map(item => <p key={item.provider} className='mt-2 text-xs text-subtle'>
          {providerLabel(item.provider, item.providerLabel)} · {item.status === 'refreshed' ? t('已刷新')
            : item.status === 'failed' ? t('失败') : t('跳过')}
          {item.message ? ` · ${t(item.message)}` : ''}
        </p>)}
      </Card></div> : null}

      {!models ? <SkeletonList rows={4} height={70} /> : null}

      {models && !groups.length ? (
        <div className='m-section'>
          <Card className='m-card'>
            <Empty text={t('没有匹配的模型')} />
          </Card>
        </div>
      ) : null}

      {customProviders.filter(provider => !provider.models?.length).map(provider => <div className='m-section' key={provider.id}>
        <Card className='m-card m-card-pad'><p className='mb-2 text-sm'>{provider.name || provider.id}</p>
          <Button size='sm' variant='outline' onClick={() => setEditingProvider(provider.id)}>{t('获取模型')}</Button>
        </Card>
      </div>)}
      {groups.map(group => {
        const isCollapsed = collapsed.has(group.provider)
        return (
          <div key={group.provider} data-model-provider={group.provider} className='m-section' style={{ marginTop: 12 }}>
            <Button size='default' variant='ghost'
              type='button'
              onClick={() => {
                const next = new Set(collapsed)
                if (isCollapsed) next.delete(group.provider)
                else next.add(group.provider)
                setCollapsed(next)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                width: '100%',
                padding: '0 3px 8px',
                background: 'none',
                border: 0,
                textAlign: 'left',
              }}
            >
              <ProviderLogo id={group.provider} label={group.label} />
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{providerLabel(group.provider, group.label)}</span>
              <span style={{ fontSize: 11, color: 'var(--m-text-3)' }}>{t('{n} 个模型', { n: group.list.length })}</span>
              <Icon
                name='chev'
                style={{
                  width: 15,
                  height: 15,
                  color: 'var(--m-text-3)',
                  transform: isCollapsed ? 'none' : 'rotate(90deg)',
                  transition: 'transform .16s',
                }}
              />
            </Button>
            {isCollapsed ? null : (
              <Card className='m-card'>
                {group.list.map(model => {
                  const key = `${model.provider}:${model.id}`
                  const hidden = model.visibility === 'hidden'
                  const caps = readCaps(model.capabilities)
                  const reasoningInfo = modelReasoning(model)
                  return (
                    <div
                      key={key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '11px 13px',
                        borderBottom: '1px solid var(--m-line)',
                        opacity: model.enabled ? 1 : 0.55,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          className='m-mono'
                          style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {model.id}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 4, fontSize: 10.5, color: 'var(--m-text-3)', flexWrap: 'wrap' }}>
                          {model.kind === 'image' ? <UiBadge variant='secondary' shape='tag' className='m-pill'>{t('图片生成')}</UiBadge> : null}
                          {model.supports_image_editing ? <UiBadge variant='secondary' shape='tag' className='m-pill'>{t('图片编辑')}</UiBadge> : null}
                          {model.upstreamStatus === 'undeployed' ? (
                            <UiBadge variant='warning' shape='tag'
                              title={t('上游目录列出了这个模型，但推理端尚未识别；保留在清单中，后续探测成功后自动清除标记')}>
                              {t('上游未部署')}
                            </UiBadge>
                          ) : null}
                          {caps.context ? <UiBadge variant='secondary' shape='tag' className='m-pill'>{caps.context}</UiBadge> : null}
                          <UiBadge variant='secondary' shape='tag' className='m-pill'>{sourceLabel(model.source)}</UiBadge>
                          {hidden ? (
                            <UiBadge variant='secondary' shape='tag' className='m-pill' style={{ color: 'var(--m-warn)' }}>
                              {t('不展示')}
                            </UiBadge>
                          ) : null}
                          {caps.reasoning ? (
                            <UiBadge variant='secondary' shape='tag' className='m-pill' style={{ color: 'var(--m-primary)' }}>
                              {t('思考')}
                            </UiBadge>
                          ) : null}
                        </div>
                        {reasoningInfo.fixedLevel ? (
                          <p className='mt-1 text-[10.5px] text-subtle'>{t('固定思考档位：{level}', { level: reasoningInfo.fixedLevel })}</p>
                        ) : reasoningInfo.levels.length ? (
                          <p className='mt-1 text-[10.5px] text-subtle'>
                            {reasoningInfo.source === 'modelsdev' ? t('社区参考档位：{levels}', { levels: reasoningInfo.levels.join(' / ') })
                              : t('上游可用档位：{levels}', { levels: reasoningInfo.levels.join(' / ') })}
                            {reasoningInfo.defaultLevel ? ` · ${t('默认档位：{level}', { level: reasoningInfo.defaultLevel })}` : ''}
                          </p>
                        ) : reasoningInfo.bindingSupported === false ? (
                          <p className='mt-1 text-[10.5px] text-subtle'>{t('上游未声明思考档位')}</p>
                        ) : null}
                      </div>
                      <div className='flex shrink-0 flex-col items-end gap-2'>
                        <SwitchSmall
                        checked={model.enabled !== false} disabled={Boolean(busy)}
                        label={t('启用上游模型 {model}', { model: String(model.id) })}
                        onChange={next => void toggle(model, next)} />
                        {group.provider.startsWith('custom-') ? <Button size='sm' variant='outline'
                          onClick={() => setEditingProvider(group.provider)}>{t('选择模型')}</Button> : null}
                      </div>
                    </div>
                  )
                })}
              </Card>
            )}
          </div>
        )
      })}

      <div className='m-section' style={{ paddingBottom: 8 }}>
        <Card className='m-card m-card-pad' style={{ fontSize: 11.5, color: 'var(--m-text-3)', lineHeight: 1.7 }}>
          {t('上游模型测试与能力设置可在桌面端「模型管理」中操作。')}
        </Card>
      </div>
      </div>
      {editingProvider ? <ChannelKeyGroupsDialog providerId={editingProvider} request={channelRequest}
        onSaved={load} onClose={() => setEditingProvider('')} /> : null}
    </div>
  )
}

function Chip({ label, count, on, onClick }: { label: string; count: number; on: boolean; onClick: () => void }) {
  return (
    <UiToggle size='default' variant='outline' type='button' className='m-chip rounded-pill' pressed={on} onClick={onClick}>
      {label}
      <span className='m-n'>{count}</span>
    </UiToggle>
  )
}

function SwitchSmall({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <UiSwitch size='touch' variant='success' checked={checked} aria-label={label} disabled={disabled} onCheckedChange={onChange} />
  )
}

function sourceLabel(source?: string): string {
  if (source === 'remote') return t('远程')
  if (source === 'builtin') return t('内置')
  if (source === 'manual') return t('手动')
  return t('自定义')
}

/** 从能力位里读两件手机上值得显示的事实（上下文窗口 / 是否支持思考） */
function readCaps(capabilities: unknown): { context?: string; reasoning?: boolean } {
  if (!capabilities || typeof capabilities !== 'object') return {}
  const caps = capabilities as Record<string, unknown>
  const input = caps.maxInputTokens ?? caps.contextWindow ?? caps.maxContextTokens
  const reasoning = Boolean(caps.reasoning || caps.reasoningLevels || caps.supportsReasoning)
  return {
    context: typeof input === 'number' && input > 0 ? formatWindow(input) : undefined,
    reasoning,
  }
}

function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}
