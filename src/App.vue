<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NotificationStack from './components/NotificationStack.vue'
import { SESSION_INVALIDATED_EVENT } from './lib/api'
import { useNotificationStore } from './stores/notifications'

const route = useRoute()
const router = useRouter()
const notificationStore = useNotificationStore()

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
      <component :is="Component" :key="route.fullPath" />
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

/* Workspace routes retain their navigation. Only their main panel crossfades. */
.layout.page-fade-enter-active,
.layout.page-fade-leave-active {
  opacity: 1;
  transition: none;
}
.layout.page-fade-leave-active {
  position: absolute;
  inset: 0;
  width: 100%;
  pointer-events: none;
}
.layout.page-fade-enter-active .workspace,
.layout.page-fade-leave-active .workspace {
  transition: opacity 250ms var(--ease-out);
}
.layout.page-fade-enter-from .workspace,
.layout.page-fade-leave-to .workspace { opacity: 0; }
</style>
