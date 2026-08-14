<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NotificationStack from './components/NotificationStack.vue'
import WorkspaceShell from './components/WorkspaceShell.vue'
import { SESSION_INVALIDATED_EVENT } from './lib/api'
import { useNotificationStore } from './stores/notifications'

const route = useRoute()
const router = useRouter()
const notificationStore = useNotificationStore()
const workspaceComponentKey = computed(() => route.path.startsWith('/admin') ? 'admin' : route.fullPath)

function handleSessionInvalidated() {
  notificationStore.push('Your session has ended. Please log in again.', 'error')
  if (route.path !== '/login') void router.push('/login')
}

onMounted(() => window.addEventListener(SESSION_INVALIDATED_EVENT, handleSessionInvalidated))
onBeforeUnmount(() => window.removeEventListener(SESSION_INVALIDATED_EVENT, handleSessionInvalidated))
</script>

<template>
  <router-view v-slot="{ Component }">
    <Transition name="page-fade" mode="out-in">
      <WorkspaceShell v-if="route.meta.workspace" key="workspace">
        <component :is="Component" :key="workspaceComponentKey" />
      </WorkspaceShell>
      <component v-else :is="Component" :key="workspaceComponentKey" />
    </Transition>
  </router-view>
  <NotificationStack />
</template>

<style>
.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity 180ms var(--ease-out);
}

.page-fade-enter-from,
.page-fade-leave-to {
  opacity: 0;
}
</style>
