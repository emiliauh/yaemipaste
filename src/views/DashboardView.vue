<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import FilesTab from '../components/FilesTab.vue'
import HistoryTab from '../components/HistoryTab.vue'
import SettingsPanel from '../components/SettingsPanel.vue'
import { useTheme, type ThemeMode } from '../lib/theme'
import { isAuthEnabled } from '../lib/features'
import { isAuthAdmin } from '../lib/api'

const SIDEBAR_COLLAPSED_KEY = 'yp_sidebar_collapsed'
const HISTORY_REFRESH_EVENT = 'rp:history-refresh'

const router = useRouter()
const tab = ref<'files' | 'history'>('files')
const showSettings = ref(false)
const authEnabled = isAuthEnabled()
const adminEnabled = isAuthAdmin()
const sidebarCollapsed = ref(
  typeof window !== 'undefined' && window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
)
const { themeMode, appliedTheme, setThemeMode } = useTheme()
const themeOptions: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: 'Auto' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
]
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
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed.value ? '1' : '0')
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
            <img src="/favicon.svg" alt="" />
          </span>
          <div>
            <div class="brand-title">yaemipaste</div>
          </div>
        </button>
      </div>

      <nav class="nav-stack" aria-label="Primary">
        <div class="nav-section-label">Workspace</div>
        <button
          type="button"
          :class="{ active: tab === 'files' }"
          aria-label="Files"
          :aria-current="tab === 'files' ? 'page' : undefined"
          data-testid="desktop-nav-files"
          @click="setTab('files')"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 16V4" />
              <path d="m7 9 5-5 5 5" />
              <path d="M5 20h14" />
            </svg>
          </span>
          <span class="nav-copy">
            <span>Files</span>
            <small>Upload and share</small>
          </span>
        </button>
        <button
          v-if="authEnabled"
          type="button"
          :class="{ active: tab === 'history' }"
          aria-label="History"
          :aria-current="tab === 'history' ? 'page' : undefined"
          data-testid="desktop-nav-history"
          @click="setTab('history')"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <span class="nav-copy">
            <span>History</span>
            <small>Manage pastes</small>
          </span>
        </button>
      </nav>

      <nav v-if="adminEnabled" class="nav-stack nav-stack-lower" aria-label="Administration">
        <div class="nav-section-label">Admin</div>
        <button
          type="button"
          aria-label="Admin"
          data-testid="desktop-nav-admin"
          @click="router.push('/admin')"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </span>
          <span class="nav-copy">
            <span>Admin</span>
            <small>Control panel</small>
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
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2" />
              <path d="M12 20v2" />
              <path d="m4.9 4.9 1.4 1.4" />
              <path d="m17.7 17.7 1.4 1.4" />
              <path d="M2 12h2" />
              <path d="M20 12h2" />
              <path d="m4.9 19.1 1.4-1.4" />
              <path d="m17.7 6.3 1.4-1.4" />
            </svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.5 14.5A7.5 7.5 0 0 1 9.5 3.5 9 9 0 1 0 20.5 14.5Z" />
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
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
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
          type="button"
          :class="{ active: tab === 'files' }"
          :aria-current="tab === 'files' ? 'page' : undefined"
          data-testid="mobile-nav-files"
          @click="setTab('files')"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 16V4" />
              <path d="m7 9 5-5 5 5" />
              <path d="M5 20h14" />
            </svg>
          </span>
          <span>Files</span>
        </button>
        <button
          v-if="authEnabled"
          type="button"
          :class="{ active: tab === 'history' }"
          :aria-current="tab === 'history' ? 'page' : undefined"
          data-testid="mobile-nav-history"
          @click="setTab('history')"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <span>History</span>
        </button>
        <button
          v-if="adminEnabled"
          type="button"
          data-testid="mobile-nav-admin"
          @click="router.push('/admin')"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </span>
          <span>Admin</span>
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
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
        </svg>
      </button>
    </nav>

    <div v-if="showSettings" class="settings-layer" data-testid="settings-layer">
      <div class="overlay" @click="showSettings = false" />
      <SettingsPanel
        @close="showSettings = false"
        @logout="router.push('/login')"
      />
    </div>
  </div>
</template>

<style scoped>
.layout {
  width: 100%;
  min-height: 100vh;
  display: grid;
  grid-template-columns: 228px minmax(0, 1fr);
  position: relative;
  transition: grid-template-columns 0.18s;
}

.layout.sidebar-collapsed {
  grid-template-columns: 70px minmax(0, 1fr);
}

.sidebar {
  height: 100dvh;
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 22px 14px;
  overflow: hidden;
  border-right: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  background: color-mix(in srgb, var(--surface, var(--bg1)) 98%, var(--accent-soft, var(--bg2)));
  box-shadow: 1px 0 0 color-mix(in srgb, var(--text) 4%, transparent) inset;
}

.sidebar-top {
  display: grid;
  gap: 14px;
}

.brand-block {
  appearance: none;
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px;
  color: var(--text);
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
}

.brand-block:hover {
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 74%, transparent);
  border-color: transparent;
}

.sidebar .brand-mark {
  width: 38px;
  height: 38px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 72%, transparent);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--text) 6%, transparent) inset;
}

.sidebar .brand-mark img {
  width: 22px;
  height: 22px;
  display: block;
}

.brand-title {
  color: var(--text);
  font-family: var(--font);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.2;
}

.sidebar-collapsed .sidebar {
  align-items: center;
  padding-inline: 12px;
}

.sidebar-collapsed .brand-block {
  width: 44px;
  justify-content: center;
  padding: 4px;
  border-radius: 14px;
}

.sidebar-collapsed .sidebar .brand-mark {
  width: 36px;
  height: 36px;
  border-radius: 12px;
}

.sidebar-collapsed .sidebar .brand-mark img {
  width: 21px;
  height: 21px;
}

.sidebar-collapsed .brand-title,
.sidebar-collapsed .nav-section-label,
.sidebar-collapsed .nav-copy,
.sidebar-collapsed .expanded-utilities {
  display: none;
}

.nav-stack {
  display: grid;
  gap: 6px;
}

.nav-stack-lower {
  margin-top: auto;
}

.sidebar-collapsed .nav-stack {
  width: 44px;
}

.nav-section-label,
.utility-label {
  color: var(--text3);
  letter-spacing: 0.04em;
  text-transform: lowercase;
  font-size: 11px;
  font-weight: 600;
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
  padding: 8px 9px;
  color: var(--text2);
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 12px;
}

.nav-stack button:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 74%, transparent);
  border-color: transparent;
}

.nav-stack button.active {
  color: var(--text);
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 86%, var(--accent-soft, var(--bg2)));
  border-color: color-mix(in srgb, var(--border2) 88%, var(--accent));
  box-shadow: none;
}

.sidebar-collapsed .nav-stack button {
  width: 44px;
  min-height: 44px;
  justify-content: center;
  padding: 8px;
}

.sidebar-collapsed .nav-stack button.active {
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 70%, transparent);
  border-color: color-mix(in srgb, var(--accent) 24%, var(--border));
}

.nav-icon {
  width: 29px;
  height: 29px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface, var(--bg1));
}

.nav-stack button.active .nav-icon {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 44%, var(--border));
  background: var(--accent-soft, var(--bg2));
}

.sidebar-collapsed .nav-stack button.active .nav-icon {
  border-color: color-mix(in srgb, var(--accent) 46%, var(--border));
  background: color-mix(in srgb, var(--accent-soft, var(--bg2)) 74%, transparent);
}

.nav-icon svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2px;
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
  display: grid;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  margin-top: auto;
}

.nav-stack-lower + .sidebar-footer {
  margin-top: 0;
}

.sidebar-collapsed .sidebar-footer {
  width: 40px;
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
  gap: 3px;
  padding: 3px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface, var(--bg1));
}

.theme-switch button {
  flex: 1;
  min-height: 31px;
  padding: 6px 8px;
  color: var(--text2);
  font-size: 11px;
  background: transparent;
  border-radius: 9px;
}

.theme-switch button.active {
  color: var(--text);
  background: color-mix(in srgb, var(--surface3, var(--bg3)) 82%, var(--accent-soft, var(--bg2)));
}

.theme-switch button:hover:not(.active) {
  color: var(--text);
  background: var(--bg1);
}

.compact-icon-btn {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--text2);
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--surface2, var(--bg2));
}

.compact-icon-btn:hover {
  color: var(--text);
  border-color: var(--border2);
  background: var(--surface3, var(--bg3));
}

.compact-icon-btn svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.desktop-settings-edge {
  z-index: 80;
  position: fixed;
  bottom: 18px;
  left: 238px;
  max-width: 170px;
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  color: var(--text2);
  font-family: var(--font);
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 88%, transparent);
  box-shadow: 0 12px 26px color-mix(in srgb, var(--shadow) 24%, transparent);
  transition: left 0.18s, border-color 0.15s, background 0.15s, color 0.15s;
}

.desktop-settings-edge:hover {
  color: var(--text);
  border-color: var(--border2);
  background: var(--surface3, var(--bg3));
}

.desktop-settings-edge svg {
  width: 16px;
  height: 16px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.sidebar-collapsed .desktop-settings-edge {
  left: 80px;
  bottom: 22px;
  width: 40px;
  min-height: 40px;
  justify-content: center;
  padding: 0;
}

.sidebar-collapsed .desktop-settings-edge span {
  display: none;
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

.mobile-tabbar {
  display: none;
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

.settings-layer :deep(.settings-panel) {
  pointer-events: auto;
  z-index: 1;
}

.sidebar-collapsed .settings-layer :deep(.settings-panel) {
  left: 80px;
}

@media (max-width: 600px) {
  .layout,
  .layout.sidebar-collapsed {
    grid-template-columns: 1fr;
  }

  .sidebar,
  .desktop-settings-edge {
    display: none;
  }

  .mobile-tabbar {
    z-index: 110;
    position: fixed;
    right: 12px;
    bottom: 12px;
    left: 12px;
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
    min-width: 0;
    flex: auto;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(70px, 1fr));
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: color-mix(in srgb, var(--surface, var(--bg1)) 92%, transparent);
    box-shadow: 0 18px 36px var(--shadow);
    backdrop-filter: blur(16px);
  }

  .mobile-tabbar-main button,
  .mobile-tabbar-settings {
    min-height: 46px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 10px;
    color: var(--text2);
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    touch-action: manipulation;
    background: transparent;
    border: 1px solid transparent;
  }

  .mobile-tabbar-main button.active {
    color: var(--text);
    background: var(--surface2, var(--bg2));
    border-color: var(--border);
  }

  .mobile-tabbar-main .nav-icon {
    width: 22px;
    height: 22px;
    background: transparent;
    border: 0;
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
    background: color-mix(in srgb, var(--surface, var(--bg1)) 92%, transparent);
    box-shadow: 0 18px 36px var(--shadow);
    backdrop-filter: blur(16px);
  }

  .mobile-tabbar-settings:hover {
    color: var(--text);
    background: var(--surface2, var(--bg2));
    border-color: var(--border2);
  }

  .mobile-tabbar-settings svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2px;
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

  .sidebar-collapsed .desktop-settings-edge {
    left: 80px;
  }
}
</style>
