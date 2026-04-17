import { defineStore } from 'pinia'
import { ref } from 'vue'

export type NotificationType = 'success' | 'error'

export interface AppNotification {
  id: number
  msg: string
  type: NotificationType
}

const MAX_NOTIFICATIONS = 5
const DEFAULT_TIMEOUT_MS = 4000

export const useNotificationStore = defineStore('notifications', () => {
  const notifications = ref<AppNotification[]>([])
  const timers = new Map<number, number>()
  let nextId = 0

  function clearTimer(id: number) {
    const timer = timers.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.delete(id)
    }
  }

  function dismiss(id: number) {
    clearTimer(id)
    notifications.value = notifications.value.filter((notification) => notification.id !== id)
  }

  function push(msg: string, type: NotificationType = 'success', timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = ++nextId
    notifications.value.push({ id, msg, type })
    while (notifications.value.length > MAX_NOTIFICATIONS) {
      const removed = notifications.value.shift()
      if (removed) clearTimer(removed.id)
    }
    const timer = window.setTimeout(() => dismiss(id), timeoutMs)
    timers.set(id, timer)
  }

  function clear() {
    for (const notification of notifications.value) clearTimer(notification.id)
    notifications.value = []
  }

  return { notifications, push, dismiss, clear }
})
