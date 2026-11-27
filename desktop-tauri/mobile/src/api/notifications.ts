import type { NotificationApi } from '../../../ui-shared/notification-settings'
import { apiCall } from './client'

export const notificationApi: NotificationApi = { load: () => apiCall('/api/notifications'),
  save: body => apiCall('/api/notifications', { method: 'PUT', body }),
  test: body => apiCall('/api/notifications/test', { method: 'POST', body }) }
