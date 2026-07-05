<script setup lang="ts">
import { computed } from 'vue'
import { useTheme, type ThemeMode } from '../lib/theme'
import { usePublicSettings } from '../lib/publicSettings'

const SIDEBAR_COLLAPSED_KEY = 'yp_sidebar_collapsed_v2'

const props = withDefaults(defineProps<{
  activeTab: 'files' | 'history' | 'admin' | null
  showHistory?: boolean
  showAdmin?: boolean
  showSettings?: boolean
  collapsed: boolean
}>(), {
  showHistory: false,
  showAdmin: false,
  showSettings: false,
})

const emit = defineEmits<{
  'update:collapsed': [value: boolean]
  'select-files': []
  'select-history': []
  'select-admin': []
  'toggle-settings': []
}>()

const { themeMode, appliedTheme, setThemeMode } = useTheme()
const { appName } = usePublicSettings()

const themeOptions: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: 'Auto' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
]

const themeLabel = computed(() => {
  if (themeMode.value === 'system') return `System theme, currently ${appliedTheme.value}`
  return `${themeMode.value} theme`
})

function toggleCollapsed() {
  const next = !props.collapsed
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
  }
  emit('update:collapsed', next)
}

function toggleCompactTheme() {
  setThemeMode(appliedTheme.value === 'dark' ? 'light' : 'dark')
}
</script>

<template>
  <aside class="sidebar" :class="{ 'sidebar-collapsed': collapsed }" aria-label="Workspace navigation">
    <div class="sidebar-top">
      <button
        type="button"
        class="brand-block"
        :aria-label="collapsed ? 'Expand navigation' : 'Collapse navigation'"
        :aria-expanded="!collapsed"
        data-testid="sidebar-brand-toggle"
        @click="toggleCollapsed"
      >
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M5 7.5h14" />
            <path d="M7 7.5l.8-2.1A2 2 0 0 1 9.7 4h4.6a2 2 0 0 1 1.9 1.4l.8 2.1" />
            <path d="M6.5 7.5 7.4 19a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8l.9-11.5" />
            <path d="M10 11.2v5.4" />
            <path d="M14 11.2v5.4" />
          </svg>
        </span>
        <div>
          <div class="brand-title">{{ appName }}</div>
        </div>
      </button>
    </div>

    <nav class="nav-stack" aria-label="Primary">
      <div class="nav-section-label">Workspace</div>
      <button
        type="button"
        :class="{ active: activeTab === 'files' }"
        aria-label="Files"
        :aria-current="activeTab === 'files' ? 'page' : undefined"
        data-testid="desktop-nav-files"
        @click="emit('select-files')"
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
        v-if="showHistory"
        type="button"
        :class="{ active: activeTab === 'history' }"
        aria-label="History"
        :aria-current="activeTab === 'history' ? 'page' : undefined"
        data-testid="desktop-nav-history"
        @click="emit('select-history')"
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

    <nav v-if="showAdmin" class="nav-stack nav-stack-lower" aria-label="Administration">
      <div class="nav-section-label">Admin</div>
      <button
        type="button"
        :class="{ active: activeTab === 'admin' }"
        aria-label="Admin"
        :aria-current="activeTab === 'admin' ? 'page' : undefined"
        data-testid="desktop-nav-admin"
        @click="emit('select-admin')"
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
        <button
          v-if="showSettings"
          type="button"
          class="preferences-btn"
          aria-label="Preferences"
          data-testid="desktop-preferences"
          @click="emit('toggle-settings')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
          <span>Preferences</span>
        </button>
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
        <button
          v-if="showSettings"
          type="button"
          class="compact-icon-btn"
          aria-label="Preferences"
          data-testid="collapsed-preferences"
          @click="emit('toggle-settings')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
        </button>
      </div>
    </div>
  </aside>

  <nav class="mobile-tabbar" aria-label="Primary mobile">
    <div class="mobile-tabbar-main" :class="{ 'has-admin': showAdmin }">
      <button
        type="button"
        :class="{ active: activeTab === 'files' }"
        :aria-current="activeTab === 'files' ? 'page' : undefined"
        data-testid="mobile-nav-files"
        @click="emit('select-files')"
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
        v-if="showHistory"
        type="button"
        :class="{ active: activeTab === 'history' }"
        :aria-current="activeTab === 'history' ? 'page' : undefined"
        data-testid="mobile-nav-history"
        @click="emit('select-history')"
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
        v-if="showAdmin"
        type="button"
        :class="{ active: activeTab === 'admin' }"
        :aria-current="activeTab === 'admin' ? 'page' : undefined"
        data-testid="mobile-nav-admin"
        @click="emit('select-admin')"
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
      v-if="showSettings"
      class="mobile-tabbar-settings"
      type="button"
      aria-label="Settings"
      data-testid="mobile-nav-settings"
      @click="emit('toggle-settings')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
      </svg>
    </button>
  </nav>
</template>

<style scoped>
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
  gap: var(--space-4);
}

.brand-block {
  appearance: none;
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1);
  color: var(--text);
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.brand-block:hover {
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 74%, transparent);
  border-color: transparent;
}

.brand-block:active {
  transform: scale(0.98);
}

.brand-mark {
  width: 38px;
  height: 38px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 72%, transparent);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--text) 6%, transparent) inset;
}

.brand-mark svg {
  width: 23px;
  height: 23px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.brand-title {
  color: var(--text);
  font-family: var(--font);
  font-size: var(--fs-h2);
  font-weight: 700;
  line-height: var(--lh-tight);
}

.sidebar-collapsed {
  align-items: center;
  padding-inline: 12px;
}

.sidebar-collapsed .brand-block {
  width: 44px;
  justify-content: center;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
}

.sidebar-collapsed .brand-mark {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
}

.sidebar-collapsed .brand-mark svg {
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
  gap: var(--space-2);
}

.nav-stack-lower {
  margin-top: auto;
}

.sidebar-collapsed .nav-stack {
  width: 44px;
}

.nav-section-label,
.utility-label {
  color: var(--text2);
  letter-spacing: 0.04em;
  text-transform: lowercase;
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: var(--lh-tight);
}

.nav-section-label {
  padding: 0 4px 2px;
}

.nav-stack button {
  width: 100%;
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  color: var(--text2);
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.nav-stack button:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 74%, transparent);
  border-color: transparent;
}

.nav-stack button:active {
  transform: scale(0.98);
}

.nav-stack button.active {
  position: relative;
  color: var(--text);
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 82%, transparent);
  border-color: transparent;
  box-shadow: none;
}

.nav-stack button.active::before {
  content: "";
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: var(--radius-full);
  background: var(--accent);
}

.sidebar-collapsed .nav-stack button.active::before {
  left: -12px;
}

.sidebar-collapsed .nav-stack button {
  width: 44px;
  min-height: 44px;
  justify-content: center;
  padding: var(--space-2);
}

.sidebar-collapsed .nav-stack button.active {
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 70%, transparent);
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
  border-radius: var(--radius-sm);
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
  gap: var(--space-1);
  line-height: var(--lh-tight);
}

.nav-copy small {
  color: var(--text2);
  font-family: var(--font);
  font-size: var(--fs-xs);
  font-weight: 400;
}

.sidebar-footer {
  display: grid;
  gap: var(--space-2);
  padding-top: var(--space-3);
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
  gap: var(--space-2);
}

.collapsed-utilities {
  display: none;
  gap: var(--space-2);
}

.sidebar-collapsed .collapsed-utilities {
  display: grid;
  justify-items: center;
}

.theme-switch {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-1);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface, var(--bg1));
}

.theme-switch button {
  flex: 1;
  min-height: 31px;
  padding: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-xs);
  background: transparent;
  border-radius: calc(var(--radius-sm) - 3px);
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.theme-switch button.active {
  color: var(--text);
  background: color-mix(in srgb, var(--surface3, var(--bg3)) 82%, var(--accent-soft, var(--bg2)));
}

.theme-switch button:hover:not(.active) {
  color: var(--text);
  background: var(--bg1);
}

.theme-switch button:active {
  transform: scale(0.96);
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
  border-radius: var(--radius-sm);
  background: var(--surface2, var(--bg2));
  transition: color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.compact-icon-btn:hover {
  color: var(--text);
  border-color: var(--border2);
  background: var(--surface3, var(--bg3));
}

.compact-icon-btn:active {
  transform: scale(0.94);
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

.preferences-btn {
  width: 100%;
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  color: var(--text2);
  font-family: var(--font);
  font-size: var(--fs-xs);
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface, var(--bg1));
  transition: color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.preferences-btn:hover {
  color: var(--text);
  border-color: var(--border2);
  background: color-mix(in srgb, var(--surface3, var(--bg3)) 84%, transparent);
}

.preferences-btn:active {
  transform: scale(0.98);
}

.preferences-btn svg {
  width: 16px;
  height: 16px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mobile-tabbar {
  display: none;
}

@media (max-width: 600px) {
  .sidebar {
    display: none;
  }

  .mobile-tabbar {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    z-index: 110;
    display: flex;
    align-items: stretch;
    gap: 10px;
  }

  .mobile-tabbar-main {
    min-width: 0;
    flex: auto;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: color-mix(in srgb, var(--surface, var(--bg1)) 92%, transparent);
    box-shadow: 0 18px 36px var(--shadow);
    backdrop-filter: blur(16px);
  }

  .mobile-tabbar-main.has-admin {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .mobile-tabbar-main button,
  .mobile-tabbar-settings {
    min-height: 46px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text2);
    font-weight: 600;
    touch-action: manipulation;
  }

  .mobile-tabbar-main button.active {
    border-color: var(--border);
    background: var(--surface2, var(--bg2));
    color: var(--text);
  }

  .mobile-tabbar .nav-icon {
    width: 22px;
    height: 22px;
    border: none;
    background: transparent;
  }

  .mobile-tabbar-settings {
    flex: 0 0 52px;
    padding: 0;
    border-color: var(--border);
    border-radius: 14px;
    background: color-mix(in srgb, var(--surface, var(--bg1)) 92%, transparent);
    box-shadow: 0 18px 36px var(--shadow);
    backdrop-filter: blur(16px);
  }
}
</style>
