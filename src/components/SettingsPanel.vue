<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  authChangePassword,
  authLogout,
  authLogoutAllDevices,
  authPasskeyDelete,
  authPasskeyRegisterBegin,
  authPasskeyRegisterFinish,
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

const emit = defineEmits<{ close: [], login: [], register: [], logout: [] }>()
const notificationStore = useNotificationStore()

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
const passwordModalOpen = ref(false)
const passwordBusy = ref(false)
const passwordError = ref('')
const currentPassword = ref('')
const nextPassword = ref('')
const confirmPassword = ref('')
const logoutAllAfterPasswordChange = ref(false)

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

function logout() {
  if (!authEnabled) return
  authLogout()
  emit('logout')
}

function openPasswordModal() {
  passwordModalOpen.value = true
  passwordError.value = ''
  currentPassword.value = ''
  nextPassword.value = ''
  confirmPassword.value = ''
  logoutAllAfterPasswordChange.value = false
}

function closePasswordModal(force = false) {
  if (passwordBusy.value && !force) return
  passwordModalOpen.value = false
  passwordError.value = ''
}

async function submitPasswordChange() {
  if (passwordBusy.value) return
  passwordError.value = ''
  const current = currentPassword.value.trim()
  const next = nextPassword.value.trim()
  const confirm = confirmPassword.value.trim()
  if (!current || !next || !confirm) {
    passwordError.value = 'All password fields are required.'
    return
  }
  if (next.length < 8) {
    passwordError.value = 'New password must be at least 8 characters.'
    return
  }
  if (next !== confirm) {
    passwordError.value = 'New passwords do not match.'
    return
  }
  if (next === current) {
    passwordError.value = 'New password must be different from current password.'
    return
  }
  passwordBusy.value = true
  try {
    await authChangePassword(current, next)
    if (logoutAllAfterPasswordChange.value) {
      try {
        await authLogoutAllDevices()
        notificationStore.push('Password changed. All devices were logged out.')
        emit('logout')
        return
      } catch (e: any) {
        notificationStore.push(
          e?.message
            ? `Password changed, but logging out other devices failed: ${e.message}`
            : 'Password changed, but logging out other devices failed.',
          'error',
        )
      }
    }
    notificationStore.push('Password changed')
    closePasswordModal(true)
  } catch (e: any) {
    passwordError.value = e.message ?? 'Could not change password'
  } finally {
    passwordBusy.value = false
  }
}

</script>

<template>
  <div class="settings-panel">
    <div class="settings-header">
      <div style="font-size:var(--fs-h2); font-weight:600; color:var(--text)">Settings</div>
      <div class="row">
        <button class="btn-ghost" style="font-size:var(--fs-xs)" @click="emit('close')">Cancel</button>
        <button class="btn-primary" style="font-size:var(--fs-xs)" @click="save">{{ saved ? 'Saved' : 'Save' }}</button>
      </div>
    </div>

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
    <div v-if="hasAccount && publicSettings.passkeys_enabled" class="field">
      <label>Passkeys</label>
      <button class="btn-primary passkey-open-btn" type="button" data-testid="open-passkey-modal" @click="openPasskeyModal">
        <span>Add passkey</span>
      </button>
    </div>

    <div v-if="username" style="margin-top:var(--space-1); color:var(--text2); font-size:var(--fs-xs); margin-bottom:var(--space-2)">
      Signed in as <span style="color:var(--text2)">{{ username }}</span>
    </div>

    <div class="settings-divider"></div>

    <div v-if="authEnabled && loggedIn" class="account-action-row">
      <button class="btn-red logout-btn" type="button" @click="logout">Logout</button>
      <button
        v-if="hasAccount"
        class="btn-primary change-password-btn"
        type="button"
        data-testid="open-change-password"
        @click="openPasswordModal"
      >
        Change Password
      </button>
    </div>
    <div v-else-if="authEnabled" class="account-action-row" :class="{ 'single-action': !publicSettings.registration_enabled }">
      <button class="btn-primary login-btn" type="button" @click="emit('login')">Log in</button>
      <button v-if="publicSettings.registration_enabled" class="btn-ghost register-btn" type="button" @click="emit('register')">Create account</button>
    </div>

    <div style="margin-top:var(--space-2); color:var(--text2); font-size:var(--fs-xs); text-align:center">
      {{ appName }}
    </div>
  </div>

  <div v-if="passkeyModalOpen" class="passkey-backdrop" data-testid="passkey-backdrop" @click.self="closePasskeyModal">
    <div class="passkey-modal" data-testid="passkey-modal">
      <div class="passkey-header">
        <h3>Passkeys</h3>
        <button class="btn-ghost" type="button" @click="closePasskeyModal">Close</button>
      </div>
      <p class="passkey-copy">Use passkeys for passwordless login on supported devices and managers.</p>

      <button class="btn-primary passkey-add-btn" type="button" data-testid="passkey-add-btn" :disabled="passkeyBusy" @click="registerPasskey">
        {{ passkeyBusy ? 'Working…' : 'Add passkey' }}
      </button>

      <div v-if="passkeyLoading" class="passkey-state">Loading passkeys…</div>
      <div v-else-if="!passkeys.length" class="passkey-state">No passkeys yet.</div>
      <div v-else class="passkey-list" data-testid="passkey-list">
        <div v-for="item in passkeys" :key="item.id" class="passkey-row" data-testid="passkey-row">
          <div>
            <div class="passkey-id">{{ item.credential_id.slice(0, 14) }}…</div>
            <div class="passkey-meta">Created {{ formatTimestamp(item.created_at) }}</div>
            <div class="passkey-meta">{{ formatTimestamp(item.last_used_at) }}</div>
          </div>
          <button class="btn-red" type="button" :disabled="passkeyBusy" @click="deletePasskey(item.id)">Delete</button>
        </div>
      </div>

      <div v-if="passkeyError" class="passkey-error">{{ passkeyError }}</div>
    </div>
  </div>

  <div
    v-if="passwordModalOpen"
    class="passkey-backdrop"
    data-testid="password-backdrop"
    @click.self="closePasswordModal()"
  >
    <div class="passkey-modal" data-testid="password-modal">
      <div class="passkey-header">
        <h3>Change Password</h3>
        <button class="btn-ghost" type="button" :disabled="passwordBusy" @click="closePasswordModal()">Close</button>
      </div>
      <p class="passkey-copy">Update your account password. You can also sign out every device after changing it.</p>

      <div class="field">
        <label for="current-password">Current Password</label>
        <input id="current-password" v-model="currentPassword" type="password" autocomplete="current-password" />
      </div>
      <div class="field">
        <label for="new-password">New Password</label>
        <input id="new-password" v-model="nextPassword" type="password" autocomplete="new-password" />
      </div>
      <div class="field">
        <label for="confirm-password">Confirm New Password</label>
        <input id="confirm-password" v-model="confirmPassword" type="password" autocomplete="new-password" />
      </div>
      <label class="password-checkbox">
        <input v-model="logoutAllAfterPasswordChange" type="checkbox" :disabled="passwordBusy" />
        Logout all devices after password change
      </label>
      <button class="btn-primary passkey-add-btn" type="button" :disabled="passwordBusy" @click="submitPasswordChange">
        {{ passwordBusy ? 'Updating…' : 'Update Password' }}
      </button>
      <div v-if="passwordError" class="passkey-error" data-testid="password-error">{{ passwordError }}</div>
    </div>
  </div>
</template>

<style scoped>
.settings-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-3); }
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
.passkey-id {
  color: var(--text2);
  font-size: var(--fs-sm);
}
.passkey-meta {
  color: var(--text2);
  font-size: var(--fs-xs);
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
