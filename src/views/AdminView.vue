<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  adminAuditLog,
  adminBulkDeleteUploads,
  adminCreateUser,
  adminCreateWebhook,
  adminDashboard,
  adminDeleteUpload,
  adminDeleteUser,
  adminDeleteWebhook,
  adminPurgeExpired,
  adminPurgeUserUploads,
  adminRotateUserToken,
  adminSettings,
  adminTestWebhook,
  adminUpdateSettings,
  adminUpdateUser,
  adminUpdateWebhook,
  adminUploads,
  adminUsers,
  adminWebhookDeliveries,
  adminWebhooks,
  authLogout,
  formatBytes,
  getAuthUsername,
  type AdminAuditEntry,
  type AdminDashboard,
  type AdminSettings,
  type AdminUpload,
  type AdminUser,
  type AdminWebhook,
  type WebhookDelivery,
} from '../lib/api'
import SettingsPanel from '../components/SettingsPanel.vue'
import AppSidebar from '../components/AppSidebar.vue'
import CustomSelect, { type SelectOption } from '../components/CustomSelect.vue'
import { useNotificationStore } from '../stores/notifications'
import { usePublicSettings } from '../lib/publicSettings'

const router = useRouter()
const notifications = useNotificationStore()
const tabs = ['Overview', 'Users', 'Uploads', 'Settings', 'Webhooks', 'Audit'] as const
type AdminTab = typeof tabs[number]

const tab = ref<AdminTab>('Overview')
const showSettings = ref(false)
const loading = ref(false)
const error = ref('')
const dashboard = ref<AdminDashboard | null>(null)
const users = ref<AdminUser[]>([])
const uploads = ref<AdminUpload[]>([])
const selectedUploads = ref<Set<string>>(new Set())
const settings = ref<AdminSettings>({})
const webhooks = ref<AdminWebhook[]>([])
const deliveries = ref<WebhookDelivery[]>([])
const audit = ref<AdminAuditEntry[]>([])

const newUser = ref({ username: '', password: '', upload_token: '', is_admin: false })
const webhookForm = ref({ url: '', events: 'file.uploaded,file.deleted', secret: '', enabled: true })
const settingsForm = ref({ app_name: '', public_title: '', base_api_url: '', registration_enabled: true, storage_warning_bytes: 0 })
const filterOwner = ref('')
const filterText = ref('')
const filterExpired = ref<'all' | 'expired' | 'active'>('all')
const PAGE_SIZE = 10
const pageByTab = ref<Record<string, number>>({
  Users: 1,
  Uploads: 1,
  Webhooks: 1,
  Audit: 1,
})


const currentUser = getAuthUsername()
const { refreshPublicSettings } = usePublicSettings()
const SIDEBAR_COLLAPSED_KEY = 'yp_sidebar_collapsed_v2'
const sidebarCollapsed = ref(
  typeof window !== 'undefined' && window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
)
const ownerFilterOptions = computed<SelectOption[]>(() => [
  { value: '', label: 'All owners', hint: 'Every upload source' },
  ...users.value.map((user) => ({
    value: user.username,
    label: user.username,
    hint: user.is_admin ? 'Administrator' : 'User',
  })),
])
const expiryFilterOptions: SelectOption[] = [
  { value: 'all', label: 'All expiry states', hint: 'Active and expired' },
  { value: 'active', label: 'Active', hint: 'Still available' },
  { value: 'expired', label: 'Expired', hint: 'Ready to purge' },
]
const filteredUploads = computed(() => uploads.value.filter((upload) => {
  const ownerOk = !filterOwner.value || upload.owner === filterOwner.value
  const text = filterText.value.trim().toLowerCase()
  const textOk = !text || upload.path.toLowerCase().includes(text) || (upload.content_type ?? '').toLowerCase().includes(text)
  const expiryOk = filterExpired.value === 'all' || (filterExpired.value === 'expired' ? upload.expired : !upload.expired)
  return ownerOk && textOk && expiryOk
}))
const pagedUsers = computed(() => paginate(users.value, 'Users'))
const pagedUploads = computed(() => paginate(filteredUploads.value, 'Uploads'))
const pagedWebhooks = computed(() => paginate(webhooks.value, 'Webhooks'))
const pagedAudit = computed(() => paginate(audit.value, 'Audit'))
const usersPageCount = computed(() => pageCount(users.value.length))
const uploadsPageCount = computed(() => pageCount(filteredUploads.value.length))
const webhooksPageCount = computed(() => pageCount(webhooks.value.length))
const auditPageCount = computed(() => pageCount(audit.value.length))

function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE))
}

function pageFor(key: string, total: number): number {
  const max = pageCount(total)
  const current = pageByTab.value[key] ?? 1
  if (current > max) {
    pageByTab.value = { ...pageByTab.value, [key]: max }
    return max
  }
  if (current < 1) {
    pageByTab.value = { ...pageByTab.value, [key]: 1 }
    return 1
  }
  return current
}

function paginate<T>(items: T[], key: string): T[] {
  const page = pageFor(key, items.length)
  return items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
}

function setPage(key: string, next: number, total: number) {
  const max = pageCount(total)
  pageByTab.value = { ...pageByTab.value, [key]: Math.min(max, Math.max(1, next)) }
}

function pageLabel(key: string, total: number): string {
  if (total === 0) return 'No items'
  const page = pageFor(key, total)
  const start = (page - 1) * PAGE_SIZE + 1
  const end = Math.min(total, page * PAGE_SIZE)
  return `${start}-${end} of ${total}`
}

function ts(value: number | null | undefined): string {
  if (!value) return 'N/A'
  return new Date(value * 1000).toLocaleString()
}

function confirmText(promptText: string): string | null {
  return window.prompt(promptText) ?? null
}

async function refreshAll() {
  loading.value = true
  error.value = ''
  try {
    const [nextDashboard, nextUsers, nextUploads, nextSettings, nextWebhooks, nextDeliveries, nextAudit] = await Promise.all([
      adminDashboard(),
      adminUsers(),
      adminUploads(),
      adminSettings(),
      adminWebhooks(),
      adminWebhookDeliveries(),
      adminAuditLog(),
    ])
    dashboard.value = nextDashboard
    users.value = nextUsers
    uploads.value = nextUploads
    settings.value = nextSettings
    webhooks.value = nextWebhooks
    deliveries.value = nextDeliveries
    audit.value = nextAudit
    settingsForm.value = {
      app_name: nextSettings.app_name ?? 'yaemipaste',
      public_title: nextSettings.public_title ?? 'yaemipaste',
      base_api_url: nextSettings.base_api_url ?? '',
      registration_enabled: nextSettings.registration_enabled !== 'false',
      storage_warning_bytes: Number(nextSettings.storage_warning_bytes ?? 0) || 0,
    }
  } catch (e: any) {
    error.value = e.message ?? 'Could not load admin data'
  } finally {
    loading.value = false
  }
}

async function saveSettings() {
  await runAction(async () => {
    await adminUpdateSettings(settingsForm.value)
    await refreshPublicSettings(true)
  }, 'Settings updated')
}

async function deleteUploadWithConfirmation(path: string) {
  if (confirmText(`Type ${path} to delete this upload`) !== path) return
  await runAction(() => adminDeleteUpload(path), 'Upload deleted')
}

async function deleteWebhookWithConfirmation(hook: AdminWebhook) {
  if (confirmText(`Type ${hook.url} to delete this webhook`) !== hook.url) return
  await runAction(() => adminDeleteWebhook(hook.id), 'Webhook deleted')
}

async function runAction(work: () => Promise<unknown>, success: string) {
  try {
    await work()
    notifications.push(success, 'success')
    await refreshAll()
  } catch (e: any) {
    notifications.push(e.message ?? 'Admin action failed', 'error')
  }
}

function logout() {
  authLogout()
  router.push('/login')
}

async function createUser() {
  await runAction(async () => {
    const username = newUser.value.username.trim()
    const result = await adminCreateUser({
      username,
      password: newUser.value.password,
      upload_token: newUser.value.upload_token.trim() || undefined,
      is_admin: newUser.value.is_admin,
    })
    window.alert(`One-time upload token for ${username}:\n\n${result.upload_token}\n\nCopy it now. It will not be shown again.`)
    newUser.value = { username: '', password: '', upload_token: '', is_admin: false }
  }, 'User created')
}

async function rotateToken(username: string) {
  await runAction(async () => {
    const result = await adminRotateUserToken(username)
    window.alert(`One-time upload token for ${username}:\n\n${result.upload_token}\n\nCopy it now. It will not be shown again.`)
  }, 'Token rotated')
}

function toggleSelection(path: string, checked: boolean) {
  const next = new Set(selectedUploads.value)
  if (checked) next.add(path)
  else next.delete(path)
  selectedUploads.value = next
}

onMounted(() => {
  void refreshPublicSettings()
  void refreshAll()
})
</script>

<template>
  <div class="layout admin-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <AppSidebar
      active-tab="admin"
      :show-history="false"
      show-admin
      show-settings
      :collapsed="sidebarCollapsed"
      @update:collapsed="sidebarCollapsed = $event"
      @select-files="router.push('/files')"
      @select-admin="router.push('/admin')"
      @toggle-settings="showSettings = true"
    />

    <main class="workspace">
      <section class="admin-layout">
        <header class="admin-header">
          <div>
            <p class="eyebrow">Administrator</p>
            <h1>Admin panel</h1>
            <p class="subtle">Signed in as {{ currentUser }}</p>
          </div>
          <div class="header-actions">
            <button class="btn-ghost" type="button" @click="logout">Logout</button>
          </div>
        </header>

        <div class="tabs admin-tabs">
          <button v-for="item in tabs" :key="item" :class="{ active: tab === item }" type="button" @click="tab = item">
            {{ item }}
          </button>
        </div>

    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="loading" class="info-box">Loading admin data…</div>

    <section v-if="tab === 'Overview' && dashboard" class="admin-grid">
      <div class="metric card">
        <span>Total storage</span>
        <strong>{{ formatBytes(dashboard.total_disk_usage_bytes) }}</strong>
      </div>
      <div class="metric card">
        <span>Uploads</span>
        <strong>{{ dashboard.upload_count }}</strong>
      </div>
      <div class="metric card">
        <span>Users</span>
        <strong>{{ dashboard.user_count }}</strong>
      </div>
      <div class="metric card">
        <span>Admins</span>
        <strong>{{ dashboard.admin_count }}</strong>
      </div>
      <div v-if="dashboard.warnings.length" class="card wide danger-card">
        <h2>Warnings</h2>
        <p v-for="warning in dashboard.warnings" :key="warning">{{ warning }}</p>
      </div>
      <div class="card wide">
        <h2>Recent uploads</h2>
        <table class="file-table admin-table">
          <tbody>
            <tr v-for="upload in dashboard.recent_uploads" :key="upload.path">
              <td>{{ upload.path }}</td>
              <td>{{ upload.owner ?? 'anonymous' }}</td>
              <td>{{ formatBytes(upload.size_bytes) }}</td>
              <td>{{ ts(upload.created_at) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!dashboard.recent_uploads.length" class="empty-state">No uploads yet.</p>
      </div>
      <div class="card wide">
        <h2>Recent admin actions</h2>
        <table class="file-table admin-table">
          <tbody>
            <tr v-for="entry in dashboard.recent_audit" :key="entry.id">
              <td>{{ ts(entry.created_at) }}</td>
              <td>{{ entry.actor ?? 'system' }}</td>
              <td>{{ entry.action }}</td>
              <td>{{ entry.status }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!dashboard.recent_audit.length" class="empty-state">No administrative actions recorded yet.</p>
      </div>
    </section>

    <section v-if="tab === 'Users'" class="stack">
      <form class="card form-grid" @submit.prevent="createUser">
        <h2>Create user</h2>
        <input v-model="newUser.username" placeholder="username" />
        <input v-model="newUser.password" type="password" placeholder="password" />
        <input v-model="newUser.upload_token" type="password" placeholder="custom upload token (optional)" />
        <label class="inline-check"><input v-model="newUser.is_admin" type="checkbox" /> administrator</label>
        <button class="btn-orange" type="submit">Create user</button>
      </form>

      <div class="card">
        <h2>Users</h2>
        <table class="file-table admin-table">
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Uploads</th><th>Storage</th><th>Actions</th></tr></thead>
          <tbody>
            <tr v-for="user in pagedUsers" :key="user.username">
              <td><span>{{ user.username }}</span><div class="subtle">{{ user.upload_token_preview ? 'token configured' : 'no token' }}</div></td>
              <td>{{ user.is_admin ? 'admin' : 'user' }}</td>
              <td>{{ user.suspended_at ? `suspended ${ts(user.suspended_at)}` : 'active' }}</td>
              <td>{{ user.upload_count }}</td>
              <td>{{ formatBytes(user.disk_usage_bytes) }}</td>
              <td class="actions">
                <button class="btn-ghost" type="button" @click="runAction(() => adminUpdateUser(user.username, { suspended: !user.suspended_at, suspension_reason: 'Suspended by administrator' }), user.suspended_at ? 'User unsuspended' : 'User suspended')">
                  {{ user.suspended_at ? 'Unsuspend' : 'Suspend' }}
                </button>
                <button class="btn-ghost" type="button" @click="runAction(() => adminUpdateUser(user.username, { is_admin: !user.is_admin }), 'Role updated')">
                  {{ user.is_admin ? 'Demote' : 'Promote' }}
                </button>
                <button class="btn-ghost" type="button" @click="rotateToken(user.username)">Rotate token</button>
                <button class="btn-red" type="button" @click="runAction(() => adminPurgeUserUploads(user.username, confirmText('Type PURGE UPLOADS') ?? ''), 'Uploads purged')">Purge uploads</button>
                <button class="btn-red" type="button" @click="runAction(() => adminDeleteUser(user.username, confirmText('Type DELETE USER') ?? ''), 'User deleted')">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!pagedUsers.length && !loading" class="empty-state">No users yet.</p>
        <div class="pagination-bar" aria-label="User pagination">
          <span>{{ pageLabel('Users', users.length) }}</span>
          <div>
            <button class="btn-ghost" type="button" :disabled="pageFor('Users', users.length) <= 1" @click="setPage('Users', pageFor('Users', users.length) - 1, users.length)">Previous</button>
            <button class="btn-ghost" type="button" :disabled="pageFor('Users', users.length) >= usersPageCount" @click="setPage('Users', pageFor('Users', users.length) + 1, users.length)">Next</button>
          </div>
        </div>
      </div>
    </section>

    <section v-if="tab === 'Uploads'" class="stack">
      <div class="card filters">
        <CustomSelect v-model="filterOwner" label="Owner" :options="ownerFilterOptions" />
        <CustomSelect v-model="filterExpired" label="Expiry" :options="expiryFilterOptions" />
        <input v-model="filterText" class="filter-text" placeholder="filter path or type" aria-label="Filter uploads by path or type" />
        <div class="filter-actions">
          <button class="btn-red" type="button" :disabled="selectedUploads.size === 0" @click="runAction(() => adminBulkDeleteUploads(Array.from(selectedUploads), confirmText('Type PURGE UPLOADS') ?? ''), 'Selected uploads deleted')">Delete selected</button>
          <button class="btn-red" type="button" @click="runAction(() => adminPurgeExpired(confirmText('Type PURGE EXPIRED') ?? ''), 'Expired uploads purged')">Purge expired</button>
        </div>
      </div>
      <div class="card">
        <table class="file-table admin-table">
          <thead><tr><th aria-label="Select"></th><th>Path</th><th>Owner</th><th>Size</th><th>Created</th><th>Expires</th><th>Actions</th></tr></thead>
          <tbody>
            <tr v-for="upload in pagedUploads" :key="upload.path">
              <td><input type="checkbox" :checked="selectedUploads.has(upload.path)" :aria-label="`Select ${upload.path}`" @change="toggleSelection(upload.path, ($event.target as HTMLInputElement).checked)" /></td>
              <td>{{ upload.path }}</td>
              <td>{{ upload.owner ?? 'anonymous' }}</td>
              <td>{{ formatBytes(upload.size_bytes) }}</td>
              <td>{{ ts(upload.created_at) }}</td>
              <td>{{ upload.expired ? 'expired' : ts(upload.expires_at) }}</td>
              <td><button class="btn-red" type="button" @click="deleteUploadWithConfirmation(upload.path)">Delete</button></td>
            </tr>
          </tbody>
        </table>
        <div class="pagination-bar" aria-label="Upload pagination">
          <span>{{ pageLabel('Uploads', filteredUploads.length) }}</span>
          <div>
            <button class="btn-ghost" type="button" :disabled="pageFor('Uploads', filteredUploads.length) <= 1" @click="setPage('Uploads', pageFor('Uploads', filteredUploads.length) - 1, filteredUploads.length)">Previous</button>
            <button class="btn-ghost" type="button" :disabled="pageFor('Uploads', filteredUploads.length) >= uploadsPageCount" @click="setPage('Uploads', pageFor('Uploads', filteredUploads.length) + 1, filteredUploads.length)">Next</button>
          </div>
        </div>
      </div>
    </section>

    <section v-if="tab === 'Settings'" class="card settings-page">
      <div class="settings-intro">
        <h2>Safe global settings</h2>
        <p class="subtle">Public branding and operational limits. Secrets are never displayed here; sensitive values must be replaced through server-side configuration.</p>
      </div>

      <div class="settings-group">
        <p class="settings-group-label">Branding</p>
        <div class="settings-fields">
          <label>App name<input v-model="settingsForm.app_name" /></label>
          <label>Public title<input v-model="settingsForm.public_title" /></label>
          <label class="span-2">Base API URL<input v-model="settingsForm.base_api_url" placeholder="https://papi.example.com" /></label>
        </div>
      </div>

      <div class="settings-group">
        <p class="settings-group-label">Operational limits</p>
        <div class="settings-fields">
          <label>Storage warning bytes<input v-model.number="settingsForm.storage_warning_bytes" type="number" min="0" /></label>
          <label class="inline-check span-2"><input v-model="settingsForm.registration_enabled" type="checkbox" /> registration enabled</label>
        </div>
      </div>

      <div class="settings-footer">
        <button class="btn-orange" type="button" @click="saveSettings">Save settings</button>
      </div>
    </section>

    <section v-if="tab === 'Webhooks'" class="stack">
      <form class="card form-grid" @submit.prevent="runAction(() => adminCreateWebhook({ url: webhookForm.url, events: webhookForm.events.split(',').map(v => v.trim()).filter(Boolean), secret: webhookForm.secret || undefined, enabled: webhookForm.enabled }), 'Webhook created')">
        <h2>Create webhook</h2>
        <input v-model="webhookForm.url" placeholder="https://example.com/webhook" />
        <input v-model="webhookForm.events" placeholder="file.uploaded,file.deleted" />
        <input v-model="webhookForm.secret" type="password" placeholder="secret replacement (optional)" />
        <label class="inline-check"><input v-model="webhookForm.enabled" type="checkbox" /> enabled</label>
        <button class="btn-orange" type="submit">Create webhook</button>
      </form>
      <div class="card">
        <h2>Endpoints</h2>
        <table class="file-table admin-table">
          <tbody>
            <tr v-for="hook in pagedWebhooks" :key="hook.id">
              <td>{{ hook.url }}<div class="subtle">{{ hook.events.join(', ') }}</div></td>
              <td>{{ hook.enabled ? 'enabled' : 'disabled' }}</td>
              <td>{{ hook.secret_configured ? 'secret configured' : 'unsigned' }}</td>
              <td class="actions">
                <button class="btn-ghost" type="button" @click="runAction(() => adminUpdateWebhook(hook.id, { enabled: !hook.enabled }), 'Webhook updated')">{{ hook.enabled ? 'Disable' : 'Enable' }}</button>
                <button class="btn-ghost" type="button" @click="runAction(() => adminTestWebhook(hook.id), 'Webhook test queued')">Test</button>
                <button class="btn-red" type="button" @click="deleteWebhookWithConfirmation(hook)">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="pagination-bar" aria-label="Webhook pagination">
          <span>{{ pageLabel('Webhooks', webhooks.length) }}</span>
          <div>
            <button class="btn-ghost" type="button" :disabled="pageFor('Webhooks', webhooks.length) <= 1" @click="setPage('Webhooks', pageFor('Webhooks', webhooks.length) - 1, webhooks.length)">Previous</button>
            <button class="btn-ghost" type="button" :disabled="pageFor('Webhooks', webhooks.length) >= webhooksPageCount" @click="setPage('Webhooks', pageFor('Webhooks', webhooks.length) + 1, webhooks.length)">Next</button>
          </div>
        </div>
      </div>
      <div class="card">
        <h2>Recent deliveries</h2>
        <table class="file-table admin-table">
          <tbody>
            <tr v-for="delivery in deliveries" :key="delivery.id">
              <td>{{ ts(delivery.created_at) }}</td><td>{{ delivery.event }}</td><td>{{ delivery.status }}</td><td>{{ delivery.error ?? delivery.status_code ?? 'N/A' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!deliveries.length && !loading" class="empty-state">No webhook deliveries recorded yet.</p>
      </div>
    </section>

    <section v-if="tab === 'Audit'" class="card">
      <h2>Audit log</h2>
      <table class="file-table admin-table">
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Status</th><th>Reason</th></tr></thead>
        <tbody>
          <tr v-for="entry in pagedAudit" :key="entry.id">
            <td>{{ ts(entry.created_at) }}</td><td>{{ entry.actor ?? 'system' }}</td><td>{{ entry.action }}</td><td>{{ entry.target ?? 'N/A' }}</td><td>{{ entry.status }}</td><td>{{ entry.reason ?? 'N/A' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!pagedAudit.length && !loading" class="empty-state">No audit entries yet.</p>
      <div class="pagination-bar" aria-label="Audit pagination">
        <span>{{ pageLabel('Audit', audit.length) }}</span>
        <div>
          <button class="btn-ghost" type="button" :disabled="pageFor('Audit', audit.length) <= 1" @click="setPage('Audit', pageFor('Audit', audit.length) - 1, audit.length)">Previous</button>
          <button class="btn-ghost" type="button" :disabled="pageFor('Audit', audit.length) >= auditPageCount" @click="setPage('Audit', pageFor('Audit', audit.length) + 1, audit.length)">Next</button>
        </div>
      </div>
    </section>
      </section>
    </main>

    <div v-if="showSettings" class="settings-layer">
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
  --surface: var(--bg1);
  --surface2: var(--bg2);
  --surface3: var(--bg3);
  --accent-soft: color-mix(in srgb, var(--accent) 16%, transparent);
  background: transparent;
}
.workspace {
  min-width: 0;
  padding: var(--space-5) var(--space-5) var(--space-7);
}
.admin-layout {
  max-width: 1180px;
  width: 100%;
  margin: 0 auto;
}
.admin-header {
  position: relative;
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: flex-start;
  margin-bottom: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  box-shadow: 0 18px 36px color-mix(in srgb, var(--shadow) 18%, transparent);
}
.header-actions, .actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.eyebrow {
  color: var(--accent);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1, h2 {
  color: var(--text);
  font-weight: 600;
  line-height: var(--lh-tight);
}
h1 { font-size: var(--fs-h1); }
h2 { font-size: var(--fs-h2); margin-bottom: var(--space-2); }
.subtle {
  color: var(--text2);
  font-size: var(--fs-xs);
}
.admin-tabs {
  margin: 0 0 20px;
  max-width: 100%;
  overflow-x: auto;
  border-color: color-mix(in srgb, var(--border2) 70%, transparent);
  background: transparent;
  box-shadow: none;
}
.admin-tabs button {
  position: relative;
}
.admin-tabs button.active::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  border-radius: var(--radius-full);
  background: var(--accent);
}
.admin-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}
.metric {
  display: grid;
  gap: var(--space-2);
}
.metric span {
  color: var(--text2);
  font-size: var(--fs-xs);
}
.metric strong {
  color: var(--text);
  font-size: var(--fs-h1);
  font-weight: 600;
}
.wide {
  grid-column: 1 / -1;
}
.stack {
  display: grid;
  gap: var(--space-3);
}
.form-grid {
  display: grid;
  gap: var(--space-3);
}
.form-grid label {
  display: grid;
  gap: var(--space-1);
  color: var(--text2);
  font-size: var(--fs-xs);
}
.settings-page {
  max-width: 720px;
  display: grid;
  gap: var(--space-6);
}
.settings-intro h2 {
  margin-bottom: var(--space-1);
}
.settings-intro p {
  max-width: 56ch;
  line-height: var(--lh-body);
}
.settings-group {
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-5);
  border-top: 1px solid var(--border);
}
.settings-group-label {
  color: var(--text2);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.settings-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4) var(--space-3);
}
.settings-fields label,
.settings-fields .inline-check {
  margin: 0;
}
.span-2 {
  grid-column: 1 / -1;
}
.settings-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-2);
}
.settings-footer .btn-orange {
  min-width: 160px;
}
.inline-check {
  display: flex !important;
  align-items: center;
  gap: var(--space-2);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}
.filter-text {
  flex: 1 1 220px;
  min-height: 44px;
}
.filter-actions {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
}
.admin-table {
  min-width: 720px;
  font-size: var(--fs-body);
}
.card {
  overflow-x: auto;
  border-radius: var(--radius-md);
  padding: var(--space-5);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  box-shadow: 0 16px 32px color-mix(in srgb, var(--shadow) 12%, transparent);
}
.error-box {
  border: 1px solid var(--error-border);
  background: var(--danger-bg);
  color: var(--red-h);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-3);
  font-size: var(--fs-body);
}
:root[data-theme="light"] .error-box {
  color: var(--red);
}
.info-box {
  margin-bottom: var(--space-3);
  background: color-mix(in srgb, var(--surface) 86%, transparent);
}
.danger-card {
  position: relative;
  border-color: var(--error-border);
}
.danger-card p + p {
  margin-top: var(--space-1);
}
.admin-layout input:not([type="checkbox"]) {
  transition: border-color var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.admin-layout input:not([type="checkbox"]):hover:not(:disabled) {
  border-color: var(--text3);
}
.admin-layout input:not([type="checkbox"]):active:not(:disabled) {
  transform: scale(0.98);
}
.admin-layout input[type="checkbox"] {
  cursor: pointer;
  transition: transform var(--duration-fast) var(--ease-out);
}
.admin-layout input[type="checkbox"]:hover:not(:disabled) {
  transform: scale(1.12);
}
.admin-layout input[type="checkbox"]:active:not(:disabled) {
  transform: scale(0.92);
}
.admin-layout button:not(:disabled) {
  transition: transform var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.admin-layout button:not(:disabled):hover {
  transform: translateY(-1px);
}
.admin-layout button:not(:disabled):active {
  transform: translateY(0) scale(0.96);
}
.empty-state {
  padding: var(--space-4) 0 0;
  color: var(--text3);
  font-size: var(--fs-body);
  text-align: center;
}
.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
  color: var(--text2);
  font-size: var(--fs-small);
}
.pagination-bar > div {
  display: flex;
  gap: var(--space-2);
}
.pagination-bar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
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
  z-index: 0;
  pointer-events: auto;
}
.settings-layer :deep(.settings-panel) {
  pointer-events: auto;
  z-index: 1;
  left: 82px;
  right: auto;
  top: auto;
  bottom: 18px;
  width: min(380px, calc(100vw - 108px));
  max-height: calc(100dvh - 36px);
  overflow: auto;
}
@media (max-width: 760px) {
  .workspace { padding: var(--space-4); }
  .admin-header { flex-direction: column; }
  .admin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tabs button { padding: var(--space-2) var(--space-4); }
}
@media (max-width: 600px) {
  .layout {
    display: block;
  }
  .filter-text,
  .filter-actions {
    width: 100%;
    margin-left: 0;
  }
  .filter-actions button {
    flex: 1;
  }
  .settings-fields {
    grid-template-columns: 1fr;
  }
  .workspace {
    padding: var(--space-3) var(--space-3) 104px;
  }
  .admin-header {
    padding: var(--space-4);
  }
  .admin-tabs {
    width: 100%;
  }
  .header-actions {
    width: 100%;
  }
  .header-actions button {
    flex: 1;
  }
  .admin-layout button,
  .admin-layout select,
  .admin-layout input:not([type="checkbox"]) {
    min-height: 40px;
  }
  .admin-layout input[type="checkbox"] {
    width: 20px;
    height: 20px;
  }
  .admin-table td,
  .admin-table th {
    padding: var(--space-2) var(--space-3);
  }
  .settings-layer :deep(.settings-panel) {
    left: 12px;
    right: 12px;
    bottom: 88px;
    width: auto;
    max-height: calc(100dvh - 118px);
  }
}
@media (max-width: 480px) {
  .admin-grid { grid-template-columns: 1fr; }
}
</style>
