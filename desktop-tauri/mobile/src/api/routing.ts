import { apiCall } from './client'
import type { RoutingBridge, RoutingGroupsBridge, RoutingWorkspace } from '../../../ui-islands/src/islands/routing-types'

export const routingApi: RoutingGroupsBridge & Pick<RoutingBridge, 'previewRouting'> = {
  getRoutingGroups: () => apiCall('/api/routing/groups'),
  saveRoutingGroup: body => apiCall('/api/routing/groups', { method: 'PUT', body }),
  routingGroupsAction: body => apiCall('/api/routing/groups/actions', { method: 'POST', body }),
  previewRouting: body => apiCall('/api/routing/preview', { method: 'POST', body }),
}
export const fetchRoutingWorkspace = () => apiCall<RoutingWorkspace>('/api/routing/workspace')
