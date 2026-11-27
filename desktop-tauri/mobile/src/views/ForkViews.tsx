import { CommonScaffold } from '../ui/components'
import { ProxiesPage } from '../pages/ProxiesPage'
import { RoutingPage } from '../pages/RoutingPage'
import { ModelsPage } from '../pages/ModelsPage'
import { PluginsPage } from '../../../ui-islands/src/islands/plugins-page'
import { CloudSyncPanel } from '../../../ui-islands/src/islands/settings-cloud-sync'
import { ToolsPage } from '../pages/ToolsPage'
import { DocsPage } from '../pages/DocsPage'
import { ReportPage } from '../pages/ReportPage'
import { RequestsPage } from '../pages/RequestsPage'
import { serverIdentity } from '../core/servers'
import { store, useStore, type TabId } from '../core/store'
import type { ReactNode } from 'react'

function ManagementPage({ title, tab, children }: { title: string; tab: TabId; children: ReactNode }) {
  const { navTabs } = useStore()
  return <CommonScaffold title={title} onBack={navTabs.includes(tab) ? undefined : () => store.returnFromSubPage()}>{children}</CommonScaffold>
}

export function ProxiesView() { return <ManagementPage title='网络代理' tab='proxies'><ProxiesPage /></ManagementPage> }
export function RouteGroupsView() { return <RoutingPage /> }
export function UpstreamModelsView() { return <ModelsPage /> }
export function PluginsView() { return <ManagementPage title='插件' tab='plugins'><PluginsPage /></ManagementPage> }
export function CloudSyncView() { return <ManagementPage title='云同步' tab='cloud-sync'><CloudSyncPanel /></ManagementPage> }
export function ToolsView() { return <ManagementPage title='工具服务' tab='tools'><ToolsPage key={serverIdentity()} /></ManagementPage> }
export function DocsView() { return <ManagementPage title='接口文档' tab='docs'><DocsPage key={serverIdentity()} /></ManagementPage> }
export function ReportView() { return <ManagementPage title='报表' tab='report'><ReportPage key={serverIdentity()} /></ManagementPage> }
export function RequestsView() { return <ManagementPage title='请求日志' tab='requests'><RequestsPage key={serverIdentity()} /></ManagementPage> }
