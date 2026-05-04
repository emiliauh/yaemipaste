<script setup lang="ts">
import { ref } from 'vue'
import { useNotificationStore } from '../stores/notifications'

const notificationStore = useNotificationStore()
const expandedIds = ref(new Set<number>())

function isExpanded(id: number) {
  return expandedIds.value.has(id)
}

function toggleExpanded(id: number) {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}

function dismiss(id: number) {
  const next = new Set(expandedIds.value)
  next.delete(id)
  expandedIds.value = next
  notificationStore.dismiss(id)
}
</script>

<template>
  <div class="notification-stack" data-testid="notification-list">
    <TransitionGroup name="notify-fade" tag="div" class="notification-stack-inner">
      <div
        v-for="notification in notificationStore.notifications"
        :key="notification.id"
        class="notification-stack-row"
        :class="{ expanded: isExpanded(notification.id) }"
        data-testid="notification-row"
      >
        <span class="notification-kind" :class="notification.type">{{ notification.type === 'error' ? 'Error' : 'Success' }}</span>
        <button
          class="notification-message"
          type="button"
          :aria-expanded="isExpanded(notification.id)"
          data-testid="notification-toggle"
          @click="toggleExpanded(notification.id)"
        >
          {{ notification.msg }}
        </button>
        <button class="btn-ghost notification-dismiss" type="button" aria-label="Dismiss notification" @click="dismiss(notification.id)">
          ×
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.notification-stack {
  position: fixed;
  left: 16px;
  right: 16px;
  bottom: 16px;
  z-index: 1300;
  box-sizing: border-box;
  pointer-events: none;
}
.notification-stack-inner {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.notification-stack-row {
  box-sizing: border-box;
  pointer-events: auto;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg1);
  box-shadow: 0 8px 18px var(--shadow);
  padding: 8px 10px;
  width: fit-content;
  max-width: 100%;
}
.notification-kind {
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  padding: 2px 6px;
  font-size: 10px;
  color: var(--text3);
}
.notification-kind.success {
  border-color: var(--success-border);
  color: var(--green);
}
.notification-kind.error {
  border-color: var(--error-border);
  color: var(--red-h);
}
.notification-message {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text2);
  font-size: 12px;
  line-height: 1.35;
  max-width: 250px;
  overflow: hidden;
  padding: 0;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notification-stack-row.expanded {
  width: min(320px, 100%);
}
.notification-stack-row.expanded .notification-message {
  max-width: none;
  overflow-wrap: anywhere;
  white-space: normal;
}
.notification-dismiss {
  align-self: start;
  border-radius: 2px;
  font-size: 13px;
  line-height: 1;
  padding: 2px 6px;
}

.notify-fade-enter-active,
.notify-fade-leave-active,
.notify-fade-move {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.notify-fade-enter-from,
.notify-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 600px) {
  .notification-stack {
    left: 10px;
    right: 10px;
    bottom: 128px;
  }
  .notification-stack-row {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .notification-stack-row.expanded {
    width: min(320px, 100%);
  }
  .notification-message {
    max-width: 170px;
  }
  .notification-dismiss {
    justify-self: end;
  }
}
</style>
