import type * as React from 'react'
import { Badge, Button, cn } from '@ui'
import { t } from '../i18n'
import { host } from './routing-types'

export function RouteIcon({ name, size = 16 }: { name: string; size?: number }) {
  const html = host().wbIcons?.icon(name, size)
  if (html) return <span className='ico inline-flex shrink-0 items-center justify-center leading-none [&>svg]:block'
    style={{ width: size, height: size }} aria-hidden='true' dangerouslySetInnerHTML={{ __html: html }} />
  const paths: Record<string, string> = {
    route: 'M4 12h5a4 4 0 0 0 4-4V5h7M17 2l3 3-3 3M9 12a4 4 0 0 1 4 4v3h7M17 16l3 3-3 3',
    refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5',
    plus: 'M12 5v14M5 12h14',
    copy: 'M9 5V3h12v14h-3M3 7h12v14H3z',
    lock: 'M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4',
    more: 'M4 12h.01M12 12h.01M20 12h.01',
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    check: 'M5 12l4 4L19 6',
    chevronLeft: 'm15 5-7 7 7 7',
    chevronRight: 'm9 5 7 7-7 7',
  }
  const path = paths[name]
  return path ? <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={name === 'more' ? 3.5 : 1.8} strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'><path d={path} /></svg> : null
}
export function IconButton({ name, title, className, ...props }: {
  name: string; title: string
} & React.ComponentProps<typeof Button>) {
  return <Button variant='ghost' size='icon' className={cn('routing-icon-button', className)}
    title={title} aria-label={title} {...props}><RouteIcon name={name} size={14} /></Button>
}
export function RouteStateBadge({ state, children }: { state: string; children?: React.ReactNode }) {
  const label = state === 'usable' ? t('可用') : state === 'cooldown' ? t('冷却中')
    : state === 'concurrency' ? t('并发已满') : state === 'disabled' ? t('已禁用')
      : state === 'no-credentials' ? t('无凭证') : state === 'limiter' ? t('限制器跳过')
        : state === 'excluded' ? t('未参与') : state === 'tried' ? t('已尝试') : state === 'enabled' ? t('已启用') : state === 'missing' ? t('账号已移除') : t('未就绪')
  return <Badge shape='tag' variant={state === 'usable' ? 'success'
    : state === 'no-credentials' ? 'destructive'
      : state === 'cooldown' || state === 'concurrency' || state === 'limiter' ? 'warning' : 'secondary'}>
    {children || label}
  </Badge>
}
export function ProviderRouteBadge({ rank, effectiveRank, unavailable, disabled, states }: {
  rank?: number
  effectiveRank?: number
  unavailable: boolean
  disabled: boolean
  states: string[]
}) {
  if (unavailable || disabled) return <Badge shape='tag' variant='secondary'>{unavailable ? t('模型绑定不可用') : t('未参与')}</Badge>
  if (rank !== undefined) return <Badge shape='tag' variant={effectiveRank === undefined ? 'secondary' : 'brand'} title={effectiveRank === undefined
    ? t('启用提供商中的第 {rank} 顺位；当前没有可用候选账号。', { rank })
    : t('启用提供商中的第 {rank} 顺位；当前可用候选第 {effective} 顺位。', { rank, effective: effectiveRank })}>{t('第 {n} 顺位', { n: rank })}</Badge>
  if (!states.length) return <Badge shape='tag' variant='secondary'>{t('没有参与路由的账号')}</Badge>
  const state = states[0]
  if (!states.every(value => value === state)) return <Badge shape='tag' variant='secondary'>{t('无可用账号')}</Badge>
  return <RouteStateBadge state={state}>{state === 'disabled' ? t('全部禁用') : undefined}</RouteStateBadge>
}
export function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
}
export function timeText(ts: number): string { return new Date(ts).toLocaleString() }
export function strategyLabel(strategy?: string): string {
  const labels: Record<string, string> = { smart: t('智能选择'), 'least-used': t('最少使用'), pace: t('消耗节奏'), free: t('免费优先'), fast: t('低延迟优先'), weight: t('按权重分配'), manual: t('手动指定') }
  if (strategy && labels[strategy]) return labels[strategy]
  return strategy === 'rotate' || strategy === 'usage' ? t('负载均衡')
    : strategy === 'provider' ? t('家内轮询') : t('顺序优先')
}
export function stickyLabel(sticky?: string): string {
  return sticky === 'strict' ? t('严格绑定') : sticky === 'session' ? t('会话内') : sticky === 'off' ? t('关闭')
    : sticky === 'turn' ? t('每轮') : t('自动')
}
