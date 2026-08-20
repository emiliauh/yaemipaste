<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  authPasskeyDelete,
  authPasskeyRegisterBegin,
  authPasskeyRegisterFinish,
  authPasskeyRename,
  authPasskeysList,
  getAuthUsername,
  getDefaultPasteApiBase,
  getPasteApiBase,
  getShareXConfig,
  hasAccountAuth,
  isLoggedIn,
  isShareXEnabled,
  setPasteApiBase,
  type PasskeySummary,
} from '../lib/api'
import { credentialToJson, isPasskeySupported, passkeyErrorMessage, toCreationOptions } from '../lib/passkeys'
import { useNotificationStore } from '../stores/notifications'
import { isAuthEnabled } from '../lib/features'
import { usePublicSettings } from '../lib/publicSettings'
import { useTheme, type ThemeMode } from '../lib/theme'
import RepositoryLink from './RepositoryLink.vue'
import { useAvatar } from '../lib/avatar'
import AvatarTile from './AvatarTile.vue'

const emit = defineEmits<{ close: [], login: [], register: [], 'open-account': [] }>()
const notificationStore = useNotificationStore()
const { avatarPrefs } = useAvatar()

const username = getAuthUsername()
const authEnabled = isAuthEnabled()
const loggedIn = isLoggedIn()
const hasAccount = hasAccountAuth()
const sharexEnabled = isShareXEnabled()
const defaultApiBase = getDefaultPasteApiBase()
const { appName, publicSettings, refreshPublicSettings } = usePublicSettings()
const apiBase = ref(getPasteApiBase())
const apiBaseEdited = ref(false)
const { themeMode, appliedTheme, setThemeMode } = useTheme()
const themeOptions: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: 'Auto' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
]
const themeLabel = computed(() => `Theme, currently ${appliedTheme.value}`)
const downloading = ref(false)
const saved = ref(false)
const passkeyModalOpen = ref(false)
const passkeys = ref<PasskeySummary[]>([])
const passkeyBusy = ref(false)
const passkeyLoading = ref(false)
const passkeyError = ref('')
const renameTargetId = ref<number | null>(null)
const renameValue = ref('')
const renameInput = ref<HTMLInputElement | null>(null)
watch(() => publicSettings.value.base_api_url, () => {
  if (!apiBaseEdited.value) apiBase.value = getPasteApiBase()
})

async function save() {
  try {
    setPasteApiBase(apiBase.value)
    await refreshPublicSettings(true)
    saved.value = true
    setTimeout(() => { saved.value = false; emit('close') }, 800)
  } catch (e: any) {
    notificationStore.push(e.message ?? 'Could not save API base URL', 'error')
  }
}

function shareXFileName(): string {
  const safeName = appName.value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safeName || 'yaemipaste'}.sxcu`
}

async function downloadShareX() {
  downloading.value = true
  try {
    const blob = await getShareXConfig()
    const a = document.createElement('a')
    const url = URL.createObjectURL(blob)
    a.href = url
    a.download = shareXFileName()
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (e: any) {
    notificationStore.push(e.message ?? 'Could not generate ShareX config', 'error')
  } finally {
    downloading.value = false
  }
}

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return 'Never used'
  return new Date(timestamp * 1000).toLocaleString()
}

async function refreshPasskeys() {
  passkeyLoading.value = true
  passkeyError.value = ''
  try {
    passkeys.value = await authPasskeysList()
  } catch (e: any) {
    passkeyError.value = e.message ?? 'Could not load passkeys'
  } finally {
    passkeyLoading.value = false
  }
}

async function openPasskeyModal() {
  passkeyModalOpen.value = true
  await refreshPasskeys()
}

function closePasskeyModal() {
  passkeyModalOpen.value = false
  passkeyError.value = ''
}

async function registerPasskey() {
  if (!isPasskeySupported()) {
    passkeyError.value = 'Passkeys are not supported in this browser.'
    return
  }
  passkeyBusy.value = true
  passkeyError.value = ''
  try {
    const options = await authPasskeyRegisterBegin()
    const credential = await navigator.credentials.create({ publicKey: toCreationOptions(options) })
    if (!(credential instanceof PublicKeyCredential)) throw new Error('Could not create a passkey credential')
    await authPasskeyRegisterFinish(credentialToJson(credential))
    notificationStore.push('Passkey added')
    await refreshPasskeys()
  } catch (e: any) {
    passkeyError.value = passkeyErrorMessage(e, 'Could not register passkey')
  } finally {
    passkeyBusy.value = false
  }
}

async function deletePasskey(id: number) {
  passkeyBusy.value = true
  passkeyError.value = ''
  try {
    await authPasskeyDelete(id)
    notificationStore.push('Passkey removed')
    passkeys.value = passkeys.value.filter((item) => item.id !== id)
  } catch (e: any) {
    passkeyError.value = passkeyErrorMessage(e, 'Could not remove passkey')
  } finally {
    passkeyBusy.value = false
  }
}

function beginRename(item: PasskeySummary) {
  renameTargetId.value = item.id
  renameValue.value = item.name?.trim() ?? ''
  requestAnimationFrame(() => {
    if (typeof renameInput.value?.focus === 'function') renameInput.value.focus()
  })
}

function cancelRename() {
  renameTargetId.value = null
  renameValue.value = ''
}

async function submitRename(item: PasskeySummary) {
  const value = renameValue.value.trim()
  if (!value || value === (item.name?.trim() ?? '')) {
    cancelRename()
    return
  }
  passkeyBusy.value = true
  passkeyError.value = ''
  try {
    await authPasskeyRename(item.id, value)
    const target = passkeys.value.find((entry) => entry.id === item.id)
    if (target) target.name = value
    notificationStore.push('Passkey renamed')
    cancelRename()
  } catch (e: any) {
    passkeyError.value = passkeyErrorMessage(e, 'Could not rename passkey')
  } finally {
    passkeyBusy.value = false
  }
}

</script>

<template>
  <!-- id lives here: this component has multiple roots, so an id passed by a
       parent cannot be inherited and the sidebar's aria-controls would dangle. -->
  <div id="settings-panel" class="settings-panel">
    <div class="settings-header">
      <div style="font-size:var(--fs-h2); font-weight:600; color:var(--text)">Settings</div>
      <div class="row">
        <button class="btn-ghost" style="font-size:var(--fs-xs)" @click="emit('close')">Cancel</button>
        <button class="btn-primary" style="font-size:var(--fs-xs)" @click="save">{{ saved ? 'Saved' : 'Save' }}</button>
      </div>
    </div>

    <button
      v-if="authEnabled && loggedIn"
      type="button"
      class="settings-account-row"
      data-testid="settings-open-account"
      @click="emit('open-account')"
    >
      <AvatarTile :name="username" :prefs="avatarPrefs" size="sm" />
      <span class="settings-account-meta">
        <span class="settings-account-name">{{ username }}</span>
        <span class="settings-account-role">Manage account</span>
      </span>
      <svg class="settings-account-chevron" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m6 5.5 2.5 2.5L11 5.5" />
      </svg>
    </button>

    <div class="field">
      <label>Theme</label>
      <div class="theme-switch settings-theme-switch" role="group" :aria-label="themeLabel" data-testid="settings-theme-switch">
        <button
          v-for="option in themeOptions"
          :key="option.mode"
          type="button"
          :class="{ active: themeMode === option.mode }"
          :aria-pressed="themeMode === option.mode"
          :data-testid="`settings-theme-${option.mode}`"
          @click="setThemeMode(option.mode)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <div class="field">
      <label for="api-base-url">Upload API base URL</label>
      <input id="api-base-url" v-model="apiBase" type="text" autocomplete="off" :placeholder="defaultApiBase" aria-label="Upload API base URL" @input="apiBaseEdited = true" />
      <p class="field-hint">Used for uploads and history requests. Leave blank for this deployment's default.</p>
    </div>

    <div v-if="hasAccount" class="field">
      <label>ShareX Config</label>
      <p class="field-hint">
        {{ sharexEnabled ? 'Download pre-configured .sxcu for your account.' : 'ShareX account configs are unavailable on this deployment.' }}
      </p>
      <button class="btn-primary" style="font-size:var(--fs-xs); width:100%" :disabled="downloading || !sharexEnabled" @click="downloadShareX">
        {{ downloading ? 'Generating…' : 'Download .sxcu' }}
      </button>
    </div>
    <div v-if="hasAccount" class="field">
      <label>Passkeys</label>
      <p v-if="!publicSettings.passkeys_enabled" class="field-hint">Passkey sign-in is disabled by the administrator. Existing passkeys can still be removed.</p>
      <button class="btn-primary passkey-open-btn" type="button" data-testid="open-passkey-modal" @click="openPasskeyModal">
        <span>Manage passkeys</span>
      </button>
    </div>

    <div v-if="authEnabled && !loggedIn">
      <div class="settings-divider"></div>
      <div class="account-action-row" :class="{ 'single-action': !publicSettings.registration_enabled }">
      <button class="btn-primary login-btn" type="button" @click="emit('login')">Log in</button>
      <button v-if="publicSettings.registration_enabled" class="btn-ghost register-btn" type="button" @click="emit('register')">Create account</button>
      </div>
    </div>

    <div class="settings-footer">
      <RepositoryLink class="settings-github-link" data-testid="settings-github-link" />
      <span>{{ appName }}</span>
    </div>
  </div>

  <div v-if="passkeyModalOpen" class="passkey-backdrop" data-testid="passkey-backdrop" @click.self="closePasskeyModal">
    <div class="passkey-modal" data-testid="passkey-modal">
      <div class="passkey-header">
        <h3>Passkeys</h3>
        <button class="btn-ghost" type="button" @click="closePasskeyModal">Close</button>
      </div>
      <p class="passkey-copy">Use passkeys for passwordless login on supported devices and managers.</p>

      <button v-if="publicSettings.passkeys_enabled" class="btn-primary passkey-add-btn" type="button" data-testid="passkey-add-btn" :disabled="passkeyBusy" @click="registerPasskey">
        {{ passkeyBusy ? 'Working…' : 'Add passkey' }}
      </button>
      <div v-else class="passkey-state">Passkey sign-in and registration are disabled.</div>

      <div v-if="passkeyLoading" class="passkey-state">Loading passkeys…</div>
      <div v-else-if="!passkeys.length" class="passkey-state">No passkeys yet.</div>
      <div v-else class="passkey-list" data-testid="passkey-list">
        <div v-for="item in passkeys" :key="item.id" class="passkey-row" data-testid="passkey-row">
          <div class="passkey-info">
            <template v-if="renameTargetId === item.id">
              <input ref="renameInput" v-model="renameValue" class="passkey-rename-input" type="text" maxlength="100" placeholder="Passkey name" aria-label="Passkey name" :disabled="passkeyBusy" @keydown.enter.prevent="submitRename(item)" @keydown.esc.prevent="cancelRename" data-testid="passkey-rename-input" />
            </template>
            <template v-else>
              <div class="passkey-name" data-testid="passkey-name">{{ item.name?.trim() || 'Passkey' }}</div>
              <div class="passkey-id">{{ item.credential_id.slice(0, 14) }}…</div>
            </template>
            <div class="passkey-meta">Created {{ formatTimestamp(item.created_at) }}</div>
            <div class="passkey-meta">{{ formatTimestamp(item.last_used_at) }}</div>
          </div>
          <div class="passkey-actions">
            <template v-if="renameTargetId === item.id">
              <button class="btn-ghost" type="button" :disabled="passkeyBusy" @click="submitRename(item)">Save</button>
              <button class="btn-ghost" type="button" :disabled="passkeyBusy" @click="cancelRename">Cancel</button>
            </template>
            <template v-else>
              <button class="btn-ghost passkey-rename-btn" type="button" :disabled="passkeyBusy || renameTargetId !== null" aria-label="Rename passkey" title="Rename passkey" data-testid="passkey-rename-btn" @click="beginRename(item)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button class="btn-red" type="button" :disabled="passkeyBusy || renameTargetId !== null" @click="deletePasskey(item.id)">Delete</button>
            </template>
          </div>
        </div>
      </div>

      <div v-if="passkeyError" class="passkey-error">{{ passkeyError }}</div>
    </div>
  </div>

</template>

<style scoped>
.settings-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-3); }
.settings-account-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg2);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.settings-account-row:hover {
  border-color: var(--border2);
  background: var(--bg3);
}
.settings-account-avatar {
  width: 28px;
  height: 28px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #ffffff;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
.settings-account-meta {
  min-width: 0;
  display: grid;
  gap: 1px;
  line-height: 1.25;
}
.settings-account-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-body);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-account-role {
  color: var(--text2);
  font-size: var(--fs-xs);
}
.settings-account-chevron {
  width: 16px;
  height: 16px;
  flex: none;
  margin-left: auto;
  fill: none;
  stroke: var(--text3);
  stroke-width: 1.8px;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.field { display: flex; flex-direction: column; gap: var(--space-1); margin-bottom: var(--space-2); }
.field label { color: var(--text2); font-size: var(--fs-xs); }
.field input { width: 100%; font-size: var(--fs-sm); }
.field-hint { color: var(--text2); font-size: var(--fs-xs); margin-bottom: var(--space-2); }
.settings-theme-switch {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-1);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface, var(--bg1));
}
.settings-theme-switch button {
  flex: 1;
  min-height: 34px;
  padding: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-xs);
  background: transparent;
  border-radius: calc(var(--radius-sm) - 3px);
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.settings-theme-switch button.active {
  color: var(--text);
  background: color-mix(in srgb, var(--surface3, var(--bg3)) 82%, var(--accent-soft, var(--bg2)));
}
.settings-theme-switch button:hover:not(.active) {
  color: var(--text);
  background: var(--bg1);
}
.settings-theme-switch button:active {
  transform: scale(0.96);
}
.row { display: flex; gap: var(--space-2); justify-content: flex-end; }
.settings-divider { height: 1px; background: var(--border); margin: var(--space-3) 0; }
.settings-footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-xs);
  text-align: center;
}
.settings-github-link {
  width: 22px;
  height: 22px;
  display: inline-flex;
  flex: 0 0 22px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--accent);
}
.settings-github-link:hover { color: var(--accent-h); }
.settings-github-link :deep(svg) { width: 14px; height: 14px; }
.account-action-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
.account-action-row.single-action { grid-template-columns: 1fr; }
.login-btn, .register-btn { width: 100%; min-height: 40px; font-size: var(--fs-xs); }
.logout-btn { width: 100%; font-size: var(--fs-xs); }
.change-password-btn { width: 100%; font-size: var(--fs-xs); }
.passkey-open-btn {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}
.password-checkbox {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-xs);
  margin-bottom: var(--space-3);
}
.passkey-backdrop {
  pointer-events: auto;
  position: fixed;
  inset: 0;
  background: var(--modal-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  padding: var(--space-4);
}
.passkey-modal {
  width: min(560px, 100%);
  border: 1px solid var(--border2);
  border-radius: var(--radius-md);
  background: var(--bg1);
  padding: var(--space-4);
}
.passkey-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-2);
}
.passkey-header h3 {
  font-size: var(--fs-h2);
  font-weight: 600;
  line-height: var(--lh-tight);
  color: var(--text);
}
.passkey-copy {
  color: var(--text2);
  font-size: var(--fs-xs);
  margin-bottom: var(--space-3);
}
.passkey-add-btn {
  width: 100%;
  margin-bottom: var(--space-3);
}
.passkey-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.passkey-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  background: var(--bg);
}
.passkey-info {
  min-width: 0;
}
.passkey-name {
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.passkey-id {
  color: var(--text2);
  font-size: var(--fs-sm);
}
.passkey-meta {
  color: var(--text2);
  font-size: var(--fs-xs);
}
.passkey-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex: 0 0 auto;
}
.passkey-rename-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: var(--space-1);
}
.passkey-rename-btn svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
}
.passkey-rename-input {
  width: 100%;
  box-sizing: border-box;
  font-size: var(--fs-sm);
  margin-bottom: var(--space-1);
}
.passkey-state {
  color: var(--text2);
  font-size: var(--fs-xs);
}
.passkey-error {
  margin-top: var(--space-2);
  color: var(--red-h);
  font-size: var(--fs-xs);
}
.settings-panel .btn-ghost,
.settings-panel .btn-primary,
.settings-panel .btn-red,
.passkey-modal .btn-ghost,
.passkey-modal .btn-primary,
.passkey-modal .btn-red {
  transition: background var(--duration-fast) var(--ease-out), opacity var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.settings-panel .btn-ghost:not(:disabled):active,
.settings-panel .btn-primary:not(:disabled):active,
.settings-panel .btn-red:not(:disabled):active,
.passkey-modal .btn-ghost:not(:disabled):active,
.passkey-modal .btn-primary:not(:disabled):active,
.passkey-modal .btn-red:not(:disabled):active {
  transform: scale(0.97);
}
</style>
