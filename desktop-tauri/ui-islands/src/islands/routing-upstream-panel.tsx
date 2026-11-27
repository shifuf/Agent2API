import * as React from 'react'
import { Button } from '@ui'
import { t } from '../i18n'
import { callJson } from './assistant-api'
import { RoutingErrorsPanel } from '../../../ui-shared/routing-errors-panel'
import { CompactSpecialPanel, TitleSpecialPanel, VisionSpecialPanel } from './routing-special-panels'
import { useSpecialEditor, type CompactConfig, type CompactView, type TitleConfig, type TitleView, type VisionConfig, type VisionView } from './routing-special-state'
const compact = { load: () => callJson<CompactView>('GET', '/api/models/compact-routes'), save: (body: { config: CompactConfig; revision: string }) => callJson<CompactView>('PUT', '/api/models/compact-routes', body) }
const title = { load: () => callJson<TitleView>('GET', '/api/models/title-routes'), save: (body: { config: TitleConfig; revision: string }) => callJson<TitleView>('PUT', '/api/models/title-routes', body) }
const vision = { load: () => callJson<VisionView>('GET', '/api/vision-compatibility'), save: (body: { config: VisionConfig; revision: string }) => callJson<VisionView>('PUT', '/api/vision-compatibility', body) }
const errors = { load: () => callJson<import('../../../ui-shared/routing-errors-types').ErrorPolicyView>('GET', '/api/routing/errors'), save: (body: Parameters<import('../../../ui-shared/routing-errors-types').ErrorPolicyApi['save']>[0]) => callJson<import('../../../ui-shared/routing-errors-types').ErrorPolicyView>('PUT', '/api/routing/errors', body) }
export function RoutingUpstreamPanel() {
  const [tab, setTab] = React.useState('errors')
  const compactEditor = useSpecialEditor(compact, tab === 'compact')
  const titleEditor = useSpecialEditor(title, tab === 'title')
  const visionEditor = useSpecialEditor(vision, tab === 'vision')
  return <section>
    <div className='flex flex-wrap gap-2'>{[['errors', '错误处理'], ['compact', '压缩上下文'], ['title', '标题生成'], ['vision', '图片兼容']].map(([id, label]) => <Button key={id} variant={tab === id ? 'secondary' : 'ghost'} onClick={() => setTab(id)}>{t(label)}</Button>)}</div>
    {tab === 'errors' ? <RoutingErrorsPanel api={errors} t={t} /> : null}
    {tab === 'compact' ? <CompactSpecialPanel editor={compactEditor} /> : null}
    {tab === 'title' ? <TitleSpecialPanel editor={titleEditor} /> : null}
    {tab === 'vision' ? <VisionSpecialPanel editor={visionEditor} /> : null}
  </section>
}
