<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppSidebar from './AppSidebar.vue'
import SettingsPanel from './SettingsPanel.vue'
import { isAuthEnabled } from '../lib/features'
import { isAuthAdmin, isLoggedIn, refreshAuthAdmin } from '../lib/api'
import { loadAdminData } from '../lib/adminData'
import { usePublicSettings } from '../lib/publicSettings'

const SIDEBAR_COLLAPSED_KEY = 'yp_sidebar_collapsed_v2'

const router = useRouter()
const route = useRoute()
const authEnabled = isAuthEnabled()
const adminEnabled = ref(isAuthAdmin())
const showSettings = ref(false)
const settingsLayer = ref<HTMLElement | null>(null)
const settingsTrigger = ref<HTMLElement | null>(null)
const workspaceRef = ref<HTMLElement | null>(null)
const mobileScrollbarWidth = ref(0)
const sidebarCollapsed = ref(
  typeof window !== 'undefined' && window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
)
const { refreshPublicSettings } = usePublicSettings()

const activeTab = computed<'files' | 'history' | 'admin' | null>(() => {
  if (route.path.startsWith('/admin')) return 'admin'
  if (route.path === '/account-settings') return null
  return authEnabled && route.path === '/history' ? 'history' : 'files'
})
const workspacePageKey = computed(() => route.path.startsWith('/admin') ? 'admin' : route.fullPath)
const showGuestAccess = computed(() => authEnabled && !isLoggedIn())
const mobileNavStyle = computed(() => ({
  '--mobile-scrollbar-compensation': `${mobileScrollbarWidth.value}px`,
}))

let mobileWorkspaceResizeObserver: ResizeObserver | undefined

function prefetchAdminData() {
  void import('../views/AdminView.vue')
  void loadAdminData()
}

if (adminEnabled.value) prefetchAdminData()

function syncMobileScrollbarWidth() {
  const workspace = workspaceRef.value
  if (!workspace) return
  mobileScrollbarWidth.value = Math.max(0, workspace.offsetWidth - workspace.clientWidth)
}

function openSettings() {
  if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
    settingsTrigger.value = document.activeElement
  }
  showSettings.value = true
  void nextTick(() => {
    settingsLayer.value?.querySelector<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    )?.focus()
  })
}

function openAccount() {
  showSettings.value = false
  void router.push('/account-settings')
}

function closeSettings() {
  showSettings.value = false
  void nextTick(() => settingsTrigger.value?.focus())
}

function toggleSettings() {
  if (showSettings.value) closeSettings()
  else openSettings()
}

function handleSettingsKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSettings()
    return
  }
  if (event.key !== 'Tab' || !settingsLayer.value) return

  const focusable = Array.from(settingsLayer.value.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.getAttribute('aria-hidden') !== 'true')
  if (!focusable.length) {
    event.preventDefault()
    settingsLayer.value.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function navigate(path: string) {
  showSettings.value = false
  if (route.path !== path) void router.push(path)
}

watch(() => route.path, () => {
  showSettings.value = false
})

onMounted(() => {
  void refreshPublicSettings()
  void refreshAuthAdmin().then((isAdmin) => {
    adminEnabled.value = isAdmin
    if (isAdmin) prefetchAdminData()
  })
  syncMobileScrollbarWidth()
  window.addEventListener('resize', syncMobileScrollbarWidth)
  if (typeof ResizeObserver !== 'undefined' && workspaceRef.value) {
    mobileWorkspaceResizeObserver = new ResizeObserver(syncMobileScrollbarWidth)
    mobileWorkspaceResizeObserver.observe(workspaceRef.value)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncMobileScrollbarWidth)
  mobileWorkspaceResizeObserver?.disconnect()
})
</script>

<template>
  <div class="layout workspace-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }" :style="mobileNavStyle">
    <AppSidebar
      :active-tab="activeTab"
      :show-history="authEnabled"
      :show-admin="adminEnabled"
      :show-settings="authEnabled"
      :settings-open="showSettings"
      @open-account="openAccount"
      :show-guest-access="showGuestAccess"
      :collapsed="sidebarCollapsed"
      :account-active="route.path === '/account-settings'"
      @update:collapsed="sidebarCollapsed = $event"
      @select-files="navigate('/files')"
      @select-history="navigate('/history')"
      @select-admin="navigate('/admin')"
      @toggle-settings="toggleSettings"
      @login="navigate('/login')"
      @register="navigate('/register')"
    />

    <Transition name="workspace-fade" appear>
      <main ref="workspaceRef" id="main-content" class="workspace">
        <section class="content">
          <Transition name="workspace-content">
            <div :key="workspacePageKey" class="workspace-page">
              <slot />
            </div>
          </Transition>
        </section>
      </main>
    </Transition>

    <Transition name="settings-layer">
      <div
        v-if="showSettings"
        ref="settingsLayer"
        class="settings-layer"
        data-testid="settings-layer"
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        tabindex="-1"
        @keydown="handleSettingsKeydown"
      >
        <div class="overlay" aria-hidden="true" @click="closeSettings" />
        <SettingsPanel
          @close="closeSettings"
          @login="navigate('/login')"
          @register="navigate('/register')"
          @open-account="openAccount"
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
  background: var(--surface);
}
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
  background: var(--surface);
}
.workspace-fade-enter-active {
  transition: opacity 420ms var(--ease-out);
  will-change: opacity;
}
.workspace-fade-enter-from {
  opacity: 0;
}
.workspace-page {
  width: 100%;
  min-width: 0;
}
.layout :deep(.sidebar) {
  height: 100dvh;
  min-height: 100dvh;
  max-height: 100dvh;
  position: sticky;
  top: 0;
}
.content {
  position: relative;
  flex: 1;
  width: 100%;
  max-width: 1120px;
  margin: 0 auto;
}
.workspace-content-enter-active,
.workspace-content-leave-active {
  transition: opacity 320ms var(--ease-out), transform 320ms var(--ease-out);
  will-change: opacity, transform;
}
.workspace-content-leave-active {
  position: absolute;
  inset: 0;
  width: 100%;
  pointer-events: none;
}
.workspace-content-enter-from,
.workspace-content-leave-to {
  opacity: 0;
  transform: translateY(7px);
}
.workspace-content-leave-to {
  transform: translateY(-3px);
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
  transform: translate3d(0, 14px, 0);
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
    scrollbar-gutter: auto;
    padding: 18px var(--mobile-chrome-left) calc(var(--mobile-bar-space) + 42px) var(--mobile-chrome-left);
  }
  .settings-layer {
    --settings-panel-left: calc(var(--mobile-chrome-left) + var(--mobile-nav-inset));
    --settings-panel-right: calc(var(--mobile-chrome-right) + var(--mobile-nav-inset) + var(--mobile-scrollbar-compensation, 0px));
    --settings-panel-top: auto;
    --settings-panel-bottom: calc(var(--mobile-bar-space) + 22px);
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
