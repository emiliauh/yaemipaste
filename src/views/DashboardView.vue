<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FilesTab from '../components/FilesTab.vue'
import HistoryTab from '../components/HistoryTab.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import AppSidebar from '../components/AppSidebar.vue'
import { isAuthEnabled } from '../lib/features'
import { isAuthAdmin, isLoggedIn, refreshAuthAdmin } from '../lib/api'
import { usePublicSettings } from '../lib/publicSettings'

const SIDEBAR_COLLAPSED_KEY = 'yp_sidebar_collapsed_v2'
const HISTORY_REFRESH_EVENT = 'rp:history-refresh'

const router = useRouter()
const route = useRoute()
const tab = ref<'files' | 'history'>('files')
const showSettings = ref(false)
const authEnabled = isAuthEnabled()
const showGuestAccess = authEnabled && !isLoggedIn()
const adminEnabled = ref(isAuthAdmin())
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
  const path = next === 'history' ? '/history' : '/files'
  if (route.path !== path) void router.push(path)
}

function syncTabFromRoute() {
  // Normalize the former query-string history URL without keeping it in
  // navigation or shared links.
  if (route.path === '/files' && route.query.tab === 'history') {
    void router.replace('/history')
    return
  }
  const nextTab = authEnabled && route.path === '/history' ? 'history' : 'files'
  if (tab.value !== nextTab) {
    tab.value = nextTab
    showSettings.value = false
    if (nextTab === 'history') window.dispatchEvent(new CustomEvent(HISTORY_REFRESH_EVENT))
  }
}

onMounted(() => {
  void refreshPublicSettings()
  void refreshAuthAdmin().then((isAdmin) => { adminEnabled.value = isAdmin })
  // Let the admin panel code arrive before the administrator navigates there,
  // so the content transition animates the panel rather than its loading shell.
  void import('../views/AdminView.vue')
  syncTabFromRoute()
})

watch(() => route.path, syncTabFromRoute)
</script>

<template>
  <div class="layout" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <AppSidebar
      :active-tab="tab"
      :show-history="authEnabled"
      :show-admin="adminEnabled"
      :show-settings="authEnabled"
      :show-guest-access="showGuestAccess"
      :collapsed="sidebarCollapsed"
      @update:collapsed="sidebarCollapsed = $event"
      @select-files="setTab('files')"
      @select-history="setTab('history')"
      @select-admin="router.push('/admin')"
      @toggle-settings="toggleSettings"
      @login="router.push('/login')"
      @register="router.push('/register')"
    />

    <main id="main-content" class="workspace">
      <section class="content">
        <div class="content-stage">
          <Transition name="workspace-content" appear>
            <FilesTab v-if="tab === 'files'" key="files" />
            <HistoryTab v-else-if="authEnabled" key="history" />
          </Transition>
        </div>
      </section>
    </main>

    <Transition name="settings-layer">
      <div v-if="showSettings" class="settings-layer" data-testid="settings-layer">
        <div class="overlay" @click="showSettings = false" />
        <SettingsPanel
          @close="showSettings = false"
          @login="router.push('/login')"
          @logout="router.push('/login')"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.layout {
  width: 100%;
  height: 100dvh;
  min-height: 100dvh;
  max-height: 100dvh;
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  position: relative;
  overflow: hidden;
  transition: grid-template-columns 0.18s;
}
.content-stage { position: relative; display: grid; }
.content-stage > * { grid-area: 1 / 1; }
.workspace-content-enter-active, .workspace-content-leave-active { transition: opacity 250ms var(--ease-out), transform 250ms var(--ease-out); }
.workspace-content-leave-active { position: absolute; inset: 0; width: 100%; pointer-events: none; }
.workspace-content-enter-from { opacity: 0; transform: translateY(8px); }
.workspace-content-leave-to { opacity: 0; transform: translateY(-4px); }

.layout.sidebar-collapsed {
  grid-template-columns: var(--sidebar-w-collapsed) minmax(0, 1fr);
}

.workspace {
  min-width: 0;
  min-height: 0;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  scrollbar-gutter: stable;
  padding: 32px 32px 38px;
}
.layout :deep(.sidebar) {
  height: 100dvh;
  min-height: 100dvh;
  max-height: 100dvh;
  position: sticky;
  top: 0;
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
  --settings-panel-left: calc(var(--sidebar-w) + 26px);
  --settings-panel-right: auto;
  --settings-panel-top: auto;
  --settings-panel-bottom: 20px;
  --settings-panel-width: min(380px, calc(100vw - var(--sidebar-w) - 50px));
  --settings-panel-max-height: calc(100dvh - 40px);
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
  height: auto;
  min-height: 0;
  overflow: auto;
}

.sidebar-collapsed .settings-layer {
  --settings-panel-left: calc(var(--sidebar-w-collapsed) + 24px);
  --settings-panel-width: min(380px, calc(100vw - var(--sidebar-w-collapsed) - 48px));
}

@media (max-width: 600px) {
  .layout,
  .layout.sidebar-collapsed {
    grid-template-columns: 1fr;
  }

  .workspace {
    padding: 18px 12px calc(var(--mobile-bar-space) + 42px);
  }

  .settings-layer {
    --settings-panel-left: 12px;
    --settings-panel-right: 12px;
    --settings-panel-top: auto;
    --settings-panel-bottom: calc(var(--mobile-bar-space) + 14px);
    --settings-panel-width: auto;
    --settings-panel-max-height: calc(100dvh - var(--mobile-bar-space) - 30px);
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

  .settings-layer {
    --settings-panel-left: calc(var(--sidebar-w-tablet) + 26px);
    --settings-panel-width: min(380px, calc(100vw - var(--sidebar-w-tablet) - 50px));
    --settings-panel-top: auto;
    --settings-panel-bottom: 20px;
    --settings-panel-max-height: calc(100dvh - 40px);
  }
}
</style>
