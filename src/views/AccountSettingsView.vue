<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  authChangePassword,
  authLogoutAllDevices,
  authLogout,
  authMe,
  getAuthUsername,
  isAuthAdmin,
} from '../lib/api'
import { AVATAR_COLORS, readAvatarImage, useAvatar } from '../lib/avatar'
import { useNotificationStore } from '../stores/notifications'
import { usePublicSettings } from '../lib/publicSettings'
import AvatarTile from '../components/AvatarTile.vue'

const router = useRouter()
const notificationStore = useNotificationStore()
const { appName } = usePublicSettings()
const { avatarPrefs, save: saveAvatar } = useAvatar()

const username = getAuthUsername()
const isAdmin = isAuthAdmin()
const memberSince = ref('')

// Password change
const currentPassword = ref('')
const nextPassword = ref('')
const confirmPassword = ref('')
const passwordBusy = ref(false)
const passwordError = ref('')
const passwordChanged = ref(false)
const confirmLogout = ref(false)

// Picture upload
const avatarBusy = ref(false)
const avatarError = ref('')
const avatarInput = ref<HTMLInputElement | null>(null)
const avatarColor = computed(() => avatarPrefs.value.color)

function setColor(color: string) {
  saveAvatar({ ...avatarPrefs.value, color })
}

async function onAvatarFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  avatarBusy.value = true
  avatarError.value = ''
  try {
    const image = await readAvatarImage(file)
    saveAvatar({ ...avatarPrefs.value, image })
    notificationStore.push('Profile picture updated')
  } catch (e: any) {
    avatarError.value = e?.message ?? 'Could not read that image'
  } finally {
    avatarBusy.value = false
  }
}

function removePicture() {
  saveAvatar({ ...avatarPrefs.value, image: null })
}

async function changePassword() {
  passwordError.value = ''
  if (nextPassword.value.length < 6) {
    passwordError.value = 'New password must be at least 6 characters.'
    return
  }
  if (nextPassword.value !== confirmPassword.value) {
    passwordError.value = 'New passwords do not match.'
    return
  }
  if (nextPassword.value === currentPassword.value) {
    passwordError.value = 'New password must be different from the current one.'
    return
  }
  passwordBusy.value = true
  try {
    await authChangePassword(currentPassword.value, nextPassword.value)
    passwordChanged.value = true
    currentPassword.value = ''
    nextPassword.value = ''
    confirmPassword.value = ''
    notificationStore.push('Password changed')
  } catch (e: any) {
    passwordError.value = e?.message ?? 'Could not change password'
  } finally {
    passwordBusy.value = false
  }
}

async function logoutAllDevices() {
  try {
    await authLogoutAllDevices()
    notificationStore.push('Logged out of all other devices')
  } catch (e: any) {
    notificationStore.push(e?.message ?? 'Could not log out other devices', 'error')
  }
}

function logout() {
  authLogout()
  void router.push('/login')
}

function requestLogout() {
  confirmLogout.value = true
}

function cancelLogout() {
  confirmLogout.value = false
}

onMounted(async () => {
  try {
    const me = (await authMe()) as { created_at?: number }
    if (me?.created_at) {
      memberSince.value = new Date(me.created_at * 1000).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
      })
    }
  } catch {
    // Non-fatal: the page simply omits the member-since line.
  }
})
</script>

<template>
  <div class="account-view" data-testid="account-page">
    <header class="page-header">
      <div>
        <h1>Account</h1>
        <p>Manage your profile picture, password, and sessions.</p>
      </div>
    </header>

    <div class="account-grid">
      <div class="card account-card">
        <div class="profile-card">
          <AvatarTile :name="username" :prefs="avatarPrefs" size="lg" />
          <div class="profile-meta">
            <span class="profile-name">{{ username }}</span>
            <span class="profile-role">{{ isAdmin ? 'Administrator' : 'Member' }}</span>
            <span v-if="memberSince" class="profile-since">Member since {{ memberSince }}</span>
          </div>
        </div>

        <div class="divider" aria-hidden="true"></div>

        <section class="account-section" aria-label="Profile picture">
          <div class="section-heading">
            <label>Profile picture</label>
            <button
              v-if="avatarPrefs.image"
              class="btn-ghost btn-xs"
              type="button"
              data-testid="account-avatar-remove"
              @click="removePicture"
            >Remove</button>
          </div>
          <div class="picture-row">
            <AvatarTile :name="username" :prefs="avatarPrefs" size="lg" />
            <div class="picture-actions">
              <button
                class="btn-primary"
                type="button"
                data-testid="account-avatar-upload"
                :disabled="avatarBusy"
                @click="avatarInput?.click()"
              >
                {{ avatarBusy ? 'Processing…' : avatarPrefs.image ? 'Change picture' : 'Upload picture' }}
              </button>
              <p class="field-hint">Square images work best. It is resized to 128×128 and stored in this browser.</p>
            </div>
            <input
              ref="avatarInput"
              type="file"
              accept="image/*"
              class="visually-hidden"
              data-testid="account-avatar-file"
              @change="onAvatarFile"
            />
          </div>
          <p v-if="avatarError" class="account-error" role="alert">{{ avatarError }}</p>
          <div class="avatar-color-grid" role="group" aria-label="Choose a background color">
            <button
              v-for="color in AVATAR_COLORS"
              :key="color"
              type="button"
              class="avatar-color"
              :class="{ active: avatarColor === color }"
              :style="{ background: color }"
              :aria-label="'Avatar color ' + color"
              :aria-pressed="avatarColor === color"
              :data-testid="'account-avatar-color-' + color.slice(1)"
              @click="setColor(color)"
            />
          </div>
          <p class="field-hint">Used behind the picture and when no picture is set.</p>
        </section>
      </div>

      <div class="card account-card">
        <section class="account-section" aria-label="Change password">
          <div class="section-heading">
            <label>Change password</label>
          </div>
          <div v-if="passwordChanged" class="account-success" data-testid="account-password-success">
            Password updated.
          </div>
          <div class="field">
            <label for="account-current-password">Current password</label>
            <input
              id="account-current-password"
              v-model="currentPassword"
              type="password"
              autocomplete="current-password"
              data-testid="account-current-password"
            />
          </div>
          <div class="field">
            <label for="account-new-password">New password</label>
            <input
              id="account-new-password"
              v-model="nextPassword"
              type="password"
              autocomplete="new-password"
              data-testid="account-new-password"
            />
          </div>
          <div class="field">
            <label for="account-confirm-password">Confirm new password</label>
            <input
              id="account-confirm-password"
              v-model="confirmPassword"
              type="password"
              autocomplete="new-password"
              data-testid="account-confirm-password"
            />
          </div>
          <p v-if="passwordError" class="account-error" role="alert">{{ passwordError }}</p>
          <button
            class="btn-primary panel-full"
            type="button"
            :disabled="passwordBusy || !currentPassword || !nextPassword || !confirmPassword"
            data-testid="account-change-password"
            @click="changePassword"
          >
            {{ passwordBusy ? 'Changing…' : 'Update password' }}
          </button>
        </section>

        <div class="divider" aria-hidden="true"></div>

        <section class="account-section" aria-label="Sessions">
          <div class="section-heading">
            <label>Sessions</label>
          </div>
          <button
            class="btn-ghost panel-full"
            type="button"
            data-testid="account-logout-all"
            @click="logoutAllDevices"
          >
            Log out all other devices
          </button>
        </section>

        <div class="account-footer">
          <button class="btn-red panel-full" type="button" data-testid="account-logout" @click="requestLogout">
            Log out
          </button>
        </div>
      </div>
    </div>

    <div v-if="confirmLogout" class="confirm-backdrop" data-testid="account-logout-confirm" @click.self="cancelLogout">
      <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="account-logout-title">
        <div class="confirm-icon" aria-hidden="true">!</div>
        <div class="confirm-header">
          <strong id="account-logout-title">Log out of {{ appName }}?</strong>
          <button class="btn-ghost confirm-close" type="button" aria-label="Close confirmation" @click="cancelLogout">✕</button>
        </div>
        <p class="confirm-message">You'll need to sign in again to upload files and manage your account.</p>
        <div class="confirm-actions">
          <button class="btn-ghost" type="button" data-testid="account-logout-confirm-cancel" @click="cancelLogout">Cancel</button>
          <button class="btn-red" type="button" data-testid="account-logout-confirm-submit" @click="logout">Log out</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.account-view {
  width: 100%;
}
.account-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
  align-items: start;
}
.page-header {
  display: grid;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
}
.page-header h1 {
  color: var(--text);
  font-size: var(--fs-display);
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: var(--lh-tight);
  margin: 0;
}
.page-header p {
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  margin: 0;
}
.account-card {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-5);
  border-radius: var(--radius-lg);
  box-shadow: 0 18px 42px color-mix(in srgb, var(--shadow) 24%, transparent);
  min-width: 0;
}
.profile-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg2);
}
.profile-meta {
  min-width: 0;
  display: grid;
  gap: 1px;
  line-height: 1.25;
}
.profile-name {
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-h2);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-role {
  color: var(--accent);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.profile-since {
  color: var(--text3);
  font-size: var(--fs-xs);
}
.divider {
  height: 1px;
  background: var(--border);
}
.account-section {
  display: grid;
  gap: var(--space-2);
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-heading label {
  color: var(--text2);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.btn-xs {
  min-height: 28px;
  padding: 2px 10px;
  font-size: var(--fs-xs);
}
.picture-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.picture-actions {
  min-width: 0;
  display: grid;
  gap: var(--space-1);
}
.field-hint {
  color: var(--text2);
  font-size: var(--fs-xs);
  line-height: var(--lh-body);
}
.avatar-color-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.avatar-color {
  width: 28px;
  height: 28px;
  min-height: 28px;
  padding: 0;
  border: 2px solid var(--bg1);
  border-radius: 50%;
  box-shadow: 0 0 0 1px var(--border);
}
.avatar-color:hover {
  transform: scale(1.08);
}
.avatar-color.active {
  box-shadow: 0 0 0 2px var(--bg1), 0 0 0 4px color-mix(in srgb, var(--accent) 55%, transparent);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.field label {
  color: var(--text2);
  font-size: var(--fs-xs);
}
.field input {
  width: 100%;
  font-size: var(--fs-sm);
}
.panel-full {
  width: 100%;
}
.account-error {
  color: var(--red-h);
  font-size: var(--fs-xs);
  line-height: var(--lh-body);
}
.account-success {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--success-border);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--green) 10%, transparent);
  color: var(--green);
  font-size: var(--fs-xs);
}
.account-footer {
  display: grid;
  gap: var(--space-2);
}
.confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--modal-bg);
}
.confirm-dialog {
  position: relative;
  width: min(440px, calc(100vw - 24px));
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg);
  background: var(--bg1);
  padding: var(--space-5);
  box-shadow: 0 24px 64px color-mix(in srgb, var(--shadow) 90%, transparent);
}
.confirm-icon {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--red) 55%, var(--border));
  border-radius: var(--radius-full);
  color: var(--red-h);
  background: var(--danger-bg);
  font-weight: 700;
}
.confirm-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding-right: var(--space-6);
}
.confirm-header strong {
  color: var(--text);
  font-size: var(--fs-h2);
  font-weight: 600;
  line-height: var(--lh-tight);
}
.confirm-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  min-height: 28px;
  padding: 0;
  font-size: var(--fs-sm);
  border: 0;
  background: transparent;
  color: var(--text3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius);
}
.confirm-close:hover {
  background: var(--bg2);
  color: var(--text);
}
.confirm-message {
  margin-top: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (max-width: 480px) {
  .picture-row {
    align-items: flex-start;
    flex-direction: column;
  }
}
@media (max-width: 860px) {
  .account-grid {
    grid-template-columns: 1fr;
  }
}
</style>
