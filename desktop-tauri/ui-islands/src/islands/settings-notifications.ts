import type { NotificationApi, NotificationSettings } from '../../../ui-shared/notification-settings'

function bridge() {
  const desktop = (window as unknown as { workbuddyDesktop?: {
    getNotifications(): Promise<NotificationSettings>
    saveNotifications(patch: unknown): Promise<NotificationSettings>
    testNotification(payload: unknown): Promise<unknown>
  } }).workbuddyDesktop
  if (!desktop) throw new Error('Gateway unavailable')
  return desktop
}

export const notificationApi: NotificationApi = { load: () => bridge().getNotifications(),
  save: patch => bridge().saveNotifications(patch), test: payload => bridge().testNotification(payload) }
