<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FilesTab from '../components/FilesTab.vue'
import HistoryTab from '../components/HistoryTab.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import AppSidebar from '../components/AppSidebar.vue'
import { isAuthEnabled } from '../lib/features'
import { isAuthAdmin } from '../lib/api'
import { usePublicSettings } from '../lib/publicSettings'

const SIDEBAR_COLLAPSED_KEY = 'yp_sidebar_collapsed_v2'
const HISTORY_REFRESH_EVENT = 'rp:history-refresh'

const router = useRouter()
const route = useRoute()
const tab = ref<'files' | 'history'>('files')
const showSettings = ref(false)
const authEnabled = isAuthEnabled()
const adminEnabled = isAuthAdmin()
const sidebarCollapsed = ref(
  typeof window !== 'undefined' && window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
)
const { refreshPublicSettings } = usePublicSettings()

function toggleSettings() {
  if (!authEnabled) return
  showSettings.value = !showSettings.value
}

function setTab(next: 'files' | 'history') {
  if (!authEnabled && next === 'history') return
  tab.value = next
  showSettings.value = false
  if (next === 'history') window.dispatchEvent(new CustomEvent(HISTORY_REFRESH_EVENT))
  const nextQuery = { ...route.query }
  if (next === 'history') nextQuery.tab = 'history'
  else delete nextQuery.tab
  if (route.query.tab !== nextQuery.tab) {
    void router.replace({ path: '/files', query: nextQuery })
  }
}

// Deep-link support so other views (e.g. the admin sidebar) can navigate
// straight into the History tab via `/files?tab=history` instead of needing
// a dedicated route for what is otherwise client-side tab state.
function syncTabFromQuery() {
  if (authEnabled && route.query.tab === 'history' && tab.value !== 'history') setTab('history')
}

onMounted(() => {
  void refreshPublicSettings()
  syncTabFromQuery()
})

watch(() => route.query.tab, syncTabFromQuery)
</script>

<template>
  <div class="layout" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <AppSidebar
      :active-tab="tab"
      :show-history="authEnabled"
      :show-admin="adminEnabled"
      :show-settings="authEnabled"
      :collapsed="sidebarCollapsed"
      @update:collapsed="sidebarCollapsed = $event"
      @select-files="setTab('files')"
      @select-history="setTab('history')"
      @select-admin="router.push('/admin')"
      @toggle-settings="toggleSettings"
    />

    <main id="main-content" class="workspace">
      <section class="content">
        <FilesTab v-if="tab === 'files'" />
        <HistoryTab v-if="authEnabled && tab === 'history'" />
      </section>
    </main>

    <Transition name="settings-layer">
      <div v-if="showSettings" class="settings-layer" data-testid="settings-layer">
        <div class="overlay" @click="showSettings = false" />
        <SettingsPanel
          @close="showSettings = false"
          @logout="router.push('/login')"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.layout {
  width: 100%;
  min-height: 100dvh;
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  position: relative;
  overflow-x: hidden;
  transition: grid-template-columns 0.18s;
}

.layout.sidebar-collapsed {
  grid-template-columns: var(--sidebar-w-collapsed) minmax(0, 1fr);
}

.workspace {
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 32px 32px 38px;
}

.content {
  flex: 1;
  width: 100%;
  max-width: 1120px;
  margin: 0 auto;
}

.settings-layer {
  z-index: 90;
  pointer-events: none;
  position: fixed;
  inset: 0;
}

.overlay {
  pointer-events: auto;
  z-index: 0;
  position: absolute;
  inset: 0;
}

.settings-layer-enter-active,
.settings-layer-leave-active {
  transition: opacity var(--duration-slow) var(--ease-out);
}

.settings-layer-enter-active :deep(.settings-panel),
.settings-layer-leave-active :deep(.settings-panel) {
  transition: opacity var(--duration-slow) var(--ease-out), transform var(--duration-slow) var(--ease-out);
  will-change: opacity, transform;
}

.settings-layer-enter-from,
.settings-layer-leave-to {
  opacity: 0;
}

.settings-layer-enter-from :deep(.settings-panel),
.settings-layer-leave-to :deep(.settings-panel) {
  opacity: 0;
  transform: translate3d(-10px, 14px, 0) scale(0.98);
}

.settings-layer :deep(.settings-panel) {
  pointer-events: auto;
  z-index: 1;
  position: fixed;
  left: calc(var(--sidebar-w) + 26px);
  right: auto;
  top: auto;
  bottom: 74px;
  width: min(380px, calc(100vw - var(--sidebar-w) - 50px));
  height: auto;
  min-height: 0;
  max-height: calc(100dvh - 92px);
  overflow: auto;
}

.sidebar-collapsed .settings-layer :deep(.settings-panel) {
  left: calc(var(--sidebar-w-collapsed) + 24px);
  width: min(380px, calc(100vw - var(--sidebar-w-collapsed) - 48px));
}

@media (max-width: 600px) {
  .layout,
  .layout.sidebar-collapsed {
    grid-template-columns: 1fr;
  }

  .workspace {
    min-height: 100dvh;
    padding: 18px 12px calc(var(--mobile-bar-space) + 22px);
  }

  .settings-layer :deep(.settings-panel) {
    left: 12px;
    right: 12px;
    top: auto;
    bottom: calc(var(--mobile-bar-space) + 14px);
    width: auto;
    max-height: calc(100dvh - var(--mobile-bar-space) - 30px);
  }
}

@media (min-width: 601px) and (max-width: 960px) {
  .layout {
    grid-template-columns: var(--sidebar-w-tablet) minmax(0, 1fr);
  }

  .layout.sidebar-collapsed {
    grid-template-columns: var(--sidebar-w-collapsed-tablet) minmax(0, 1fr);
  }

  .workspace {
    padding: 18px;
  }

  .settings-layer :deep(.settings-panel) {
    left: calc(var(--sidebar-w-tablet) + 26px);
    width: min(380px, calc(100vw - var(--sidebar-w-tablet) - 50px));
  }
}
</style>
