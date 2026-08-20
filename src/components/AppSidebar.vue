<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTheme, type ThemeMode } from '../lib/theme'
import { usePublicSettings } from '../lib/publicSettings'
import { getAuthUsername, isAuthAdmin, isLoggedIn } from '../lib/api'
import { useAvatar } from '../lib/avatar'
import AvatarTile from './AvatarTile.vue'

const SIDEBAR_COLLAPSED_KEY = 'yp_sidebar_collapsed_v2'
const MOBILE_NAV_COLLAPSED_KEY = 'yp_mobile_nav_collapsed_v2'

const props = withDefaults(defineProps<{
  activeTab: 'files' | 'history' | 'admin' | null
  showHistory?: boolean
  showAdmin?: boolean
  showSettings?: boolean
  settingsOpen?: boolean
  showGuestAccess?: boolean
  accountActive?: boolean
  collapsed: boolean
}>(), {
  showHistory: false,
  showAdmin: false,
  showSettings: false,
  settingsOpen: false,
  showGuestAccess: false,
  accountActive: false,
})

const emit = defineEmits<{
  'update:collapsed': [value: boolean]
  'select-files': []
  'select-history': []
  'select-admin': []
  'toggle-settings': []
  'open-account': []
  login: []
  register: []
}>()

const { themeMode, appliedTheme, setThemeMode } = useTheme()
const { appName, publicSettings } = usePublicSettings()
const { avatarPrefs } = useAvatar()
const mobileNavCollapsed = ref(false)

const account = computed(() => {
  if (!isLoggedIn()) return null
  const name = getAuthUsername()
  if (!name) return null
  return {
    name,
    initials: name.slice(0, 2).toUpperCase(),
    admin: isAuthAdmin(),
  }
})

if (typeof window !== 'undefined') {
  mobileNavCollapsed.value = window.localStorage.getItem(MOBILE_NAV_COLLAPSED_KEY) === '1'
}

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

function toggleMobileNav() {
  const next = !mobileNavCollapsed.value
  mobileNavCollapsed.value = next
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(MOBILE_NAV_COLLAPSED_KEY, next ? '1' : '0')
  }
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

      <button
        v-if="account"
        type="button"
        class="account-chip"
        data-testid="sidebar-account"
        :class="{ active: accountActive }"
        :aria-label="'Open account settings for ' + account.name"
        :aria-current="accountActive ? 'page' : undefined"
        @click="emit('open-account')"
      >
        <AvatarTile :name="account.name" :prefs="avatarPrefs" size="sm" />
        <span class="account-meta">
          <span class="account-name">{{ account.name }}</span>
          <span class="account-role">{{ account.admin ? 'Admin' : 'Account' }}</span>
        </span>
        <svg class="account-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m5.5 6.5 2.5 2.5 2.5-2.5" />
        </svg>
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
        <div v-if="showGuestAccess" class="guest-access">
          <button class="guest-login" type="button" @click="emit('login')">Log in</button>
          <button v-if="publicSettings.registration_enabled" class="guest-register" type="button" @click="emit('register')">Create account</button>
        </div>
        <div class="sidebar-divider" aria-hidden="true"></div>
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
          aria-controls="settings-panel"
          :aria-expanded="settingsOpen"
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
        <button v-if="showGuestAccess" class="compact-icon-btn" type="button" aria-label="Log in" @click="emit('login')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="m10 17 5-5-5-5" /><path d="M15 12H3" /></svg>
        </button>
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
          aria-controls="settings-panel"
          :aria-expanded="settingsOpen"
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

  <nav
    class="mobile-tabbar"
    :class="{ 'is-collapsed': mobileNavCollapsed }"
    aria-label="Primary mobile"
    data-testid="mobile-tabbar"
  >
    <div class="mobile-nav-cluster">
      <button
        v-if="showSettings"
        class="mobile-tabbar-settings"
        :class="{ active: settingsOpen }"
        type="button"
        aria-label="Preferences"
        aria-controls="settings-panel"
        :aria-expanded="settingsOpen"
        data-testid="mobile-nav-preferences"
        @click="emit('toggle-settings')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
        </svg>
      </button>
      <div class="mobile-nav-ribbon">
      <button
        class="mobile-tabbar-toggle"
        type="button"
        :aria-label="mobileNavCollapsed ? 'Expand navigation' : 'Collapse navigation'"
        :aria-expanded="!mobileNavCollapsed"
        data-testid="mobile-nav-toggle"
        @click="toggleMobileNav"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </svg>
      </button>
        <Transition name="mobile-nav-content">
    <div v-if="!mobileNavCollapsed" class="mobile-tabbar-main" :class="{ 'has-history': showHistory, 'has-admin': showAdmin }">
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
        <span class="mobile-tab-label">Files</span>
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
        <span class="mobile-tab-label">History</span>
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
        <span class="mobile-tab-label">Admin</span>
      </button>
    </div>
        </Transition>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.sidebar {
  min-height: max(100vh, 100dvh);
  height: auto;
  align-self: stretch;
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4) 12px;
  overflow: hidden;
  border-right: 1px solid var(--border);
  background: var(--surface);
  box-shadow: none;
}

.sidebar-top {
  display: grid;
  gap: var(--space-4);
}

.brand-block {
  appearance: none;
  width: 100%;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  color: var(--text);
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius);
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.brand-block:hover {
  background: var(--bg2);
  border-color: transparent;
}


.brand-mark {
  width: 34px;
  height: 34px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg2);
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
  font-weight: 650;
  line-height: var(--lh-tight);
  letter-spacing: -0.01em;
}

.sidebar-collapsed {
  align-items: center;
  padding-inline: 12px;
}

.sidebar-collapsed .brand-block {
  width: 44px;
  justify-content: center;
  padding: 0;
  border-radius: var(--radius-sm);
  transform: translateX(4px);
}

.sidebar-collapsed .brand-mark {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: transparent;
  border-color: var(--border);
}

.sidebar-collapsed .brand-block:hover {
  background: transparent;
}

.sidebar-collapsed .brand-block:hover .brand-mark {
  background: color-mix(in srgb, var(--surface2, var(--bg2)) 74%, transparent);
  border-color: color-mix(in srgb, var(--border2) 72%, transparent);
}

.sidebar-collapsed .brand-mark svg {
  width: 21px;
  height: 21px;
}

.sidebar-collapsed .brand-title,
.sidebar-collapsed .account-chip,
.sidebar-collapsed .nav-section-label,
.sidebar-collapsed .nav-copy,
.sidebar-collapsed .expanded-utilities {
  display: none;
}

/* Signed-in account chip under the brand. */
.account-chip {
  min-width: 0;
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 4px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg2);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.account-chip:hover {
  border-color: var(--border2);
  background: var(--bg3);
}
.account-chip.active {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: var(--accent-soft);
}
.account-chip.active:hover {
  background: color-mix(in srgb, var(--accent) 14%, var(--bg2));
}
.account-meta {
  min-width: 0;
  display: grid;
  line-height: 1.2;
}
.account-name {
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-role {
  color: var(--text2);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.account-chevron {
  width: 14px;
  height: 14px;
  flex: none;
  margin-left: auto;
  fill: none;
  stroke: var(--text3);
  stroke-width: 1.8px;
  stroke-linecap: round;
  stroke-linejoin: round;
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
  letter-spacing: 0.01em;
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: var(--lh-tight);
}

.nav-section-label {
  padding: 0 4px 2px;
}

.nav-stack button {
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  color: var(--text2);
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius);
  font-size: var(--fs-body);
  font-weight: 500;
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.nav-stack button:hover {
  color: var(--text);
  background: var(--bg2);
  border-color: transparent;
}


.nav-stack button.active {
  position: relative;
  color: var(--text);
  background: var(--accent-soft);
  border-color: transparent;
  box-shadow: none;
}

.nav-stack button.active::before {
  content: "";
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 16px;
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
  width: 20px;
  height: 20px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
}

.nav-stack button.active .nav-icon {
  color: var(--accent);
}

.nav-icon svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.nav-copy {
  min-width: 0;
  display: grid;
  line-height: var(--lh-tight);
  font-size: var(--fs-body);
  font-weight: 500;
}

/* Subtitles under nav items read as template filler; the rows carry
   one label only. */
.nav-copy small {
  display: none;
}

.sidebar-footer {
  display: grid;
  gap: var(--space-2);
  padding-top: var(--space-3);
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
.guest-access {
  display: flex;
  width: 100%;
  gap: var(--space-2);
}
.sidebar-divider {
  height: 1px;
  background: var(--border);
}
.guest-login,
.guest-register {
  width: 100%;
  min-height: 34px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  font-size: var(--fs-sm);
  font-weight: 500;
}
.guest-login {
  flex: 1 1 auto;
  color: var(--on-accent);
  background: var(--primary-action);
}
.guest-login:hover { background: var(--primary-action-h); }
.guest-register {
  color: var(--text);
  border: 1px solid var(--border2);
  background: var(--bg1);
}
.guest-register:hover { color: var(--text); border-color: var(--text3); background: var(--bg2); }

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
  gap: 2px;
  padding: 3px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg2);
}

.theme-switch button {
  flex: 1;
  min-height: 28px;
  padding: 4px var(--space-2);
  color: var(--text2);
  font-size: var(--fs-xs);
  font-weight: 500;
  background: transparent;
  border-radius: calc(var(--radius) - 2px);
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.theme-switch button.active {
  color: var(--text);
  background: var(--bg1);
  box-shadow: var(--shadow-sm);
}

.theme-switch button:hover:not(.active) {
  color: var(--text);
  background: color-mix(in srgb, var(--bg1) 60%, transparent);
}


.compact-icon-btn {
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--text2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  transition: color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.compact-icon-btn:hover {
  color: var(--text);
  border-color: color-mix(in srgb, var(--border2) 45%, transparent);
  background: color-mix(in srgb, var(--surface3, var(--bg3)) 42%, transparent);
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
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 10px;
  color: var(--text2);
  font-family: var(--font);
  font-size: var(--fs-body);
  font-weight: 500;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  transition: color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.preferences-btn:hover {
  color: var(--text);
  border-color: transparent;
  background: var(--bg2);
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

.mobile-nav-cluster,
.mobile-tabbar-settings,
.mobile-tabbar-toggle {
  display: none;
}

@media (max-width: 600px) {
  .sidebar {
    display: none;
  }

  .mobile-tabbar {
    position: fixed;
    left: calc(var(--mobile-chrome-left) + var(--mobile-nav-inset));
    right: auto;
    width: calc(100vw - var(--mobile-chrome-left) - var(--mobile-nav-inset) - var(--mobile-chrome-right) - var(--mobile-nav-inset));
    max-width: calc(100vw - var(--mobile-chrome-left) - var(--mobile-nav-inset) - var(--mobile-chrome-right) - var(--mobile-nav-inset));
    bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    z-index: 110;
    display: block;
    pointer-events: none;
    transition: width var(--duration-base) var(--ease-out);
  }

  .mobile-tabbar.is-collapsed {
    width: 58px;
  }

  .mobile-nav-cluster {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    pointer-events: none;
  }

  .mobile-nav-ribbon {
    position: relative;
    width: 100%;
    height: 58px;
    --mobile-ribbon-radius: 18px;
    --mobile-ribbon-overlap: var(--mobile-ribbon-radius);
    display: flex;
    align-items: stretch;
    pointer-events: none;
  }

  .mobile-tabbar-settings,
  .mobile-tabbar-toggle {
    width: 58px;
    height: 58px;
    min-height: 58px;
    flex: 0 0 58px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    color: var(--text2);
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 10px 24px var(--shadow);
    pointer-events: auto;
    touch-action: manipulation;
    transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), border-radius var(--duration-base) var(--ease-out), transform var(--duration-fast) var(--ease-out);
  }

  .mobile-tabbar-settings {
    pointer-events: auto;
  }

  .mobile-tabbar-settings:hover,
  .mobile-tabbar-settings:focus-visible,
  .mobile-tabbar-settings.active,
  .mobile-tabbar-toggle:hover,
  .mobile-tabbar-toggle:focus-visible,
  .mobile-tabbar.is-collapsed .mobile-tabbar-toggle {
    color: var(--text);
    background: var(--surface2, var(--bg2));
    border-color: var(--border2);
  }

  .mobile-tabbar-toggle {
    position: relative;
    z-index: 1;
    border-right: 1px solid var(--border);
    border-radius: var(--mobile-ribbon-radius);
  }

  .mobile-tabbar.is-collapsed .mobile-tabbar-toggle {
    border-right: 1px solid var(--border);
    border-radius: var(--mobile-ribbon-radius);
  }

  .mobile-tabbar-settings svg,
  .mobile-tabbar-toggle svg {
    width: 21px;
    height: 21px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 2px;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .mobile-tabbar-main {
    position: relative;
    min-width: 0;
    width: auto;
    height: 58px;
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    margin-left: calc(var(--mobile-ribbon-overlap) * -1);
    padding: 6px 6px 6px calc(6px + var(--mobile-ribbon-overlap));
    box-sizing: border-box;
    border: 1px solid var(--border);
    border-left: 0;
    border-radius: 0 var(--mobile-ribbon-radius) var(--mobile-ribbon-radius) 0;
    background: var(--surface);
    box-shadow: 0 10px 24px var(--shadow);
    pointer-events: auto;
    transform-origin: left center;
    transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out);
  }

  .mobile-tabbar-main.has-history {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .mobile-tabbar-main.has-admin {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .mobile-tabbar-main button {
    min-width: 0;
    min-height: 44px;
    display: inline-flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 2px 6px;
    color: var(--text2);
    font-weight: 600;
    font-size: 11px;
    border: 1px solid transparent;
    border-radius: 12px;
    background: transparent;
    touch-action: manipulation;
    transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
  }

  .mobile-tabbar-main button:hover,
  .mobile-tabbar-main button:focus-visible {
    color: var(--text);
    background: color-mix(in srgb, var(--surface2, var(--bg2)) 72%, transparent);
  }

  .mobile-tabbar-main button.active {
    color: var(--text);
    border-color: var(--border);
    background: var(--surface2, var(--bg2));
  }

  .mobile-tabbar .nav-icon {
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    border: none;
    background: transparent;
  }

  .mobile-tabbar .mobile-tab-label {
    display: block;
    max-width: 0;
    overflow: hidden;
    opacity: 0;
    white-space: nowrap;
    transform: translateX(-4px);
    transition: max-width var(--duration-base) var(--ease-out), opacity var(--duration-fast) var(--ease-out), transform var(--duration-base) var(--ease-out);
  }

  .mobile-tabbar-main button.active .mobile-tab-label {
    max-width: 64px;
    opacity: 1;
    transform: translateX(0);
  }

  .mobile-nav-content-enter-active,
  .mobile-nav-content-leave-active {
    transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out);
  }

  .mobile-nav-content-enter-from,
  .mobile-nav-content-leave-to {
    opacity: 0;
    transform: translateX(-12px) scaleX(0.14);
    transform-origin: left center;
  }

  .mobile-nav-content-leave-active {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 58px;
  }
}

</style>
