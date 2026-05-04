<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import FilesTab from '../components/FilesTab.vue'
import HistoryTab from '../components/HistoryTab.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import { useTheme, type ThemeMode } from '../lib/theme'
import { isAuthEnabled } from '../lib/features'

const router = useRouter()
const tab = ref<'files' | 'history'>('files')
const showSettings = ref(false)
const SIDEBAR_STATE_KEY = 'yp_sidebar_collapsed'
const sidebarCollapsed = ref(
  typeof window !== 'undefined' && window.localStorage.getItem(SIDEBAR_STATE_KEY) === '1',
)
const authEnabled = isAuthEnabled()
const HISTORY_REFRESH_EVENT = 'rp:history-refresh'
const { themeMode, appliedTheme, setThemeMode } = useTheme()
const themeOptions: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: 'Auto' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
]
const navItems = computed<Array<{ id: 'files' | 'history'; label: string; description: string; icon: 'upload' | 'history' }>>(() => {
  const items: Array<{ id: 'files' | 'history'; label: string; description: string; icon: 'upload' | 'history' }> = [
    { id: 'files', label: 'Files', description: 'Upload and share', icon: 'upload' },
  ]
  if (authEnabled) items.push({ id: 'history', label: 'History', description: 'Manage pastes', icon: 'history' })
  return items
})
const themeLabel = computed(() => {
  if (themeMode.value === 'system') return `System theme, currently ${appliedTheme.value}`
  return `${themeMode.value} theme`
})

function toggleSettings() {
  if (!authEnabled) return
  showSettings.value = !showSettings.value
}

function setTab(next: 'files' | 'history') {
  if (!authEnabled && next === 'history') return
  tab.value = next
  showSettings.value = false
  if (next === 'history') window.dispatchEvent(new CustomEvent(HISTORY_REFRESH_EVENT))
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(SIDEBAR_STATE_KEY, sidebarCollapsed.value ? '1' : '0')
  }
}

function toggleCompactTheme() {
  setThemeMode(appliedTheme.value === 'dark' ? 'light' : 'dark')
}
</script>

<template>
  <div class="layout" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <aside class="sidebar" aria-label="Workspace navigation">
      <div class="sidebar-top">
        <button
          type="button"
          class="brand-block"
          :aria-label="sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'"
          :aria-expanded="!sidebarCollapsed"
          data-testid="sidebar-brand-toggle"
          @click="toggleSidebar"
        >
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <path d="M8 9.5h16"/>
              <path d="M8 16h16"/>
              <path d="M8 22.5h10"/>
            </svg>
          </span>
          <div>
            <div class="brand-title">yaemipaste</div>
          </div>
        </button>
      </div>

      <nav class="nav-stack" aria-label="Primary">
        <div class="nav-section-label">Workspace</div>
        <button
          v-for="item in navItems"
          :key="item.id"
          type="button"
          :class="{ active: tab === item.id }"
          :aria-label="item.label"
          :aria-current="tab === item.id ? 'page' : undefined"
          :data-testid="`desktop-nav-${item.id}`"
          @click="setTab(item.id)"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg v-if="item.icon === 'upload'" viewBox="0 0 24 24">
              <path d="M12 16V4"/>
              <path d="m7 9 5-5 5 5"/>
              <path d="M5 20h14"/>
            </svg>
            <svg v-else viewBox="0 0 24 24">
              <path d="M3 12a9 9 0 1 0 3-6.7"/>
              <path d="M3 4v5h5"/>
              <path d="M12 7v5l3 2"/>
            </svg>
          </span>
          <span class="nav-copy">
            <span>{{ item.label }}</span>
            <small>{{ item.description }}</small>
          </span>
        </button>
      </nav>

      <div class="sidebar-footer">
        <div class="expanded-utilities">
          <div class="utility-label">Theme</div>
          <div class="theme-switch" role="group" :aria-label="themeLabel" data-testid="theme-switch">
            <button
              v-for="option in themeOptions"
              :key="option.mode"
              type="button"
              :class="{ active: themeMode === option.mode }"
              :aria-pressed="themeMode === option.mode"
              :data-testid="`theme-${option.mode}`"
              @click="setThemeMode(option.mode)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div class="collapsed-utilities" aria-label="Compact utilities">
          <button
            type="button"
            class="compact-icon-btn"
            :aria-label="`Switch to ${appliedTheme === 'dark' ? 'light' : 'dark'} theme`"
            data-testid="collapsed-theme-toggle"
            @click="toggleCompactTheme"
          >
            <svg v-if="appliedTheme === 'dark'" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4"/>
              <path d="M12 2v2"/>
              <path d="M12 20v2"/>
              <path d="m4.9 4.9 1.4 1.4"/>
              <path d="m17.7 17.7 1.4 1.4"/>
              <path d="M2 12h2"/>
              <path d="M20 12h2"/>
              <path d="m4.9 19.1 1.4-1.4"/>
              <path d="m17.7 6.3 1.4-1.4"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.5 14.5A7.5 7.5 0 0 1 9.5 3.5 9 9 0 1 0 20.5 14.5Z"/>
            </svg>
          </button>
        </div>
      </div>
    </aside>

    <button
      v-if="authEnabled"
      class="desktop-settings-edge"
      type="button"
      aria-label="Settings"
      data-testid="desktop-settings-edge"
      @click="toggleSettings"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>
      </svg>
      <span>Preferences</span>
    </button>

    <main id="main-content" class="workspace">
      <section class="content">
        <FilesTab v-if="tab === 'files'" />
        <HistoryTab v-if="authEnabled && tab === 'history'" />
      </section>
    </main>

    <nav class="mobile-tabbar" aria-label="Primary mobile">
      <div class="mobile-tabbar-main">
        <button
          v-for="item in navItems"
          :key="item.id"
          type="button"
          :class="{ active: tab === item.id }"
          :aria-current="tab === item.id ? 'page' : undefined"
          :data-testid="`mobile-nav-${item.id}`"
          @click="setTab(item.id)"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg v-if="item.icon === 'upload'" viewBox="0 0 24 24">
              <path d="M12 16V4"/>
              <path d="m7 9 5-5 5 5"/>
              <path d="M5 20h14"/>
            </svg>
            <svg v-else viewBox="0 0 24 24">
              <path d="M3 12a9 9 0 1 0 3-6.7"/>
              <path d="M3 4v5h5"/>
              <path d="M12 7v5l3 2"/>
            </svg>
          </span>
          <span>{{ item.label }}</span>
        </button>
      </div>
      <button
        v-if="authEnabled"
        class="mobile-tabbar-settings"
        type="button"
        aria-label="Settings"
        data-testid="mobile-nav-settings"
        @click="toggleSettings"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>
        </svg>
      </button>
    </nav>

    <Transition name="settings-fade">
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
  min-height: 100vh;
  display: grid;
  grid-template-columns: 228px minmax(0, 1fr);
  position: relative;
  width: 100%;
  transition: grid-template-columns 0.18s ease;
}
.layout.sidebar-collapsed {
  grid-template-columns: 70px minmax(0, 1fr);
}
.sidebar {
  position: sticky;
  top: 0;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 22px 14px;
  border-right: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  background: color-mix(in srgb, var(--surface) 98%, var(--accent-soft));
  overflow: hidden;
  box-shadow: 1px 0 0 color-mix(in srgb, var(--text) 4%, transparent) inset;
}
.sidebar-top {
  display: grid;
  gap: 14px;
}
.brand-block {
  appearance: none;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  text-align: left;
}
.brand-block:hover {
  background: color-mix(in srgb, var(--surface2) 74%, transparent);
  border-color: transparent;
}
.brand-mark {
  width: 38px;
  height: 38px;
  border: 1px solid var(--border);
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--surface2);
  color: var(--text);
}
.brand-mark svg {
  width: 19px;
  height: 19px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
}
.brand-title {
  color: var(--text);
  font-family: var(--font);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.2;
}
.sidebar-collapsed .sidebar {
  padding-inline: 12px;
  align-items: center;
}
.sidebar-collapsed .brand-block {
  width: 44px;
  justify-content: center;
  padding: 4px;
}
.sidebar-collapsed .brand-title,
.sidebar-collapsed .nav-section-label,
.sidebar-collapsed .nav-copy,
.sidebar-collapsed .expanded-utilities {
  display: none;
}
.sidebar-collapsed .nav-stack {
  width: 44px;
}
.sidebar-collapsed .sidebar-footer {
  width: 40px;
}
.sidebar-collapsed .nav-stack button {
  width: 44px;
  min-height: 44px;
  justify-content: center;
  padding: 8px;
}
.nav-section-label,
.utility-label {
  color: var(--text3);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: lowercase;
  font-weight: 600;
}
.nav-stack {
  display: grid;
  gap: 6px;
}
.nav-section-label {
  padding: 0 4px 2px;
}
.nav-stack button {
  width: 100%;
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text2);
  text-align: left;
  padding: 8px 9px;
  border-radius: 12px;
}
.nav-stack button:hover {
  background: color-mix(in srgb, var(--surface2) 74%, transparent);
  border-color: transparent;
  color: var(--text);
}
.nav-stack button.active {
  background: color-mix(in srgb, var(--surface2) 86%, var(--accent-soft));
  border-color: color-mix(in srgb, var(--border2) 88%, var(--accent));
  color: var(--text);
  box-shadow: none;
}
.nav-icon {
  width: 29px;
  height: 29px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text2);
  flex: 0 0 auto;
}
.nav-stack button.active .nav-icon {
  border-color: color-mix(in srgb, var(--accent) 44%, var(--border));
  color: var(--accent);
  background: var(--accent-soft);
}
.nav-icon svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.nav-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
  line-height: 1.15;
}
.nav-copy small {
  color: var(--text3);
  font-family: var(--font);
  font-size: 10px;
  font-weight: 400;
}
.sidebar-footer {
  margin-top: auto;
  display: grid;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.expanded-utilities {
  display: grid;
  gap: 10px;
}
.collapsed-utilities {
  display: none;
  gap: 8px;
}
.sidebar-collapsed .collapsed-utilities {
  display: grid;
  justify-items: center;
}
.theme-switch {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
  padding: 3px;
  gap: 3px;
}
.theme-switch button {
  flex: 1;
  border-radius: 9px;
  background: transparent;
  color: var(--text2);
  padding: 6px 8px;
  font-size: 11px;
  min-height: 31px;
}
.theme-switch button.active {
  background: color-mix(in srgb, var(--surface3) 82%, var(--accent-soft));
  color: var(--text);
}
.theme-switch button:hover:not(.active) {
  background: var(--bg1);
  color: var(--text);
}
.compact-icon-btn {
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--surface2);
  color: var(--text2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.compact-icon-btn:hover {
  border-color: var(--border2);
  background: var(--surface3);
  color: var(--text);
}
.compact-icon-btn svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.mobile-tabbar {
  display: none;
}
.desktop-settings-edge {
  position: fixed;
  left: 238px;
  bottom: 18px;
  z-index: 80;
  min-height: 42px;
  max-width: 170px;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: color-mix(in srgb, var(--surface2) 88%, transparent);
  color: var(--text2);
  font-family: var(--font);
  font-size: 11px;
  font-weight: 600;
  box-shadow: 0 12px 26px color-mix(in srgb, var(--shadow) 24%, transparent);
  transition: left 0.18s ease, border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.desktop-settings-edge:hover {
  border-color: var(--border2);
  background: var(--surface3);
  color: var(--text);
}
.desktop-settings-edge svg {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sidebar-collapsed .desktop-settings-edge {
  left: 80px;
  bottom: 22px;
  width: 40px;
  min-height: 40px;
  padding: 0;
  justify-content: center;
}
.sidebar-collapsed .desktop-settings-edge span {
  display: none;
}
.workspace {
  min-width: 0;
  padding: 32px 32px 38px;
  display: flex;
  flex-direction: column;
}
.content {
  flex: 1;
  max-width: 1120px;
  width: 100%;
  margin: 0 auto;
}
.settings-layer {
  position: fixed;
  inset: 0;
  z-index: 90;
  pointer-events: none;
}
.overlay {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  z-index: 0;
}
.settings-layer :deep(.settings-panel) {
  pointer-events: auto;
  z-index: 1;
}
.sidebar-collapsed .settings-layer :deep(.settings-panel) {
  left: 80px;
}
.settings-layer :deep(.passkey-backdrop) {
  pointer-events: auto;
  z-index: 130;
}
.settings-fade-enter-active,
.settings-fade-leave-active {
  transition: opacity 0.18s ease;
}
.settings-fade-enter-active :deep(.settings-panel),
.settings-fade-leave-active :deep(.settings-panel) {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.settings-fade-enter-from,
.settings-fade-leave-to {
  opacity: 0;
}
.settings-fade-enter-from :deep(.settings-panel),
.settings-fade-leave-to :deep(.settings-panel) {
  opacity: 0;
  transform: translateY(-6px) scale(0.985);
}
.settings-fade-enter-to :deep(.settings-panel),
.settings-fade-leave-from :deep(.settings-panel) {
  opacity: 1;
  transform: translateY(0) scale(1);
}

@media (max-width: 600px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .layout.sidebar-collapsed {
    grid-template-columns: 1fr;
  }
  .sidebar {
    display: none;
  }
  .desktop-settings-edge {
    display: none;
  }
  .mobile-tabbar {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 110;
    display: flex;
    align-items: stretch;
    gap: 10px;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
  }
  .mobile-tabbar-main {
    flex: 1 1 auto;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    box-shadow: 0 18px 36px var(--shadow);
    backdrop-filter: blur(16px);
  }
  .mobile-tabbar-main button,
  .mobile-tabbar-settings {
    min-height: 46px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 10px;
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    touch-action: manipulation;
  }
  .mobile-tabbar-main button.active {
    background: var(--surface2);
    border-color: var(--border);
    color: var(--text);
  }
  .mobile-tabbar-main .nav-icon {
    width: 22px;
    height: 22px;
    border: 0;
    background: transparent;
  }
  .mobile-tabbar-main .nav-icon svg {
    width: 17px;
    height: 17px;
  }
  .mobile-tabbar-settings {
    flex: 0 0 52px;
    width: 52px;
    padding: 0;
    border-color: var(--border);
    border-radius: 14px;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    box-shadow: 0 18px 36px var(--shadow);
    backdrop-filter: blur(16px);
  }
  .mobile-tabbar-settings:hover {
    background: var(--surface2);
    border-color: var(--border2);
    color: var(--text);
  }
  .mobile-tabbar-settings svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .workspace {
    padding: 18px 12px 104px;
  }
  .theme-switch button {
    min-height: 34px;
    padding: 5px 7px;
    font-size: 10px;
  }
}

@media (min-width: 601px) and (max-width: 960px) {
  .layout {
    grid-template-columns: 208px minmax(0, 1fr);
  }
  .layout.sidebar-collapsed {
    grid-template-columns: 70px minmax(0, 1fr);
  }
  .workspace {
    padding: 18px;
  }
  .desktop-settings-edge {
    left: 218px;
  }
  .settings-layer :deep(.settings-panel) {
    left: 236px;
    width: min(340px, calc(100vw - 260px));
  }
  .sidebar-collapsed .desktop-settings-edge {
    left: 80px;
  }
  .sidebar-collapsed .settings-layer :deep(.settings-panel) {
    left: 80px;
    width: min(340px, calc(100vw - 104px));
  }
}
</style>
