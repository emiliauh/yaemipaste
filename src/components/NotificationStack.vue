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
  left: var(--space-4);
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 1300;
  box-sizing: border-box;
  pointer-events: none;
}
.notification-stack-inner {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-2);
}
.notification-stack-row {
  box-sizing: border-box;
  pointer-events: auto;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--border2);
  border-radius: var(--radius-md);
  background: var(--bg1);
  box-shadow: 0 8px 18px var(--shadow);
  padding: var(--space-2) var(--space-3);
  width: fit-content;
  max-width: 100%;
}
.notification-kind {
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  font-size: var(--fs-xs);
  color: var(--text2);
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
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  max-width: 250px;
  overflow: hidden;
  padding: 0;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out);
}
.notification-message:hover {
  color: var(--text);
}
.notification-message:active {
  transform: scale(0.98);
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
  border-radius: var(--radius-sm);
  font-size: var(--fs-body);
  line-height: 1;
  padding: var(--space-1) var(--space-2);
  transition:
    transform var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}
.notification-dismiss:active {
  transform: scale(0.9);
}

.notify-fade-enter-active,
.notify-fade-leave-active,
.notify-fade-move {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.notify-fade-enter-from,
.notify-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 600px) {
  .notification-stack {
    left: var(--space-3);
    right: var(--space-3);
    bottom: 58px;
  }
  .notification-stack-row {
    grid-template-columns: 1fr;
    justify-items: start;
    width: 100%;
    gap: var(--space-2);
  }
  .notification-stack-row.expanded {
    width: min(320px, 100%);
  }
  .notification-message {
    max-width: 100%;
    min-height: 40px;
    display: flex;
    align-items: center;
  }
  .notification-dismiss {
    justify-self: end;
    min-width: 40px;
    min-height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}
</style>
