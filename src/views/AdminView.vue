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
import { useNotificationStore } from '../stores/notifications'

const router = useRouter()
const notifications = useNotificationStore()
const tabs = ['Overview', 'Users', 'Uploads', 'Settings', 'Webhooks', 'Audit'] as const
type AdminTab = typeof tabs[number]

const tab = ref<AdminTab>('Overview')
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
const settingsForm = ref({ app_name: '', public_title: '', registration_enabled: true, storage_warning_bytes: 0 })
const filterOwner = ref('')
const filterText = ref('')
const filterExpired = ref<'all' | 'expired' | 'active'>('all')

const currentUser = getAuthUsername()
const filteredUploads = computed(() => uploads.value.filter((upload) => {
  const ownerOk = !filterOwner.value || upload.owner === filterOwner.value
  const text = filterText.value.trim().toLowerCase()
  const textOk = !text || upload.path.toLowerCase().includes(text) || (upload.content_type ?? '').toLowerCase().includes(text)
  const expiryOk = filterExpired.value === 'all' || (filterExpired.value === 'expired' ? upload.expired : !upload.expired)
  return ownerOk && textOk && expiryOk
}))

function ts(value: number | null | undefined): string {
  if (!value) return '—'
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
      registration_enabled: nextSettings.registration_enabled !== 'false',
      storage_warning_bytes: Number(nextSettings.storage_warning_bytes ?? 0) || 0,
    }
  } catch (e: any) {
    error.value = e.message ?? 'Could not load admin data'
  } finally {
    loading.value = false
  }
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

async function createUser() {
  await runAction(async () => {
    const created = await adminCreateUser({
      username: newUser.value.username.trim(),
      password: newUser.value.password,
      upload_token: newUser.value.upload_token.trim() || undefined,
      is_admin: newUser.value.is_admin,
    })
    window.alert(`Upload token for ${created.username}:\n${created.upload_token}`)
    newUser.value = { username: '', password: '', upload_token: '', is_admin: false }
  }, 'User created')
}

async function rotateToken(username: string) {
  await runAction(async () => {
    const result = await adminRotateUserToken(username)
    window.alert(`New token:\n${result.upload_token}`)
  }, 'Token rotated')
}

function toggleSelection(path: string, checked: boolean) {
  const next = new Set(selectedUploads.value)
  if (checked) next.add(path)
  else next.delete(path)
  selectedUploads.value = next
}

onMounted(refreshAll)
</script>

<template>
  <main class="admin-layout">
    <header class="admin-header">
      <div>
        <p class="eyebrow">Administrator</p>
        <h1>Admin panel</h1>
        <p class="subtle">Signed in as {{ currentUser }}</p>
      </div>
      <div class="header-actions">
        <button class="btn-ghost" type="button" @click="router.push('/files')">Files</button>
        <button class="btn-red" type="button" @click="authLogout(); router.push('/login')">Logout</button>
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
      </div>
    </section>

    <section v-if="tab === 'Users'" class="stack">
      <form class="card form-grid" @submit.prevent="createUser">
        <h2>Create user</h2>
        <input v-model="newUser.username" placeholder="username" />
        <input v-model="newUser.password" type="password" placeholder="password" />
        <input v-model="newUser.upload_token" placeholder="custom upload token (optional)" />
        <label class="inline-check"><input v-model="newUser.is_admin" type="checkbox" /> administrator</label>
        <button class="btn-orange" type="submit">Create user</button>
      </form>

      <div class="card">
        <h2>Users</h2>
        <table class="file-table admin-table">
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Uploads</th><th>Storage</th><th>Actions</th></tr></thead>
          <tbody>
            <tr v-for="user in users" :key="user.username">
              <td>{{ user.username }}<div class="subtle">token {{ user.upload_token_preview }}</div></td>
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
      </div>
    </section>

    <section v-if="tab === 'Uploads'" class="stack">
      <div class="card filters">
        <select v-model="filterOwner">
          <option value="">All owners</option>
          <option v-for="user in users" :key="user.username" :value="user.username">{{ user.username }}</option>
        </select>
        <select v-model="filterExpired">
          <option value="all">All expiry states</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
        </select>
        <input v-model="filterText" placeholder="filter path or type" />
        <button class="btn-red" type="button" :disabled="selectedUploads.size === 0" @click="runAction(() => adminBulkDeleteUploads(Array.from(selectedUploads), confirmText('Type PURGE UPLOADS') ?? ''), 'Selected uploads deleted')">Delete selected</button>
        <button class="btn-red" type="button" @click="runAction(() => adminPurgeExpired(confirmText('Type PURGE EXPIRED') ?? ''), 'Expired uploads purged')">Purge expired</button>
      </div>
      <div class="card">
        <table class="file-table admin-table">
          <thead><tr><th></th><th>Path</th><th>Owner</th><th>Size</th><th>Created</th><th>Expires</th><th>Actions</th></tr></thead>
          <tbody>
            <tr v-for="upload in filteredUploads" :key="upload.path">
              <td><input type="checkbox" :checked="selectedUploads.has(upload.path)" @change="toggleSelection(upload.path, ($event.target as HTMLInputElement).checked)" /></td>
              <td>{{ upload.path }}</td>
              <td>{{ upload.owner ?? 'anonymous' }}</td>
              <td>{{ formatBytes(upload.size_bytes) }}</td>
              <td>{{ ts(upload.created_at) }}</td>
              <td>{{ upload.expired ? 'expired' : ts(upload.expires_at) }}</td>
              <td><button class="btn-red" type="button" @click="runAction(() => adminDeleteUpload(upload.path), 'Upload deleted')">Delete</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="tab === 'Settings'" class="card form-grid">
      <h2>Safe global settings</h2>
      <label>App name<input v-model="settingsForm.app_name" /></label>
      <label>Public title<input v-model="settingsForm.public_title" /></label>
      <label>Storage warning bytes<input v-model.number="settingsForm.storage_warning_bytes" type="number" min="0" /></label>
      <label class="inline-check"><input v-model="settingsForm.registration_enabled" type="checkbox" /> registration enabled</label>
      <button class="btn-orange" type="button" @click="runAction(() => adminUpdateSettings(settingsForm), 'Settings updated')">Save settings</button>
      <p class="subtle">Secrets are never displayed here. Sensitive values must be replaced through server-side configuration.</p>
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
            <tr v-for="hook in webhooks" :key="hook.id">
              <td>{{ hook.url }}<div class="subtle">{{ hook.events.join(', ') }}</div></td>
              <td>{{ hook.enabled ? 'enabled' : 'disabled' }}</td>
              <td>{{ hook.secret_configured ? `secret ${hook.secret_preview}` : 'unsigned' }}</td>
              <td class="actions">
                <button class="btn-ghost" type="button" @click="runAction(() => adminUpdateWebhook(hook.id, { enabled: !hook.enabled }), 'Webhook updated')">{{ hook.enabled ? 'Disable' : 'Enable' }}</button>
                <button class="btn-ghost" type="button" @click="runAction(() => adminTestWebhook(hook.id), 'Webhook test queued')">Test</button>
                <button class="btn-red" type="button" @click="runAction(() => adminDeleteWebhook(hook.id), 'Webhook deleted')">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <h2>Recent deliveries</h2>
        <table class="file-table admin-table">
          <tbody>
            <tr v-for="delivery in deliveries" :key="delivery.id">
              <td>{{ ts(delivery.created_at) }}</td><td>{{ delivery.event }}</td><td>{{ delivery.status }}</td><td>{{ delivery.error ?? delivery.status_code ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="tab === 'Audit'" class="card">
      <h2>Audit log</h2>
      <table class="file-table admin-table">
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Status</th><th>Reason</th></tr></thead>
        <tbody>
          <tr v-for="entry in audit" :key="entry.id">
            <td>{{ ts(entry.created_at) }}</td><td>{{ entry.actor ?? 'system' }}</td><td>{{ entry.action }}</td><td>{{ entry.target ?? '—' }}</td><td>{{ entry.status }}</td><td>{{ entry.reason ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </main>
</template>

<style scoped>
.admin-layout {
  max-width: 1180px;
  width: 100%;
  margin: 0 auto;
  padding: 18px 16px 40px;
}
.admin-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 16px;
}
.header-actions, .actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.eyebrow {
  color: var(--accent);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1, h2 {
  color: var(--text);
  font-weight: 400;
}
h1 { font-size: 18px; }
h2 { font-size: 13px; margin-bottom: 10px; }
.subtle {
  color: var(--text3);
  font-size: 11px;
}
.admin-tabs {
  margin: 0 auto 16px;
  max-width: 100%;
  overflow-x: auto;
}
.admin-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.metric {
  display: grid;
  gap: 6px;
}
.metric span {
  color: var(--text2);
  font-size: 11px;
}
.metric strong {
  color: var(--text);
  font-size: 20px;
  font-weight: 400;
}
.wide {
  grid-column: 1 / -1;
}
.stack {
  display: grid;
  gap: 12px;
}
.form-grid {
  display: grid;
  gap: 10px;
}
.form-grid label {
  display: grid;
  gap: 5px;
  color: var(--text2);
  font-size: 11px;
}
.inline-check {
  display: flex !important;
  align-items: center;
  gap: 8px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
select {
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  color: var(--text);
  font-family: var(--font);
  padding: 6px 10px;
}
.admin-table {
  min-width: 720px;
}
.card {
  overflow-x: auto;
}
.error-box {
  border: 1px solid var(--error-border);
  background: var(--danger-bg);
  color: var(--red-h);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin-bottom: 12px;
}
.danger-card {
  border-color: var(--error-border);
}
@media (max-width: 760px) {
  .admin-layout { padding-top: 14px; }
  .admin-header { flex-direction: column; }
  .admin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tabs button { padding: 6px 16px; }
}
@media (max-width: 480px) {
  .admin-grid { grid-template-columns: 1fr; }
}
</style>
