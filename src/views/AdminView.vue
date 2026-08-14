<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  adminBulkDeleteUploads,
  adminUploadContentUrl,
  adminCreateRegistrationToken,
  adminClearRegistrationTokenHistory,
  adminCreateUser,
  adminListRegistrationTokens,
  adminRevokeRegistrationToken,
  adminCreateWebhook,
  adminDeleteUpload,
  adminDeleteUser,
  adminDeleteWebhook,
  adminPurgeExpired,
  adminPurgeUserUploads,
  adminRotateUserToken,
  adminTestWebhook,
  adminUploads,
  adminUpdateSettings,
  adminUpdateUser,
  adminUpdateWebhook,
  authLogout,
  displayUploaderName,
  formatBytes,
  formatGigabytes,
  formatTimestamp,
  getAuthUsername,
  fileUrl,
  publicDownloadUrl,
  publicPreviewUrl,
  type AdminAuditEntry,
  type AdminDashboard,
  type AdminSettings,
  type AdminRegistrationToken,
  type AdminUpload,
  type AdminUser,
  type AdminWebhook,
  type PasteFile,
  type WebhookDelivery,
} from '../lib/api'
import ActionConfirmDialog from '../components/ActionConfirmDialog.vue'
import FilePreview from '../components/FilePreview.vue'
import CustomSelect, { type SelectOption } from '../components/CustomSelect.vue'
import { useNotificationStore } from '../stores/notifications'
import { usePublicSettings } from '../lib/publicSettings'
import { loadAdminData, peekAdminData, updateCachedAdminUploads } from '../lib/adminData'
import sharexLogoUrl from '../assets/sharex-logo-white-transparent.png'

const router = useRouter()
const route = useRoute()
const notifications = useNotificationStore()
const tabs = ['Overview', 'Users', 'Uploads', 'Settings', 'Webhooks', 'Audit'] as const
type AdminTab = typeof tabs[number]
const ADMIN_UPLOAD_REFRESH_MS = 2_000
type ConfirmationRequest = {
  title: string
  message: string
  detail?: string
  confirmLabel: string
  success: string
  work: () => Promise<unknown>
}
type UploadHoverPreview = {
  upload: AdminUpload
  x: number
  y: number
}

const tab = ref<AdminTab>('Overview')
const adminTabsScroll = ref<HTMLElement | null>(null)
const adminTabsCanScrollLeft = ref(false)
const adminTabsCanScrollRight = ref(false)
const adminTabsHasOverflow = computed(() => adminTabsCanScrollLeft.value || adminTabsCanScrollRight.value)
const confirmationRequest = ref<ConfirmationRequest | null>(null)
const confirmationAcknowledged = ref(false)
const confirmationBusy = ref(false)
const tokenDialog = ref<{ username: string; token: string; kind: 'upload' | 'registration'; expiresAt: number | null } | null>(null)
const tokenCopied = ref(false)
const copiedUploadPath = ref<string | null>(null)
let copiedUploadTimer: ReturnType<typeof setTimeout> | null = null
const createMode = ref<'user' | 'token'>('user')
const newRegistrationToken = ref({ label: '', ttl_seconds: '86400' })
const registrationTokens = ref<AdminRegistrationToken[]>([])
const registrationTokensLoading = ref(false)
const registrationExpiryOpen = ref(false)
const registrationExpiryPicker = ref<HTMLElement | null>(null)
const registrationTokenExpiryOptions = [
  { value: '3600', label: '1 hour' },
  { value: '86400', label: '24 hours' },
  { value: '604800', label: '7 days' },
  { value: '2592000', label: '30 days' },
  { value: '0', label: 'Never' },
]
const selectedRegistrationExpiry = computed(() => (
  registrationTokenExpiryOptions.find((option) => option.value === newRegistrationToken.value.ttl_seconds)
  ?? registrationTokenExpiryOptions[0]
))
const activeRegistrationTokenCount = computed(() => registrationTokens.value.filter((token) => token.status === 'available').length)
const hasRegistrationTokenHistory = computed(() => registrationTokens.value.some((token) => token.status !== 'available'))
const initialAdminData = peekAdminData()
const loading = ref(!initialAdminData)
const error = ref('')
const dashboard = ref<AdminDashboard | null>(initialAdminData?.dashboard ?? null)
const users = ref<AdminUser[]>(initialAdminData?.users ?? [])
const uploads = ref<AdminUpload[]>(initialAdminData?.uploads ?? [])
const selectedUploads = ref<Set<string>>(new Set())
const settings = ref<AdminSettings>(initialAdminData?.settings ?? {})
const webhooks = ref<AdminWebhook[]>(initialAdminData?.webhooks ?? [])
const deliveries = ref<WebhookDelivery[]>(initialAdminData?.deliveries ?? [])
const audit = ref<AdminAuditEntry[]>(initialAdminData?.audit ?? [])
let refreshSequence = 0
let uploadsRefreshSequence = 0
let registrationTokensSequence = 0
let uploadsRefreshTimer: ReturnType<typeof setInterval> | null = null

function tabFromRoute(): AdminTab {
  const section = String(route.params.section ?? '').toLowerCase()
  return tabs.find((item) => item.toLowerCase() === section) ?? 'Overview'
}

function selectTab(nextTab: AdminTab) {
  const path = nextTab === 'Overview' ? '/admin' : `/admin/${nextTab.toLowerCase()}`
  if (route.path !== path) void router.push(path)
}

function updateAdminTabsScrollState() {
  const element = adminTabsScroll.value
  if (!element) return
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
  const scrollLeft = Math.max(0, element.scrollLeft)
  adminTabsCanScrollLeft.value = scrollLeft > 2
  adminTabsCanScrollRight.value = scrollLeft < maxScrollLeft - 2
}

function scrollAdminTabs(direction: -1 | 1) {
  const element = adminTabsScroll.value
  if (!element) return
  element.scrollBy({
    left: direction * Math.max(140, element.clientWidth * 0.7),
    behavior: 'smooth',
  })
}

watch(() => route.params.section, () => {
  tab.value = tabFromRoute()
}, { immediate: true })

const newUser = ref({ username: '', password: '', upload_token: '', is_admin: false })
const webhookForm = ref({ url: '', events: 'file.uploaded,file.deleted', secret: '', enabled: true })
const settingsForm = ref({
  app_name: initialAdminData?.settings.app_name ?? '',
  public_title: initialAdminData?.settings.public_title ?? '',
  base_api_url: initialAdminData?.settings.base_api_url ?? '',
  registration_enabled: initialAdminData?.settings.registration_enabled !== 'false',
  file_size_limit_bytes: Number(initialAdminData?.settings.file_size_limit_bytes ?? 0) || 0,
  file_size_limit_unlimited: initialAdminData?.settings.file_size_limit_unlimited === 'true',
  upload_access_mode: initialAdminData?.settings.upload_access_mode === 'public' ? 'public' as const : 'private' as const,
  passkeys_enabled: initialAdminData?.settings.passkeys_enabled === 'true',
  turnstile_enabled: initialAdminData?.settings.turnstile_enabled === 'true',
  turnstile_site_key: initialAdminData?.settings.turnstile_site_key ?? '',
  turnstile_secret_key: '',
})
const turnstileSecretPlaceholder = computed(() => settings.value.turnstile_secret_configured === 'true'
  ? '*****************'
  : 'Enter a secret key')
const webhookEventOptions = [
  { value: 'file.uploaded', label: 'File uploaded', description: 'When a new file or paste is stored.' },
  { value: 'file.deleted', label: 'File deleted', description: 'When a file is removed manually or by cleanup.' },
  { value: 'user.created', label: 'User created', description: 'When an account is created.' },
  { value: 'user.deleted', label: 'User deleted', description: 'When an account is removed.' },
]
function webhookEventLabel(event: string): string {
  return webhookEventOptions.find((option) => option.value === event)?.label
    ?? event.replace(/\./g, ' ')
}
const filterText = ref('')
const searchingUploads = ref(false)
let searchIndicatorTimer: ReturnType<typeof setTimeout> | null = null
const filterOwner = ref('')
const filterExpired = ref<'all' | 'expired' | 'active'>('all')
const PAGE_SIZE = 10
const UPLOAD_PAGE_SIZES = [15, 30, 45] as const
type UploadPageSize = typeof UPLOAD_PAGE_SIZES[number]
const uploadsPageSize = ref<UploadPageSize>(15)
const uploadsActionsOpen = ref(false)
const uploadRowMenuOpen = ref<string | null>(null)
const userRowMenuOpen = ref<string | null>(null)
const userRowMenuTrigger = ref<HTMLButtonElement | null>(null)
const userRowMenuPanel = ref<HTMLElement | null>(null)
const userRowMenuStyle = ref<Record<string, string>>({})
const usersTableScroll = ref<HTMLElement | null>(null)
const uploadsTableScroll = ref<HTMLElement | null>(null)
const previewUpload = ref<AdminUpload | null>(null)
const hoverUploadPreview = ref<UploadHoverPreview | null>(null)
const uploadHoverEnabled = typeof window !== 'undefined'
  && window.matchMedia('(hover: hover) and (pointer: fine)').matches
const previewUploadFile = computed<PasteFile | null>(() => {
  const upload = previewUpload.value
  if (!upload) return null
  return {
    file_name: uploadFileName(upload),
    file_size: upload.size_bytes,
    created_at: upload.created_at ? new Date(upload.created_at * 1000).toISOString() : null,
    expires_at: upload.expires_at ? new Date(upload.expires_at * 1000).toISOString() : null,
  }
})
const pageByTab = ref<Record<string, number>>({
  Users: 1,
  Uploads: 1,
  Webhooks: 1,
  Deliveries: 1,
  Audit: 1,
})


const currentUser = getAuthUsername()
const { refreshPublicSettings } = usePublicSettings()
const filteredUploads = computed(() => uploads.value.filter((upload) => {
  const ownerOk = !filterOwner.value || uploadOwner(upload) === filterOwner.value
  const text = filterText.value.trim().toLowerCase()
  const textOk = !text
    || upload.path.toLowerCase().includes(text)
    || uploadFileName(upload).toLowerCase().includes(text)
    || (upload.display_name ?? '').toLowerCase().includes(text)
    || (upload.source ?? '').toLowerCase().includes(text)
    || (upload.content_type ?? '').toLowerCase().includes(text)
  const expiryOk = filterExpired.value === 'all'
    || (filterExpired.value === 'expired' ? upload.expired : !upload.expired)
  return ownerOk && textOk && expiryOk
}))
const hasUploadFilters = computed(() => Boolean(filterText.value.trim() || filterOwner.value || filterExpired.value !== 'all'))
watch(filterText, () => {
  searchingUploads.value = true
  if (searchIndicatorTimer) clearTimeout(searchIndicatorTimer)
  searchIndicatorTimer = setTimeout(() => {
    searchingUploads.value = false
    searchIndicatorTimer = null
  }, 240)
})
const ownerFilterOptions = computed<SelectOption[]>(() => {
  const owners = new Set(uploads.value.map((upload) => uploadOwner(upload)).filter(Boolean))
  return [
    { value: '', label: 'All owners', hint: 'Every upload owner' },
    ...Array.from(owners).sort((left, right) => left.localeCompare(right)).map((owner) => ({ value: owner, label: owner })),
  ]
})
const expiryFilterOptions: SelectOption[] = [
  { value: 'all', label: 'All expiry states', hint: 'Active and expired' },
  { value: 'active', label: 'Active', hint: 'Still available' },
  { value: 'expired', label: 'Expired', hint: 'Ready to purge' },
]
const pagedUsers = computed(() => paginate(users.value, 'Users'))
const pagedUploads = computed(() => paginate(filteredUploads.value, 'Uploads', uploadsPageSize.value))
const pagedWebhooks = computed(() => paginate(webhooks.value, 'Webhooks'))
const pagedDeliveries = computed(() => paginate(deliveries.value, 'Deliveries'))
const pagedAudit = computed(() => paginate(audit.value, 'Audit'))
const activeUserMenuUser = computed(() => users.value.find((user) => user.username === userRowMenuOpen.value) ?? null)
const usersPageCount = computed(() => pageCount(users.value.length))
const uploadsPageCount = computed(() => pageCount(filteredUploads.value.length, uploadsPageSize.value))
const webhooksPageCount = computed(() => pageCount(webhooks.value.length))
const deliveriesPageCount = computed(() => pageCount(deliveries.value.length))
const auditPageCount = computed(() => pageCount(audit.value.length))
const allPagedUploadsSelected = computed(
  () => pagedUploads.value.length > 0 && pagedUploads.value.every((upload) => selectedUploads.value.has(upload.path)),
)
const allFilteredUploadsSelected = computed(
  () => filteredUploads.value.length > 0 && filteredUploads.value.every((upload) => selectedUploads.value.has(upload.path)),
)
const latestUploadDate = computed(() => {
  const latest = uploads.value.reduce<number | null>((value, upload) => (
    upload.created_at && (!value || upload.created_at > value) ? upload.created_at : value
  ), null)
  return latest ? ts(latest) : 'No uploads'
})
const fileSizeLimitGb = computed({
  get: () => settingsForm.value.file_size_limit_bytes === 0 ? 0 : Math.min(100, settingsForm.value.file_size_limit_bytes / (1024 ** 3)),
  set: (value: number) => { settingsForm.value.file_size_limit_unlimited = false; settingsForm.value.file_size_limit_bytes = Math.round(value * 1024 ** 3) },
})
const fileSizeLimitLabel = computed(() => settingsForm.value.file_size_limit_bytes === 0 ? 'Disabled' : formatGigabytes(settingsForm.value.file_size_limit_bytes))

function pageCount(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size))
}

function pageFor(key: string, total: number, size = PAGE_SIZE): number {
  const max = pageCount(total, size)
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

function paginate<T>(items: T[], key: string, size = PAGE_SIZE): T[] {
  const page = pageFor(key, items.length, size)
  return items.slice((page - 1) * size, page * size)
}

function setPage(key: string, next: number, total: number, size = PAGE_SIZE) {
  const max = pageCount(total, size)
  pageByTab.value = { ...pageByTab.value, [key]: Math.min(max, Math.max(1, next)) }
}

function pageLabel(key: string, total: number, size = PAGE_SIZE): string {
  if (total === 0) return 'No items'
  const page = pageFor(key, total, size)
  if (key === "Users") return `${page} of ${pageCount(total, size)}`
  const start = (page - 1) * size + 1
  const end = Math.min(total, page * size)
  return `${start}-${end} of ${total}`
}

function setUploadsPageSize(size: UploadPageSize) {
  uploadsPageSize.value = size
  pageByTab.value = { ...pageByTab.value, Uploads: 1 }
  uploadsActionsOpen.value = false
}

function uploadFileName(upload: AdminUpload): string {
  const fileName = upload.file_name?.trim()
  if (fileName) return fileName
  return upload.path.split('/').filter(Boolean).at(-1) ?? ''
}

function uploadDisplayName(upload: AdminUpload): string {
  return (upload.display_name?.trim() || uploadFileName(upload)).replace(/\.\d{6,}$/, '')
}

function splitUploadDisplayName(upload: AdminUpload): { base: string; ext: string } {
  const name = uploadDisplayName(upload)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

function isShareXUpload(upload: AdminUpload): boolean {
  const source = (upload.source ?? '').trim().toLowerCase()
  return source === 'sharex'
}

function uploadOwner(upload: AdminUpload): string {
  const owner = displayUploaderName(upload.owner ?? upload.uploader)
  return owner.replace(/\s+\(sharex\)$/i, '').trim() || 'Unattributed'
}

function uploadDownloadUrl(upload: AdminUpload): string {
  return publicDownloadUrl(uploadFileName(upload))
}

async function copyUploadLink(upload: AdminUpload) {
  try {
    const fileName = uploadFileName(upload)
    if (!fileName) throw new Error('Missing upload file name')
    await navigator.clipboard.writeText(publicPreviewUrl(fileName))
    copiedUploadPath.value = upload.path
    if (copiedUploadTimer) clearTimeout(copiedUploadTimer)
    copiedUploadTimer = setTimeout(() => {
      if (copiedUploadPath.value === upload.path) copiedUploadPath.value = null
      copiedUploadTimer = null
    }, 1000)
    notifications.push('Preview link copied', 'success')
  } catch {
    notifications.push('Could not copy preview link', 'error')
  }
}

function openUploadPreview(upload: AdminUpload) {
  uploadRowMenuOpen.value = null
  hideUploadHover()
  previewUpload.value = upload
}

function isImageUpload(upload: AdminUpload): boolean {
  return (upload.content_type ?? '').toLowerCase().startsWith('image/')
    || /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico)(?:\.\d{6,})?$/i.test(uploadFileName(upload))
}

function uploadHoverPosition(event: MouseEvent): { x: number; y: number } {
  // Keep the 232px preview card inside the viewport with a 16px outer gutter.
  return {
    x: Math.max(16, Math.min(event.clientX + 18, window.innerWidth - 266)),
    y: event.clientY + 18,
  }
}

function showUploadHover(upload: AdminUpload, event: MouseEvent) {
  if (!uploadHoverEnabled || !isImageUpload(upload)) return
  const { x, y } = uploadHoverPosition(event)
  hoverUploadPreview.value = {
    upload,
    x,
    y,
  }
}

function moveUploadHover(event: MouseEvent) {
  if (!hoverUploadPreview.value) return
  const { x, y } = uploadHoverPosition(event)
  hoverUploadPreview.value.x = x
  hoverUploadPreview.value.y = y
}

function hideUploadHover() {
  hoverUploadPreview.value = null
}

function closeUploadPreview() {
  previewUpload.value = null
}

function downloadPreviewUpload() {
  if (!previewUpload.value) return
  window.open(uploadDownloadUrl(previewUpload.value), '_blank', 'noopener')
}

function ts(value: number | string | null | undefined): string {
  return formatTimestamp(value)
}

function requestConfirmation(request: ConfirmationRequest) {
  confirmationRequest.value = request
  confirmationAcknowledged.value = false
  confirmationBusy.value = false
}

function closeConfirmation() {
  if (confirmationBusy.value) return
  confirmationRequest.value = null
  confirmationAcknowledged.value = false
}

async function submitConfirmation() {
  const request = confirmationRequest.value
  if (!request || !confirmationAcknowledged.value || confirmationBusy.value) return
  confirmationBusy.value = true
  try {
    await runAction(request.work, request.success)
    confirmationRequest.value = null
    confirmationAcknowledged.value = false
  } finally {
    confirmationBusy.value = false
  }
}

function showTokenDialog(username: string, token: string, options: { kind?: 'upload' | 'registration'; expiresAt?: number | null } = {}) {
  tokenDialog.value = { username, token, kind: options.kind ?? 'upload', expiresAt: options.expiresAt ?? null }
  tokenCopied.value = false
}

function selectRegistrationExpiry(value: string) {
  newRegistrationToken.value.ttl_seconds = value
  registrationExpiryOpen.value = false
}

function closeRegistrationExpiryOnOutsidePointer(event: PointerEvent) {
  if (!registrationExpiryOpen.value) return
  const target = event.target as Node | null
  if (registrationExpiryPicker.value && !registrationExpiryPicker.value.contains(target)) registrationExpiryOpen.value = false
}

function registrationTokenStatusLabel(token: AdminRegistrationToken): string {
  return token.status === 'available' ? 'Active' : token.status.charAt(0).toUpperCase() + token.status.slice(1)
}

function registrationTokenSummary(token: AdminRegistrationToken): string {
  const created = `Created ${formatTimestamp(token.created_at)}`
  if (token.used_by) return `Used by ${token.used_by} · ${created}`
  if (token.status === 'expired') return `Expired ${formatTimestamp(token.expires_at)} · ${created}`
  if (token.expires_at) return `Expires ${formatTimestamp(token.expires_at)} · ${created}`
  return `No expiration · ${created}`
}

async function loadRegistrationTokens() {
  const sequence = ++registrationTokensSequence
  registrationTokensLoading.value = true
  try {
    const next = await adminListRegistrationTokens()
    // A background fetch (e.g. from mounting the Users tab) may still be in
    // flight when a later one (e.g. after clearing history) resolves first.
    // Only the newest response may update the visible list, or a stale list
    // can reappear after the action that was supposed to change it.
    if (sequence !== registrationTokensSequence) return
    registrationTokens.value = next
  } catch (e: any) {
    if (sequence !== registrationTokensSequence) return
    if (tab.value === 'Users') error.value = e.message ?? 'Could not load registration tokens'
  } finally {
    if (sequence === registrationTokensSequence) registrationTokensLoading.value = false
  }
}

function requestRegistrationTokenRevoke(token: AdminRegistrationToken) {
  if (token.status !== 'available') return
  requestConfirmation({
    title: 'Revoke registration token?',
    message: 'This invitation will stop working immediately.',
    detail: token.label,
    confirmLabel: 'Revoke token',
    success: 'Registration token revoked',
    work: () => adminRevokeRegistrationToken(token.token_ref),
  })
}

function requestRegistrationTokenHistoryClear() {
  if (!hasRegistrationTokenHistory.value) return
  requestConfirmation({
    title: 'Clear token history?',
    message: 'Used, expired, and revoked registration tokens will be removed from this list. Active tokens will stay available.',
    confirmLabel: 'Clear history',
    success: 'Registration token history cleared',
    work: async () => {
      await adminClearRegistrationTokenHistory()
      await loadRegistrationTokens()
    },
  })
}

async function copyToken() {
  if (!tokenDialog.value) return
  try {
    await navigator.clipboard.writeText(tokenDialog.value.token)
    tokenCopied.value = true
  } catch {
    notifications.push('Could not copy token', 'error')
  }
}

async function refreshAll(showLoading = true) {
  const sequence = ++refreshSequence
  uploadsRefreshSequence++
  if (showLoading) loading.value = true
  error.value = ''
  try {
    const next = await loadAdminData(true)
    // A page-load refresh may still be in flight when an admin action
    // completes. Only the newest response may update the visible state;
    // otherwise a stale uploads list can reappear after deletion.
    if (sequence !== refreshSequence) return
    dashboard.value = next.dashboard
    users.value = next.users
    uploads.value = next.uploads
    selectedUploads.value = new Set([...selectedUploads.value].filter((path) => next.uploads.some((upload) => upload.path === path)))
    settings.value = next.settings
    webhooks.value = next.webhooks
    deliveries.value = next.deliveries
    audit.value = next.audit
    settingsForm.value = {
      app_name: next.settings.app_name ?? 'yaemipaste',
      public_title: next.settings.public_title ?? 'yaemipaste',
      base_api_url: next.settings.base_api_url ?? '',
      registration_enabled: next.settings.registration_enabled !== 'false',
      file_size_limit_bytes: Number(next.settings.file_size_limit_bytes ?? 0) || 0,
      file_size_limit_unlimited: next.settings.file_size_limit_unlimited === 'true',
      upload_access_mode: next.settings.upload_access_mode === 'public' ? 'public' : 'private',
      passkeys_enabled: next.settings.passkeys_enabled === 'true',
      turnstile_enabled: next.settings.turnstile_enabled === 'true',
      turnstile_site_key: next.settings.turnstile_site_key ?? '',
      // Secrets are intentionally write-only: never repopulate one from the API.
      turnstile_secret_key: '',
    }
    if (tab.value === 'Users') await loadRegistrationTokens()
  } catch (e: any) {
    if (sequence === refreshSequence) error.value = e.message ?? 'Could not load admin data'
  } finally {
    if (sequence === refreshSequence) loading.value = false
  }
}

async function refreshUploads() {
  const sequence = ++uploadsRefreshSequence
  try {
    const next = await adminUploads()
    if (sequence !== uploadsRefreshSequence) return
    uploads.value = next
    selectedUploads.value = new Set([...selectedUploads.value].filter((path) => next.some((upload) => upload.path === path)))
    updateCachedAdminUploads(next)
  } catch (e) {
    // Upload polling is best-effort. Keep the last known list visible while a
    // transient request failure is retried on the next interval.
    console.error('Admin upload refresh failed', e)
  }
}

async function saveSettings() {
  await runAction(async () => {
    const updated = await adminUpdateSettings({
      ...settingsForm.value,
      // An empty password field means retain the server-side secret.
      turnstile_secret_key: settingsForm.value.turnstile_secret_key.trim() || undefined,
    })
    settings.value = updated
    if (settingsForm.value.turnstile_enabled && !updated.turnstile_secret_configured) {
      throw new Error('Turnstile is enabled but no secret key was saved')
    }
    await refreshPublicSettings(true)
  }, 'Settings updated')
}

async function deleteUploadWithConfirmation(upload: AdminUpload) {
  const path = upload.path
  requestConfirmation({
    title: 'Delete upload?',
    message: 'This upload will be permanently removed from the server.',
    detail: uploadDisplayName(upload),
    confirmLabel: 'Delete upload',
    success: 'Upload deleted',
    work: async () => {
      await adminDeleteUpload(path)
      uploads.value = uploads.value.filter((upload) => upload.path !== path)
    },
  })
}

async function deleteWebhookWithConfirmation(hook: AdminWebhook) {
  requestConfirmation({
    title: 'Delete webhook?',
    message: 'This endpoint and its delivery history will no longer be managed here.',
    detail: hook.url,
    confirmLabel: 'Delete webhook',
    success: 'Webhook deleted',
    work: () => adminDeleteWebhook(hook.id),
  })
}

async function runAction(work: () => Promise<unknown>, success: string) {
  try {
    await work()
    await refreshAll()
    notifications.push(success, 'success')
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
    showTokenDialog(username, result.upload_token)
    newUser.value = { username: '', password: '', upload_token: '', is_admin: false }
  }, 'User created')
}

async function createRegistrationToken() {
  await runAction(async () => {
    const result = await adminCreateRegistrationToken({
      label: newRegistrationToken.value.label.trim() || undefined,
      ttl_seconds: Number(newRegistrationToken.value.ttl_seconds),
    })
    showTokenDialog('single-use registration', result.token, { kind: 'registration', expiresAt: result.expires_at })
    newRegistrationToken.value = { label: '', ttl_seconds: '86400' }
  }, 'Registration token created')
}

async function submitCreateMode() {
  if (createMode.value === 'token') await createRegistrationToken()
  else await createUser()
}

async function rotateToken(username: string) {
  await runAction(async () => {
    const result = await adminRotateUserToken(username)
    showTokenDialog(username, result.upload_token)
  }, 'Token rotated')
}

function rejectSelfAction(username: string): boolean {
  if (username.trim().toLowerCase() !== currentUser.trim().toLowerCase()) return false
  notifications.push('You cannot take action on your own account.', 'error')
  return true
}

function updateUserFromMenu(user: AdminUser, payload: { suspended?: boolean; is_admin?: boolean }, success: string) {
  if (rejectSelfAction(user.username)) {
    closeUserRowMenu(true)
    return
  }
  void runAction(() => adminUpdateUser(user.username, payload), success)
  closeUserRowMenu(true)
}

function toggleSelection(path: string, checked: boolean) {
  const next = new Set(selectedUploads.value)
  if (checked) next.add(path)
  else next.delete(path)
  selectedUploads.value = next
}

function toggleUploadPage(checked: boolean) {
  if (!checked && allFilteredUploadsSelected.value) {
    clearUploadSelection()
    return
  }
  const next = new Set(selectedUploads.value)
  if (checked) {
    for (const upload of pagedUploads.value) next.add(upload.path)
  } else {
    for (const upload of pagedUploads.value) next.delete(upload.path)
  }
  selectedUploads.value = next
}

function selectAllFilteredUploads() {
  selectedUploads.value = new Set(filteredUploads.value.map((upload) => upload.path))
}

function clearUploadSelection() {
  selectedUploads.value = new Set()
}

async function deleteAdminUploads(paths: string[], success: string) {
  uploadsActionsOpen.value = false
  if (!paths.length) return
  requestConfirmation({
    title: success === 'All matching uploads deleted' ? 'Delete all matching uploads?' : 'Delete selected uploads?',
    message: `This will permanently delete ${paths.length} upload${paths.length === 1 ? '' : 's'}.`,
    detail: 'The files will no longer be available to users.',
    confirmLabel: 'Delete uploads',
    success,
    work: async () => {
      await adminBulkDeleteUploads(paths, 'PURGE UPLOADS')
      uploads.value = uploads.value.filter((upload) => !paths.includes(upload.path))
      clearUploadSelection()
    },
  })
}

function requestPurgeExpired() {
  uploadsActionsOpen.value = false
  requestConfirmation({
    title: 'Purge expired uploads?',
    message: 'Expired uploads will be permanently removed from storage.',
    confirmLabel: 'Purge expired',
    success: 'Expired uploads purged',
    work: async () => {
      await adminPurgeExpired('PURGE EXPIRED')
      uploads.value = uploads.value.filter((upload) => !upload.expired)
    },
  })
}

function requestUserPurge(username: string) {
  requestConfirmation({
    title: 'Purge user uploads?',
    message: `All uploads owned by ${username} will be permanently removed.`,
    detail: username,
    confirmLabel: 'Purge uploads',
    success: 'Uploads purged',
    work: async () => {
      await adminPurgeUserUploads(username, 'PURGE UPLOADS')
      uploads.value = uploads.value.filter((upload) => upload.owner !== username)
    },
  })
}

function requestUserDelete(username: string) {
  if (rejectSelfAction(username)) return
  requestConfirmation({
    title: 'Delete user?',
    message: `The account and all associated uploads for ${username} will be permanently removed.`,
    detail: username,
    confirmLabel: 'Delete user',
    success: 'User deleted',
    work: async () => {
      await adminDeleteUser(username, 'DELETE USER')
      users.value = users.value.filter((user) => user.username !== username)
      uploads.value = uploads.value.filter((upload) => upload.owner !== username)
    },
  })
}

let lastVisibilityRefresh = 0
const VISIBILITY_REFRESH_COOLDOWN_MS = 30_000

function refreshAdminWhenVisible() {
  // Do not replace unsaved settings, or the Turnstile widget and secret lose
  // their backing form state when the administrator returns to this tab.
  if (document.visibilityState === 'hidden') {
    uploadsActionsOpen.value = false
    uploadRowMenuOpen.value = null
    closeUserRowMenu()
    hideUploadHover()
    return
  }
  // Alt-tabbing back and forth should not force a full refetch every time -
  // once the panel is reasonably fresh, leave it alone until the cooldown
  // passes.
  const now = Date.now()
  if (now - lastVisibilityRefresh < VISIBILITY_REFRESH_COOLDOWN_MS) return
  lastVisibilityRefresh = now
  if (tab.value === 'Uploads') {
    void refreshUploads()
    return
  }
  if (tab.value !== 'Settings') void refreshAll(false)
}

function closeUploadMenusOnOutsidePointer(event: PointerEvent) {
  const target = event.target as Element | null
  if (!target?.closest('.admin-actions-menu')) uploadsActionsOpen.value = false
  if (!target?.closest('.upload-row-menu')) uploadRowMenuOpen.value = null
  if (userRowMenuOpen.value && !userRowMenuTrigger.value?.contains(target) && !userRowMenuPanel.value?.contains(target)) closeUserRowMenu()
}

function closeAdminMenusOnScroll() {
  uploadsActionsOpen.value = false
  uploadRowMenuOpen.value = null
  registrationExpiryOpen.value = false
  closeUserRowMenu()
}

function positionUserRowMenu() {
  const trigger = userRowMenuTrigger.value
  const panel = userRowMenuPanel.value
  if (!trigger || !panel) return
  const gutter = 8
  const gap = 6
  const triggerBox = trigger.getBoundingClientRect()
  const panelBox = panel.getBoundingClientRect()
  const containingCard = trigger.closest<HTMLElement>('.card')
  const cardBox = containingCard?.getBoundingClientRect()
  const minLeft = Math.max(gutter, (cardBox?.left ?? gutter) + gutter)
  const maxRight = Math.min(window.innerWidth - gutter, (cardBox?.right ?? window.innerWidth - gutter) - gutter)
  const maxLeft = Math.max(minLeft, maxRight - panelBox.width)
  // Keep the dropdown's left edge in line with More when possible. If the
  // card is narrower than the menu, clamp it to the card and viewport.
  const left = Math.max(minLeft, Math.min(triggerBox.left, maxLeft))
  const below = triggerBox.bottom + gap
  const above = triggerBox.top - panelBox.height - gap
  const top = below + panelBox.height <= window.innerHeight - gutter
    ? below
    : Math.max(gutter, Math.min(above, window.innerHeight - panelBox.height - gutter))
  userRowMenuStyle.value = { left: `${left}px`, top: `${top}px` }
}

function closeUserRowMenu(restoreFocus = false) {
  userRowMenuOpen.value = null
  if (restoreFocus) void nextTick(() => userRowMenuTrigger.value?.focus())
}

async function toggleUserRowMenu(username: string, event: MouseEvent) {
  if (userRowMenuOpen.value === username) {
    closeUserRowMenu(true)
    return
  }
  userRowMenuTrigger.value = event.currentTarget as HTMLButtonElement
  userRowMenuOpen.value = username
  await nextTick()
  positionUserRowMenu()
  userRowMenuPanel.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
}

function repositionUserRowMenu() {
  if (userRowMenuOpen.value) positionUserRowMenu()
}

watch(tab, async (nextTab) => {
  closeUserRowMenu()
  await nextTick()
  if (nextTab === 'Users') usersTableScroll.value?.scrollTo({ left: 0 })
  if (nextTab === 'Uploads') {
    uploadsTableScroll.value?.scrollTo({ left: 0 })
    void refreshUploads()
  }
  if (nextTab === 'Users') void loadRegistrationTokens()
})

watch(pagedUsers, (nextUsers) => {
  if (userRowMenuOpen.value && !nextUsers.some((user) => user.username === userRowMenuOpen.value)) closeUserRowMenu()
})

onMounted(() => {
  void nextTick(updateAdminTabsScrollState)
  void refreshPublicSettings()
  if (!initialAdminData) void refreshAll()
  // refreshAll() is the only other place that loads registration tokens, and
  // it's skipped above whenever prefetched data is already warm. Landing
  // directly on /admin/users (a fresh route, e.g. browser back/forward) never
  // fires the tab watcher below either, since tab starts at 'Users' rather
  // than transitioning into it - so tokens would silently never load.
  else if (tab.value === 'Users') void loadRegistrationTokens()
  if (initialAdminData && tab.value === 'Uploads') void refreshUploads()
  uploadsRefreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && tab.value === 'Uploads') void refreshUploads()
  }, ADMIN_UPLOAD_REFRESH_MS)
  // visibilitychange alone is enough to catch "the admin returned to this
  // tab"; also listening on window focus made every alt-tab fire this twice.
  document.addEventListener('visibilitychange', refreshAdminWhenVisible)
  document.addEventListener('pointerdown', closeUploadMenusOnOutsidePointer)
  document.addEventListener('pointerdown', closeRegistrationExpiryOnOutsidePointer)
  window.addEventListener('blur', hideUploadHover)
  window.addEventListener('scroll', hideUploadHover, true)
  window.addEventListener('resize', repositionUserRowMenu)
  window.addEventListener('resize', updateAdminTabsScrollState)
  window.addEventListener('scroll', closeAdminMenusOnScroll, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', refreshAdminWhenVisible)
  document.removeEventListener('pointerdown', closeUploadMenusOnOutsidePointer)
  document.removeEventListener('pointerdown', closeRegistrationExpiryOnOutsidePointer)
  window.removeEventListener('blur', hideUploadHover)
  window.removeEventListener('scroll', hideUploadHover, true)
  window.removeEventListener('resize', repositionUserRowMenu)
  window.removeEventListener('resize', updateAdminTabsScrollState)
  window.removeEventListener('scroll', closeAdminMenusOnScroll, true)
  if (uploadsRefreshTimer) {
    clearInterval(uploadsRefreshTimer)
    uploadsRefreshTimer = null
  }
  if (copiedUploadTimer) clearTimeout(copiedUploadTimer)
  if (searchIndicatorTimer) clearTimeout(searchIndicatorTimer)
})
</script>

<template>
  <div class="admin-view-content">
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

        <div class="admin-tabs-wrap">
          <div class="admin-tabs-row">
            <button
              v-if="adminTabsHasOverflow"
              class="admin-tabs-scroll-button admin-tabs-scroll-button--left"
              type="button"
              aria-label="Scroll admin sections left"
              aria-controls="admin-tabs-scroll"
              :disabled="!adminTabsCanScrollLeft"
              @click="scrollAdminTabs(-1)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <div id="admin-tabs-scroll" ref="adminTabsScroll" class="tabs admin-tabs" @scroll="updateAdminTabsScrollState">
              <button v-for="item in tabs" :key="item" :class="{ active: tab === item }" type="button" @click="selectTab(item)">
                {{ item }}
              </button>
            </div>
            <button
              v-if="adminTabsHasOverflow"
              class="admin-tabs-scroll-button admin-tabs-scroll-button--right"
              type="button"
              aria-label="Scroll admin sections right"
              aria-controls="admin-tabs-scroll"
              :disabled="!adminTabsCanScrollRight"
              @click="scrollAdminTabs(1)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
            </button>
          </div>
        </div>

    <div class="admin-content-stage">
    <Transition name="admin-content" mode="out-in">
    <div :key="tab" class="admin-content-panel">
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
        <div class="card-heading">
          <h2>Recent uploads</h2>
          <button v-if="dashboard.recent_uploads.length > 6" class="btn-ghost btn-sm" type="button" @click="selectTab('Uploads')">View all uploads</button>
        </div>
        <div class="table-scroll">
          <table class="file-table admin-table">
            <tbody>
              <tr v-for="upload in dashboard.recent_uploads.slice(0, 6)" :key="upload.path">
                <td>{{ uploadDisplayName(upload) }}</td>
                <td class="upload-owner-cell">
                  <span>{{ uploadOwner(upload) }}</span>
                  <span v-if="isShareXUpload(upload)" class="upload-sharex-badge" aria-label="Uploaded with ShareX" title="Captured and uploaded with ShareX">
                    <img :src="sharexLogoUrl" alt="" aria-hidden="true" />
                    ShareX
                  </span>
                </td>
                <td>{{ formatBytes(upload.size_bytes) }}</td>
                <td>{{ ts(upload.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!dashboard.recent_uploads.length" class="empty-state">No uploads yet.</p>
      </div>
      <div class="card wide">
        <div class="card-heading">
          <h2>Recent admin actions</h2>
          <button v-if="dashboard.recent_audit.length > 6" class="btn-ghost btn-sm" type="button" @click="selectTab('Audit')">View all activity</button>
        </div>
        <div class="table-scroll">
          <table class="file-table admin-table">
            <tbody>
              <tr v-for="entry in dashboard.recent_audit.slice(0, 6)" :key="entry.id">
                <td>{{ ts(entry.created_at) }}</td>
                <td>{{ entry.actor ?? 'system' }}</td>
                <td>{{ entry.action }}</td>
                <td>{{ entry.status }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!dashboard.recent_audit.length" class="empty-state">No administrative actions recorded yet.</p>
      </div>
    </section>

    <section v-if="tab === 'Users'" class="stack">
      <div class="card create-user-card">
        <div class="card-heading">
          <div>
            <h2>Create user</h2>
            <p class="subtle">Create an account or generate a single-use registration token.</p>
          </div>
        </div>
        <div class="create-mode-tabs" role="tablist" aria-label="Create user or token">
          <button class="btn-ghost" :class="{ active: createMode === 'user' }" type="button" role="tab" :aria-selected="createMode === 'user'" @click="createMode = 'user'">User</button>
          <button class="btn-ghost" :class="{ active: createMode === 'token' }" type="button" role="tab" :aria-selected="createMode === 'token'" @click="createMode = 'token'">Token</button>
        </div>
        <form class="form-grid" @submit.prevent="submitCreateMode">
          <Transition name="panel-fade" mode="out-in">
            <div :key="createMode" class="create-mode-panel">
              <template v-if="createMode === 'user'">
                <input v-model="newUser.username" placeholder="username" aria-label="username" />
                <input v-model="newUser.password" type="password" placeholder="password" aria-label="password" />
                <input v-model="newUser.upload_token" type="password" placeholder="custom upload token (optional)" aria-label="custom upload token (optional)" />
                <label class="inline-check"><input v-model="newUser.is_admin" type="checkbox" /> administrator</label>
                <button class="btn-orange" type="submit">Create user</button>
              </template>
              <template v-else>
                <label>
                  Token label
                  <input v-model="newRegistrationToken.label" placeholder="e.g. contractor invite" aria-label="Token label" />
                </label>
                <div ref="registrationExpiryPicker" class="registration-expiry-picker" :class="{ open: registrationExpiryOpen }">
                  <button
                    class="registration-expiry-trigger"
                    type="button"
                    aria-label="Token expiration"
                    aria-haspopup="listbox"
                    :aria-expanded="registrationExpiryOpen"
                    aria-controls="registration-expiry-menu"
                    @click="registrationExpiryOpen = !registrationExpiryOpen"
                    @keydown.escape.prevent="registrationExpiryOpen = false"
                  >
                    <span><small>Expires</small><strong>{{ selectedRegistrationExpiry.label }}</strong></span>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                  </button>
                  <Transition name="dropdown-fade">
                    <div v-if="registrationExpiryOpen" id="registration-expiry-menu" class="registration-expiry-menu" role="listbox" aria-label="Token expiration">
                      <button
                        v-for="option in registrationTokenExpiryOptions"
                        :key="option.value"
                        type="button"
                        role="option"
                        :aria-selected="option.value === newRegistrationToken.ttl_seconds"
                        :class="{ selected: option.value === newRegistrationToken.ttl_seconds }"
                        @click="selectRegistrationExpiry(option.value)"
                      >
                        {{ option.label }} <span v-if="option.value === newRegistrationToken.ttl_seconds" aria-hidden="true">✓</span>
                      </button>
                    </div>
                  </Transition>
                </div>
                <p class="subtle token-help">This token can be used once to create one account.</p>
                <button class="btn-orange" type="submit">Generate token</button>
              </template>
            </div>
          </Transition>
        </form>
      </div>

      <div class="card registration-token-list-card">
        <div class="card-heading">
          <div>
            <h2>Registration tokens</h2>
            <p class="subtle">Single-use invitations for creating accounts.</p>
          </div>
          <div class="registration-token-heading-actions">
            <span class="registration-token-count"><strong>{{ activeRegistrationTokenCount }}</strong> active</span>
            <button v-if="hasRegistrationTokenHistory" class="btn-ghost btn-sm" type="button" @click="requestRegistrationTokenHistoryClear">Clear history</button>
          </div>
        </div>
        <div v-if="registrationTokensLoading" class="empty-state registration-token-empty">Loading tokens…</div>
        <div v-else-if="registrationTokens.length" class="registration-token-list">
          <article v-for="token in registrationTokens" :key="token.token_ref" class="registration-token-row" :class="`status-${token.status}`">
            <div class="registration-token-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M17 13v7M13.5 16.5h7"/></svg>
            </div>
            <div class="registration-token-main">
              <strong>{{ token.label }}</strong>
              <span>{{ registrationTokenSummary(token) }}</span>
            </div>
            <span class="registration-token-status" :class="token.status">{{ registrationTokenStatusLabel(token) }}</span>
            <button v-if="token.status === 'available'" class="btn-ghost btn-sm" type="button" :aria-label="`Revoke ${token.label} token`" @click="requestRegistrationTokenRevoke(token)">Revoke</button>
          </article>
        </div>
        <div v-else class="empty-state registration-token-empty">
          <strong>No registration tokens yet</strong>
          <span>Generate one above.</span>
        </div>
      </div>

      <div class="card">
        <h2>Users</h2>
        <div ref="usersTableScroll" class="table-scroll users-table-scroll">
        <table class="file-table admin-table users-table">
          <thead><tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Uploads</th><th scope="col">Storage</th><th scope="col">Actions</th></tr></thead>
          <tbody>
            <tr v-for="user in pagedUsers" :key="user.username">
              <td class="user-name-cell" data-label="User"><span>{{ user.username }}</span><div class="subtle">{{ user.upload_token_preview ? 'token configured' : 'no token' }}</div></td>
              <td data-label="Role">{{ user.is_admin ? 'admin' : 'user' }}</td>
              <td data-label="Status">{{ user.suspended_at ? `suspended ${ts(user.suspended_at)}` : 'active' }}</td>
              <td class="user-uploads-cell" data-label="Uploads">{{ user.upload_count }}</td>
              <td data-label="Storage">{{ formatBytes(user.disk_usage_bytes) }}</td>
              <td class="actions user-actions-cell">
                <div class="user-actions">
                  <button class="btn-ghost user-more" type="button" aria-label="More actions" :aria-controls="`user-actions-${user.username}`" :aria-expanded="userRowMenuOpen === user.username ? 'true' : 'false'" @click="toggleUserRowMenu(user.username, $event)"><span class="user-more-icon" aria-hidden="true">⋯</span><span class="user-more-label" aria-hidden="true">More</span></button>
                  <button class="btn-red" type="button" @click="requestUserDelete(user.username)">Delete</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <p v-if="!pagedUsers.length && !loading" class="empty-state">No users yet.</p>
        <div class="pagination-bar" aria-label="User pagination">
          <span>{{ pageLabel('Users', users.length) }}</span>
          <div>
            <button class="btn-ghost" type="button" :disabled="pageFor('Users', users.length) <= 1" @click="setPage('Users', pageFor('Users', users.length) - 1, users.length)">Previous</button>
            <button class="btn-ghost" type="button" :disabled="pageFor('Users', users.length) >= usersPageCount" @click="setPage('Users', pageFor('Users', users.length) + 1, users.length)">Next</button>
          </div>
        </div>
      </div>
      <Teleport to="body">
        <Transition name="dropdown-fade" @after-leave="userRowMenuStyle = {}">
          <div v-if="activeUserMenuUser" :key="activeUserMenuUser.username" :id="`user-actions-${activeUserMenuUser.username}`" ref="userRowMenuPanel" class="user-row-menu-panel" :style="userRowMenuStyle" role="group" aria-label="User actions" @keydown.escape.prevent="closeUserRowMenu(true)">
            <button class="menu-action" type="button" @click="updateUserFromMenu(activeUserMenuUser!, { suspended: !activeUserMenuUser!.suspended_at }, activeUserMenuUser!.suspended_at ? 'User unsuspended' : 'User suspended')">{{ activeUserMenuUser.suspended_at ? 'Unsuspend' : 'Suspend' }}</button>
            <button class="menu-action" type="button" @click="updateUserFromMenu(activeUserMenuUser!, { is_admin: !activeUserMenuUser!.is_admin }, 'Role updated')">{{ activeUserMenuUser.is_admin ? 'Demote' : 'Promote' }}</button>
            <button class="menu-action" type="button" @click="rotateToken(activeUserMenuUser!.username); closeUserRowMenu(true)">Rotate token</button>
            <button class="menu-action danger" type="button" @click="requestUserPurge(activeUserMenuUser!.username); closeUserRowMenu()">Purge uploads</button>
          </div>
        </Transition>
      </Teleport>
    </section>

    <section v-if="tab === 'Uploads'" class="stack">
      <div class="card">
        <div class="upload-toolbar">
          <div class="upload-toolbar-main">
            <CustomSelect v-model="filterOwner" label="Owner" :options="ownerFilterOptions" />
            <CustomSelect v-model="filterExpired" label="Expiry" :options="expiryFilterOptions" />
            <label class="upload-search">
              <input v-model="filterText" placeholder="" aria-label="Search uploads" />
              <span v-if="!filterText" class="upload-search-placeholder" aria-hidden="true">Search <strong>{{ uploads.length }}</strong> uploads</span>
              <svg v-if="searchingUploads" class="search-spinner" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8" stroke-opacity=".28"/><path d="M20 12a8 8 0 0 0-8-8"/></svg>
              <button v-else-if="filterText" class="search-clear" type="button" aria-label="Clear search" title="Clear search" @click="filterText = ''">×</button>
              <svg v-else aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            </label>
          </div>
          <button class="btn-red" type="button" :disabled="!filteredUploads.length || loading" @click="deleteAdminUploads(filteredUploads.map((upload) => upload.path), 'All matching uploads deleted')">Delete all</button>
        </div>
        <div class="upload-list-toolbar">
          <div class="upload-selection-bar" aria-label="Upload selection">
          <label
            class="select-all"
            :class="{ 'selection-disabled': !pagedUploads.length || loading }"
            :aria-disabled="!pagedUploads.length || loading ? 'true' : 'false'"
          >
            <input
              type="checkbox"
              :checked="allPagedUploadsSelected"
              :disabled="!pagedUploads.length || loading"
              aria-label="Select uploads on this page"
              @change="toggleUploadPage(($event.target as HTMLInputElement).checked)"
            />
            <span>Select page</span>
          </label>
          <span class="selection-count">{{ selectedUploads.size }} selected</span>
          <button
            v-if="uploadsPageCount > 1 && allPagedUploadsSelected && !allFilteredUploadsSelected"
            class="select-all-pages"
            type="button"
            :disabled="loading"
            @click="selectAllFilteredUploads"
          >
            Select all {{ filteredUploads.length }} uploads
          </button>
            <span v-else-if="uploadsPageCount > 1 && allFilteredUploadsSelected" class="all-pages-selected">
              All {{ filteredUploads.length }} uploads selected
            </span>
          <button v-if="selectedUploads.size" class="clear-selection" type="button" @click="clearUploadSelection">
              Clear
            </button>
          </div>
          <span class="upload-latest">Latest: {{ latestUploadDate }}</span>
          <div class="upload-table-toolbar">
          <div class="page-size-wrap">
            <span class="page-size-label">Per page</span>
            <div class="page-size-segment" role="group" aria-label="Uploads per page">
              <button
                v-for="size in UPLOAD_PAGE_SIZES"
                :key="size"
                class="page-size-btn"
                :class="{ active: uploadsPageSize === size }"
                :aria-pressed="uploadsPageSize === size ? 'true' : 'false'"
                type="button"
                @click="setUploadsPageSize(size)"
              >
                {{ size }}
              </button>
            </div>
          </div>
          <div class="admin-actions-menu">
            <button
              class="btn-ghost upload-actions-trigger"
              type="button"
              :disabled="!uploads.length || loading"
              aria-haspopup="menu"
              :aria-expanded="uploadsActionsOpen ? 'true' : 'false'"
              @click="uploadsActionsOpen = !uploadsActionsOpen"
            >
              Actions
            </button>
            <Transition name="dropdown-fade">
              <div v-if="uploadsActionsOpen" class="admin-actions-menu-panel" role="menu">
                <button class="menu-action" type="button" role="menuitem" :disabled="!selectedUploads.size" @click="deleteAdminUploads(Array.from(selectedUploads), 'Selected uploads deleted')">
                  Delete selected
                </button>
                <button class="menu-action danger" type="button" role="menuitem" :disabled="!filteredUploads.length" @click="deleteAdminUploads(filteredUploads.map((upload) => upload.path), 'All matching uploads deleted')">
                  Delete all
                </button>
                <button class="menu-action danger" type="button" role="menuitem" @click="requestPurgeExpired">
                  Purge expired
                </button>
                <button class="menu-action" type="button" role="menuitem" :disabled="!selectedUploads.size" @click="clearUploadSelection(); uploadsActionsOpen = false">
                  Clear selection
                </button>
              </div>
            </Transition>
          </div>
          </div>
        </div>
        <div ref="uploadsTableScroll" class="table-scroll uploads-table-scroll">
        <table class="file-table admin-table uploads-table">
          <thead>
            <tr>
              <th scope="col" class="select-col" :class="{ 'selection-disabled': !pagedUploads.length || loading }">
                <input
                  type="checkbox"
                  :checked="allPagedUploadsSelected"
                  :disabled="!pagedUploads.length || loading"
                  aria-label="Select uploads on this page"
                  @change="toggleUploadPage(($event.target as HTMLInputElement).checked)"
                />
              </th>
              <th scope="col">Name</th><th scope="col">Owner</th><th scope="col" class="upload-size">Size</th><th scope="col">Created</th><th scope="col" class="upload-expires">Expires</th><th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="upload in pagedUploads" :key="upload.path">
              <td class="select-col"><input type="checkbox" :checked="selectedUploads.has(upload.path)" :aria-label="`Select ${upload.path}`" @change="toggleSelection(upload.path, ($event.target as HTMLInputElement).checked)" /></td>
              <td class="upload-name-cell">
                <span class="upload-file-icon" aria-hidden="true">
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                </span>
                <button class="upload-name-link" type="button" :aria-label="uploadDisplayName(upload)" :title="uploadDisplayName(upload)" @click="openUploadPreview(upload)">
                  <span class="upload-filename-base" @mouseenter="showUploadHover(upload, $event)" @mousemove="moveUploadHover" @mouseleave="hideUploadHover">{{ splitUploadDisplayName(upload).base }}</span>
                  <span v-if="splitUploadDisplayName(upload).ext" class="upload-filename-ext">{{ splitUploadDisplayName(upload).ext }}</span>
                </button>
              </td>
              <td class="upload-owner-cell" data-label="Owner">
                <span>{{ uploadOwner(upload) }}</span>
                <span v-if="isShareXUpload(upload)" class="upload-sharex-badge" aria-label="Uploaded with ShareX" title="Captured and uploaded with ShareX">
                  <img :src="sharexLogoUrl" alt="" aria-hidden="true" />
                  ShareX
                </span>
              </td>
              <td class="upload-size" data-label="Size">{{ formatBytes(upload.size_bytes) }}</td>
              <td data-label="Created">{{ ts(upload.created_at) }}</td>
              <td class="upload-expires" data-label="Expires">{{ upload.expired ? 'Expired' : (upload.expires_at ? ts(upload.expires_at) : 'Never') }}</td>
              <td class="upload-row-actions">
                <a class="btn-ghost upload-action" :href="uploadDownloadUrl(upload)" aria-label="Download">
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span>Download</span>
                </a>
                <button class="btn-orange upload-action" type="button" :aria-label="copiedUploadPath === upload.path ? 'Copied' : 'Copy preview link'" @click="copyUploadLink(upload)">
                  <Transition name="copy-feedback" mode="out-in">
                    <svg v-if="copiedUploadPath === upload.path" key="copied" class="copy-feedback-icon" aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>
                    <svg v-else key="copy" aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </Transition>
                  <span>{{ copiedUploadPath === upload.path ? 'Copied' : 'Copy' }}</span>
                </button>
                <div class="upload-row-menu">
                  <button class="btn-ghost upload-more" type="button" aria-label="More" :aria-expanded="uploadRowMenuOpen === upload.path ? 'true' : 'false'" @click="uploadRowMenuOpen = uploadRowMenuOpen === upload.path ? null : upload.path">⋯</button>
                  <Transition name="dropdown-fade">
                    <div v-if="uploadRowMenuOpen === upload.path" class="upload-row-menu-panel" role="menu">
                      <button class="menu-action" type="button" role="menuitem" @click="openUploadPreview(upload)">Preview</button>
                      <button class="menu-action danger" type="button" role="menuitem" @click="deleteUploadWithConfirmation(upload); uploadRowMenuOpen = null">Delete</button>
                    </div>
                  </Transition>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <div v-if="!pagedUploads.length && !loading" class="upload-empty-state">
          <template v-if="hasUploadFilters">
            <strong>No matching files</strong>
            <p>Try a different filename or clear the search field.</p>
          </template>
          <template v-else>
            <strong>No uploads yet.</strong>
            <p>Upload a file to get started.</p>
          </template>
        </div>
        <div class="pagination-bar" aria-label="Upload pagination">
          <span>{{ pageLabel('Uploads', filteredUploads.length, uploadsPageSize) }}</span>
          <div>
            <button class="btn-ghost" type="button" :disabled="pageFor('Uploads', filteredUploads.length, uploadsPageSize) <= 1" @click="setPage('Uploads', pageFor('Uploads', filteredUploads.length, uploadsPageSize) - 1, filteredUploads.length, uploadsPageSize)">Previous</button>
            <button class="btn-ghost" type="button" :disabled="pageFor('Uploads', filteredUploads.length, uploadsPageSize) >= uploadsPageCount" @click="setPage('Uploads', pageFor('Uploads', filteredUploads.length, uploadsPageSize) + 1, filteredUploads.length, uploadsPageSize)">Next</button>
          </div>
        </div>
      </div>
    </section>

    <FilePreview
      v-if="previewUpload && previewUploadFile"
      :file="previewUploadFile"
      :source-url="adminUploadContentUrl(previewUpload.path)"
      :display-name="uploadDisplayName(previewUpload)"
      :mime-type="previewUpload.content_type ?? undefined"
      :password-salt="previewUpload.password_salt ?? undefined"
      @close="closeUploadPreview"
      @download="downloadPreviewUpload"
    />

    <div v-if="hoverUploadPreview" class="upload-hover-preview" :style="{ left: `${hoverUploadPreview.x}px`, top: `${hoverUploadPreview.y}px` }">
      <img :src="fileUrl(uploadFileName(hoverUploadPreview.upload))" :alt="uploadDisplayName(hoverUploadPreview.upload)" />
      <div class="upload-hover-name">{{ splitUploadDisplayName(hoverUploadPreview.upload).base }}</div>
    </div>

    <section v-if="tab === 'Settings'" class="settings-page">
      <header class="settings-intro">
        <p class="settings-eyebrow">Global settings</p>
        <h2>Configure your service</h2>
        <p class="subtle">Manage how your service appears and set limits for uploads and registrations.</p>
      </header>

      <div class="settings-groups">
      <section class="settings-group settings-group-branding">
        <header class="settings-group-heading">
          <div><h3>Identity</h3><p>How the service presents itself to visitors.</p></div>
        </header>
        <div class="settings-fields">
          <label><span>App name</span><small>The internal name shown in navigation and account areas.</small><input v-model="settingsForm.app_name" /></label>
          <label><span>Public title</span><small>The browser title and public-facing site name.</small><input v-model="settingsForm.public_title" /></label>
          <label class="span-2"><span>Base API URL</span><small>Leave blank to use this deployment’s default API.</small><input v-model="settingsForm.base_api_url" placeholder="https://papi.example.com" /></label>
        </div>
      </section>

      <section class="settings-group">
        <header class="settings-group-heading">
          <div><h3>Guardrails</h3><p>Set the boundaries for uploads and account access.</p></div>
        </header>
        <div class="settings-fields">
          <div class="setting-slider span-2">
            <div class="setting-slider-heading"><div><strong>File size limit</strong><small>Rejects any single upload larger than this amount. This applies to files and text pastes. Disabled means there is no application-level limit.</small></div><output>{{ fileSizeLimitLabel }}</output></div>
            <input v-model.number="fileSizeLimitGb" type="range" min="0" max="100" step="1" aria-label="Maximum file size in gigabytes" />
            <div class="range-labels"><span>Disabled</span><span>50 GB</span><span>100 GB</span></div>
          </div>
          <div class="upload-access-control span-2">
            <div><strong>Anonymous uploads</strong><small>Private requires an account or token. Public lets anyone upload without signing in.</small></div>
            <div class="upload-access-toggle" role="group" aria-label="Anonymous upload access">
              <button :aria-pressed="settingsForm.upload_access_mode === 'private'" :class="{ selected: settingsForm.upload_access_mode === 'private' }" aria-label="Private uploads" type="button" @click="settingsForm.upload_access_mode = 'private'"><strong>Private</strong><small>Account or token required</small></button>
              <button :aria-pressed="settingsForm.upload_access_mode === 'public'" :class="{ selected: settingsForm.upload_access_mode === 'public' }" aria-label="Public uploads" type="button" @click="settingsForm.upload_access_mode = 'public'"><strong>Public</strong><small>Anyone can upload</small></button>
            </div>
          </div>
          <label class="inline-check span-2"><input v-model="settingsForm.registration_enabled" type="checkbox" /> <span><strong>Allow new registrations</strong><small>When disabled, visitors can still sign in but cannot create accounts.</small></span></label>
          <label class="inline-check span-2"><input v-model="settingsForm.passkeys_enabled" type="checkbox" /> <span><strong>Enable passkeys</strong><small>Allow passkey registration and passwordless login for supported browsers.</small></span></label>
          <label class="inline-check span-2"><input v-model="settingsForm.turnstile_enabled" type="checkbox" /> <span><strong>Enable Turnstile</strong><small>Require Cloudflare Turnstile verification before account login.</small></span></label>
          <div v-if="settingsForm.turnstile_enabled" class="settings-fields span-2">
            <label class="turnstile-key-field"><span>Turnstile site key</span><small>Public site key shown in the browser.</small><input v-model="settingsForm.turnstile_site_key" autocomplete="off" placeholder="Enter a new key to replace the existing one" /></label>
            <label class="turnstile-key-field"><span>Turnstile secret key</span><small>Private server verification key. It is never displayed after saving.</small><input v-model="settingsForm.turnstile_secret_key" type="password" autocomplete="new-password" :placeholder="turnstileSecretPlaceholder" /></label>
          </div>
        </div>
      </section>
      </div>

      <div class="settings-footer">
        <p>Changes apply to the public service after saving.</p>
        <button class="btn-orange" type="button" @click="saveSettings">Save settings</button>
      </div>
    </section>

    <section v-if="tab === 'Webhooks'" class="stack">
      <form class="card form-grid webhook-create" @submit.prevent="runAction(() => adminCreateWebhook({ url: webhookForm.url, events: webhookForm.events.split(',').map(v => v.trim()).filter(Boolean), secret: webhookForm.secret || undefined, enabled: webhookForm.enabled }), 'Webhook created')">
        <h2>Create webhook</h2>
        <p class="subtle">Choose which events should be delivered to this endpoint. You can test or disable it later.</p>
        <input v-model="webhookForm.url" placeholder="https://example.com/webhook" />
        <div class="webhook-events"><label v-for="event in webhookEventOptions" :key="event.value" class="event-option"><input :checked="webhookForm.events.split(',').includes(event.value)" type="checkbox" @change="($event.target as HTMLInputElement).checked ? webhookForm.events = [...new Set([...webhookForm.events.split(',').filter(Boolean), event.value])].join(',') : webhookForm.events = webhookForm.events.split(',').filter(value => value !== event.value).join(',')" /><span><strong>{{ event.label }}</strong><small>{{ event.description }}</small></span></label></div>
        <input v-model="webhookForm.secret" type="password" placeholder="secret replacement (optional)" />
        <label class="inline-check"><input v-model="webhookForm.enabled" type="checkbox" /> enabled</label>
        <button class="btn-orange" type="submit">Create webhook</button>
      </form>
      <div class="card">
        <div class="card-heading webhook-section-heading">
          <div><h2>Endpoints</h2><p class="subtle">Where Yaemipaste sends selected events.</p></div>
          <span class="subtle">{{ webhooks.length }} configured</span>
        </div>
        <div class="webhook-endpoint-list">
          <article v-for="hook in pagedWebhooks" :key="hook.id" class="webhook-endpoint">
            <div class="webhook-endpoint-main">
              <div class="webhook-endpoint-topline">
                <span class="status-badge" :class="hook.enabled ? 'status-enabled' : 'status-disabled'">
                  <span class="status-dot" aria-hidden="true"></span>{{ hook.enabled ? 'Enabled' : 'Disabled' }}
                </span>
                <span class="webhook-kind">Webhook endpoint</span>
              </div>
              <code class="webhook-url" :title="hook.url">{{ hook.url }}</code>
              <div class="webhook-event-list" aria-label="Subscribed events">
                <span v-for="event in hook.events" :key="event" class="webhook-event-chip">{{ webhookEventLabel(event) }}</span>
              </div>
            </div>
            <div class="webhook-endpoint-meta">
              <div class="webhook-endpoint-actions">
                <button class="btn-ghost" type="button" @click="runAction(() => adminUpdateWebhook(hook.id, { enabled: !hook.enabled }), 'Webhook updated')">{{ hook.enabled ? 'Disable' : 'Enable' }}</button>
                <button class="btn-ghost" type="button" @click="runAction(() => adminTestWebhook(hook.id), 'Webhook test queued')">Test</button>
                <button class="btn-red" type="button" @click="deleteWebhookWithConfirmation(hook)">Delete</button>
              </div>
            </div>
          </article>
        </div>
        <p v-if="!pagedWebhooks.length && !loading" class="empty-state">No webhooks configured yet.</p>
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
        <div class="table-scroll">
         <table class="file-table admin-table webhook-deliveries-table">
           <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Result</th></tr></thead>
           <tbody>
             <tr v-for="delivery in pagedDeliveries" :key="delivery.id">
               <td data-label="Time">{{ ts(delivery.created_at) }}</td><td data-label="Event">{{ delivery.event }}</td><td data-label="Status">{{ delivery.status }}</td><td data-label="Result">{{ delivery.error ?? delivery.status_code ?? 'N/A' }}</td>
            </tr>
          </tbody>
        </table>
        </div>
         <p v-if="!deliveries.length && !loading" class="empty-state">No webhook deliveries recorded yet.</p>
         <div class="pagination-bar" aria-label="Delivery pagination">
           <span>{{ pageLabel('Deliveries', deliveries.length) }}</span>
           <div>
             <button class="btn-ghost" type="button" :disabled="pageFor('Deliveries', deliveries.length) <= 1" @click="setPage('Deliveries', pageFor('Deliveries', deliveries.length) - 1, deliveries.length)">Previous</button>
             <button class="btn-ghost" type="button" :disabled="pageFor('Deliveries', deliveries.length) >= deliveriesPageCount" @click="setPage('Deliveries', pageFor('Deliveries', deliveries.length) + 1, deliveries.length)">Next</button>
           </div>
         </div>
      </div>
    </section>

    <section v-if="tab === 'Audit'" class="card">
      <h2>Audit log</h2>
      <div class="table-scroll audit-table-scroll">
      <table class="file-table admin-table audit-table">
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Status</th><th>Reason</th></tr></thead>
        <tbody>
          <tr v-for="entry in pagedAudit" :key="entry.id">
            <td data-label="Time">{{ ts(entry.created_at) }}</td><td data-label="Actor">{{ entry.actor ?? 'system' }}</td><td data-label="Action">{{ entry.action }}</td><td data-label="Target">{{ entry.target ?? 'N/A' }}</td><td data-label="Status">{{ entry.status }}</td><td data-label="Reason">{{ entry.reason ?? 'N/A' }}</td>
          </tr>
        </tbody>
      </table>
      </div>
      <p v-if="!pagedAudit.length && !loading" class="empty-state">No audit entries yet.</p>
      <div class="pagination-bar" aria-label="Audit pagination">
        <span>{{ pageLabel('Audit', audit.length) }}</span>
        <div>
          <button class="btn-ghost" type="button" :disabled="pageFor('Audit', audit.length) <= 1" @click="setPage('Audit', pageFor('Audit', audit.length) - 1, audit.length)">Previous</button>
          <button class="btn-ghost" type="button" :disabled="pageFor('Audit', audit.length) >= auditPageCount" @click="setPage('Audit', pageFor('Audit', audit.length) + 1, audit.length)">Next</button>
        </div>
      </div>
    </section>
    </div>
    </Transition>
    </div>
      </section>
    </div>

    <ActionConfirmDialog
      v-if="confirmationRequest"
      v-model:acknowledged="confirmationAcknowledged"
      :title="confirmationRequest.title"
      :message="confirmationRequest.message"
      :detail="confirmationRequest.detail"
      :confirm-label="confirmationRequest.confirmLabel"
      :busy="confirmationBusy"
      danger
      @close="closeConfirmation"
      @confirm="submitConfirmation"
    />

    <div v-if="tokenDialog" class="token-dialog-backdrop" @click.self="tokenDialog = null">
      <div class="token-dialog" role="dialog" aria-modal="true" aria-labelledby="token-dialog-title">
        <div class="token-dialog-header">
          <div>
            <p class="eyebrow">One-time credential</p>
            <h2 id="token-dialog-title">{{ tokenDialog.kind === 'registration' ? 'Registration token ready' : 'Upload token ready' }}</h2>
          </div>
          <button class="btn-ghost" type="button" aria-label="Close token dialog" @click="tokenDialog = null">✕</button>
        </div>
        <p class="subtle">{{ tokenDialog.kind === 'registration' ? 'This single-use token can create one account.' : `Token for ${tokenDialog.username}.` }} Save it now; it will not be shown again.</p>
        <p v-if="tokenDialog.expiresAt" class="subtle token-expiry">Expires {{ formatTimestamp(tokenDialog.expiresAt) }}</p>
        <code class="token-value">{{ tokenDialog.token }}</code>
        <div class="token-dialog-actions">
          <button class="btn-ghost" type="button" @click="copyToken">{{ tokenCopied ? 'Copied' : 'Copy token' }}</button>
          <button class="btn-primary" type="button" @click="tokenDialog = null">Done</button>
        </div>
      </div>
    </div>

</template>

<style scoped>
.admin-content-stage {
  position: relative;
  display: grid;
  min-width: 0;
  max-width: 100%;
}
.admin-content-stage > * {
  grid-area: 1 / 1;
  min-width: 0;
  max-width: 100%;
}
.admin-content-panel {
  min-width: 0;
  max-width: 100%;
}
.admin-content-enter-active,
.admin-content-leave-active {
  transition: opacity 240ms var(--ease-out), transform 240ms var(--ease-out);
  will-change: opacity, transform;
}
.admin-content-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.admin-content-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.admin-layout {
  max-width: 1120px;
  width: 100%;
  min-width: 0;
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
.user-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  min-width: 124px;
}
.user-actions-cell {
  display: table-cell;
  vertical-align: middle;
  padding-right: var(--space-3);
}
.user-actions > .btn-red,
.user-more {
  min-height: 34px;
}
.user-actions > .btn-red {
  min-width: 80px;
}
.user-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding-inline: var(--space-2);
  min-width: 36px;
  font-size: var(--fs-h2);
  line-height: 1;
}
.user-more-label { display: none; }
.user-row-menu-panel {
  position: fixed;
  z-index: 1000;
  width: min(212px, calc(100vw - 16px));
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border2);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: 0 14px 32px var(--shadow);
}
.user-row-menu-panel .menu-action {
  display: block;
  width: 100%;
  min-height: 40px;
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text2);
  text-align: left;
  white-space: nowrap;
}
.user-row-menu-panel .menu-action:hover:not(:disabled) {
  background: var(--surface2);
  color: var(--text);
}
.user-row-menu-panel .menu-action.danger {
  color: var(--red-h);
}
.user-actions .btn-red {
  border-color: color-mix(in srgb, var(--red) 42%, var(--border));
  background: color-mix(in srgb, var(--red) 7%, transparent);
  color: var(--red-h);
}
.user-actions .btn-red:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--red) 72%, var(--border));
  background: color-mix(in srgb, var(--red) 14%, transparent);
  color: var(--red-h);
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
.admin-tabs-wrap {
  min-width: 0;
}
.admin-tabs-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 20px;
}
.admin-tabs {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  max-width: 100%;
  overflow-x: auto;
  scroll-behavior: smooth;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  border-color: color-mix(in srgb, var(--border2) 70%, transparent);
  background: transparent;
  box-shadow: none;
}
.admin-tabs::-webkit-scrollbar {
  display: none;
}
.admin-tabs button {
  position: relative;
  flex: 0 0 auto;
  min-width: max-content;
  overflow: visible;
  white-space: nowrap;
}
.admin-tabs button.active::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 0;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--accent);
}
.admin-tabs-scroll-button {
  display: none;
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
.create-mode-panel {
  display: grid;
  gap: var(--space-3);
}
.create-user-card {
  display: grid;
  gap: var(--space-3);
}
.create-mode-tabs {
  display: inline-flex;
  width: fit-content;
  gap: var(--space-1);
  padding: 3px;
  border: 1px solid var(--border2);
  border-radius: var(--radius-md);
  background: var(--bg);
}
.create-mode-tabs button {
  min-width: 84px;
  border-color: transparent;
}
.create-mode-tabs button.active {
  border-color: var(--border2);
  background: var(--surface2);
  color: var(--text);
}
.token-help {
  margin: 0;
}
.registration-expiry-picker {
  position: relative;
  width: min(100%, 190px);
}
.registration-expiry-trigger {
  width: 100%;
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 7px 10px;
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  background: var(--surface2);
  color: var(--text);
  text-align: left;
}
.registration-expiry-trigger:hover,
.registration-expiry-picker.open .registration-expiry-trigger {
  border-color: var(--accent);
  background: var(--surface3);
}
.registration-expiry-trigger span { display: grid; gap: 2px; }
.registration-expiry-trigger small { color: var(--text2); font-size: 10px; line-height: 1; }
.registration-expiry-trigger strong { font-size: var(--fs-sm); line-height: 1.2; }
.registration-expiry-trigger svg {
  width: 14px;
  height: 14px;
  flex: none;
  fill: none;
  stroke: var(--text2);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  transition: transform .15s ease;
}
.registration-expiry-picker.open .registration-expiry-trigger svg { transform: rotate(180deg); }
.registration-expiry-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  left: 0;
  width: max-content;
  min-width: 100%;
  display: grid;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--border2);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: 0 14px 28px #0007;
}
.registration-expiry-menu button {
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text2);
  font-size: var(--fs-xs);
  text-align: left;
}
.registration-expiry-menu button:hover,
.registration-expiry-menu button.selected {
  border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
  background: color-mix(in srgb, var(--accent) 12%, var(--surface2));
  color: var(--text);
}
.registration-expiry-menu button span { color: var(--accent-h); }
.registration-token-list-card { display: grid; gap: var(--space-3); }
.registration-token-heading-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.registration-token-count {
  align-self: center;
  color: var(--text2);
  font-size: var(--fs-xs);
  font-weight: 500;
  white-space: nowrap;
}
.registration-token-count strong { color: var(--text); font-variant-numeric: tabular-nums; }
.registration-token-list { display: grid; gap: var(--space-2); }
.registration-token-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--surface2) 55%, transparent);
}
.registration-token-mark {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  color: var(--text3);
  font-size: 19px;
}
.registration-token-mark svg { width: 19px; height: 19px; }
.registration-token-main { min-width: 0; display: grid; gap: 3px; }
.registration-token-main strong { overflow: hidden; color: var(--text); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.registration-token-main span { overflow: hidden; color: var(--text2); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
.registration-token-status {
  color: var(--green);
  font-size: var(--fs-xs);
  font-weight: 500;
  white-space: nowrap;
}
.registration-token-status.expired,
.registration-token-status.revoked,
.registration-token-status.used { color: var(--text3); }
.registration-token-row.status-expired,
.registration-token-row.status-revoked { opacity: .78; }
.registration-token-empty {
  display: grid;
  gap: 3px;
  justify-items: start;
  padding: var(--space-4) var(--space-2);
}
.registration-token-empty strong { color: var(--text); font-size: var(--fs-sm); }
.registration-token-empty span { color: var(--text2); }
.form-grid label {
  display: grid;
  gap: var(--space-1);
  color: var(--text2);
  font-size: var(--fs-xs);
}
.settings-page {
  width: 100%;
  display: grid;
  gap: clamp(var(--space-4), 3vw, var(--space-6));
}
.settings-intro {
  max-width: 720px;
  padding: clamp(var(--space-4), 4vw, var(--space-6));
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg);
  background: linear-gradient(120deg, color-mix(in srgb, var(--accent) 10%, var(--surface)), var(--surface) 62%);
}
.settings-eyebrow {
  margin-bottom: var(--space-2);
  color: var(--accent);
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.settings-intro h2 {
  margin-bottom: var(--space-2);
  font-size: clamp(24px, 3vw, 34px);
  letter-spacing: -0.035em;
}
.settings-intro .subtle {
  max-width: 60ch;
  color: var(--text2);
  line-height: var(--lh-body);
}
.settings-groups {
  display: grid;
  gap: var(--space-4);
}
.settings-group {
  display: grid;
  grid-template-columns: minmax(190px, .55fr) minmax(0, 1fr);
  gap: clamp(var(--space-4), 5vw, var(--space-7));
  padding: clamp(var(--space-4), 3vw, var(--space-6));
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface) 92%, var(--bg));
}
.settings-group-heading {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}
.settings-group-heading h3 {
  margin: 0 0 4px;
  color: var(--text);
  font-size: var(--fs-md);
}
.settings-group-heading p {
  max-width: 28ch;
  color: var(--text3);
  font-size: var(--fs-xs);
  line-height: 1.5;
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
.settings-fields label > span,
.settings-fields label > small,
.inline-check small,
.setting-slider small,
.event-option small {
  display: block;
}
.settings-fields label > small,
.inline-check small,
.setting-slider small,
.event-option small {
  margin-top: 4px;
  color: var(--text3);
  font-size: var(--fs-xs);
  font-weight: 400;
}
.setting-slider-heading {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: flex-start;
}
.setting-slider output { color: var(--accent); font-weight: 600; white-space: nowrap; }
.setting-slider input[type="range"] { width: 100%; margin-top: var(--space-4); accent-color: var(--accent); }
.range-labels { display: flex; justify-content: space-between; color: var(--text3); font-size: var(--fs-xs); }
.upload-access-control {
  display: grid;
  gap: var(--space-2);
}
.upload-access-control > div:first-child > small {
  display: block;
  margin-top: 4px;
  color: var(--text3);
  font-size: var(--fs-xs);
  font-weight: 400;
}
.upload-access-toggle {
  display: grid;
  width: fit-content;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--surface2) 62%, var(--bg));
}
.upload-access-toggle button {
  min-height: 34px;
  padding: 6px var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text3);
  text-align: left;
  transition: background .16s ease, border-color .16s ease, box-shadow .16s ease, color .16s ease;
}
.upload-access-toggle button:hover { color: var(--text); background: color-mix(in srgb, var(--surface2) 72%, transparent); }
.upload-access-toggle button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.upload-access-toggle button small { display: none; }
.upload-access-toggle button.selected {
  border-color: var(--border2);
  background: var(--surface);
  box-shadow: 0 1px 2px rgb(0 0 0 / .18);
  color: var(--text);
}
.upload-access-toggle button.selected strong { color: var(--text); }
.webhook-create > .subtle { margin-top: calc(var(--space-2) * -1); }
.webhook-events { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
.event-option { display: flex; gap: var(--space-2); align-items: flex-start; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.event-option strong { font-weight: 500; }
.webhook-section-heading {
  margin-bottom: var(--space-4);
}
.webhook-section-heading h2 {
  margin-bottom: var(--space-1);
}
.webhook-endpoint-list {
  display: grid;
  gap: var(--space-2);
}
.webhook-endpoint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--surface2) 48%, transparent);
}
.webhook-endpoint-main {
  min-width: 0;
  display: grid;
  gap: var(--space-2);
}
.webhook-endpoint-topline,
.webhook-event-list,
.webhook-endpoint-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.status-badge,
.webhook-signing,
.webhook-kind,
.webhook-event-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 3px 9px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  white-space: nowrap;
}
.status-enabled {
  color: var(--green);
  border: 1px solid color-mix(in srgb, var(--green) 52%, var(--border));
  background: color-mix(in srgb, var(--green) 16%, var(--surface2));
  font-weight: 600;
}
.status-disabled {
  color: var(--text2);
  background: color-mix(in srgb, var(--surface3) 72%, transparent);
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.webhook-kind,
.webhook-signing {
  color: var(--text2);
  background: color-mix(in srgb, var(--surface3) 52%, transparent);
}
.webhook-signing.is-signed { color: var(--accent); }
.webhook-signing.is-unsigned { color: var(--text3); }
.webhook-event-chip {
  color: var(--text2);
  border: 1px solid color-mix(in srgb, var(--border2) 70%, transparent);
  background: transparent;
}
.webhook-url {
  display: block;
  max-width: min(680px, 62vw);
  overflow: hidden;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.webhook-endpoint-meta {
  flex: none;
  display: grid;
  justify-items: end;
  gap: var(--space-2);
}
.webhook-endpoint-actions button {
  min-width: 68px;
}
.span-2 {
  grid-column: 1 / -1;
}
.settings-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-4);
  padding-top: var(--space-2);
}
.settings-footer p {
  margin-right: auto;
  color: var(--text3);
  font-size: var(--fs-xs);
}
.settings-footer .btn-orange {
  min-width: 160px;
}
.inline-check {
  display: flex !important;
  align-items: center;
  gap: var(--space-2);
}
.inline-check.span-2 > span > strong {
  font-weight: 500;
}
.upload-toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: center;
  margin-bottom: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
}
.upload-toolbar-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.upload-search {
  position: relative;
  display: flex;
  align-self: stretch;
  min-height: 48px;
}
.upload-search input {
  width: min(450px, 48vw);
  height: 100%;
  min-height: 48px;
  padding-right: 38px;
}
.upload-search-placeholder {
  position: absolute;
  top: 50%;
  left: 11px;
  right: 38px;
  overflow: hidden;
  color: var(--text3);
  pointer-events: none;
  text-overflow: ellipsis;
  transform: translateY(-50%);
  white-space: nowrap;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.upload-search-placeholder strong {
  color: var(--text2);
  font-weight: 700;
}
.upload-search input:focus + .upload-search-placeholder {
  opacity: 0;
}
.upload-search svg {
  position: absolute;
  top: 50%;
  right: var(--space-3);
  color: var(--text3);
  pointer-events: none;
  transform: translateY(-50%);
}
.upload-list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
}
.upload-latest {
  margin-left: auto;
  color: var(--text2);
  font-size: var(--fs-xs);
}
.upload-selection-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.upload-selection-bar .select-all {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-sm);
}
.upload-selection-bar .selection-count {
  color: var(--text2);
  font-size: var(--fs-xs);
}
.select-all-pages,
.all-pages-selected {
  color: var(--accent-h);
  font-size: var(--fs-xs);
}
.select-all-pages {
  padding: var(--space-1) var(--space-2);
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.select-all-pages:hover:not(:disabled) {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.clear-selection {
  padding: var(--space-1) var(--space-2);
  border: 0;
  background: transparent;
  color: var(--text3);
  font-size: var(--fs-xs);
}
.clear-selection:hover:not(:disabled) {
  color: var(--text);
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
.admin-table tbody tr {
  transition: none;
}
.admin-table tbody tr:hover td {
  background: color-mix(in srgb, var(--bg2) 42%, transparent);
}
.admin-table tbody tr:has(input[type="checkbox"]:checked) td {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.card {
  min-width: 0;
  border-radius: var(--radius-md);
  padding: var(--space-5);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  box-shadow: 0 16px 32px color-mix(in srgb, var(--shadow) 12%, transparent);
}
.card-heading {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
}
.card-heading h2 {
  margin-bottom: 0;
}
.btn-sm {
  min-height: 32px;
  padding: var(--space-1) var(--space-3);
  font-size: var(--fs-xs);
}
.table-scroll {
  overflow-x: auto;
}
.upload-table-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 34px;
}
.upload-table-toolbar .page-size-wrap {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.upload-table-toolbar .page-size-label {
  color: var(--text2);
  font-size: var(--fs-xs);
}
.page-size-segment {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--bg);
}
.page-size-btn {
  min-width: 34px;
  min-height: 28px;
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text2);
  font-size: var(--fs-xs);
}
.page-size-btn.active,
.page-size-btn:hover:not(:disabled) {
  background: var(--bg2);
  color: var(--text);
}
.admin-actions-menu {
  position: relative;
}
.upload-actions-trigger {
  min-height: 34px;
  padding-inline: var(--space-3);
}
.admin-actions-menu-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 8;
  width: 190px;
  padding: 4px;
  border: 1px solid var(--border2);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: 0 14px 32px var(--shadow);
}
.admin-actions-menu-panel .menu-action {
  display: block;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text2);
  text-align: left;
}
.admin-actions-menu-panel .menu-action:hover:not(:disabled) {
  background: var(--surface2);
  color: var(--text);
}
.admin-actions-menu-panel .menu-action.danger:hover:not(:disabled) {
  color: var(--red-h);
}
@media (max-width: 600px) {
  .uploads-table-scroll {
    overflow-x: visible;
    box-shadow: none;
  }
  .upload-toolbar,
  .upload-toolbar-main {
    align-items: stretch;
  }
  .upload-search,
  .upload-search input,
  .upload-toolbar > .btn-red {
    width: 100%;
  }
  .upload-list-toolbar {
    align-items: stretch;
  }
  .upload-table-toolbar {
    justify-content: space-between;
  }
  .upload-latest {
    order: 3;
    width: 100%;
    margin-left: 0;
  }
  .upload-table-toolbar .page-size-label {
    display: none;
  }
  .upload-table-toolbar .page-size-segment {
    height: 34px;
    min-height: 34px;
    padding: 2px;
  }
  .upload-table-toolbar .page-size-btn {
    width: 34px;
    min-width: 34px;
    height: 28px;
    min-height: 28px !important;
    margin: 0;
    padding: 2px 6px;
    line-height: 1;
  }
  .admin-actions-menu-panel {
    right: 0;
  }
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
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text2);
  font-size: var(--fs-body);
  background: color-mix(in srgb, var(--surface) 86%, transparent);
}
.info-box::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: adminLoadingPulse 1.1s ease-in-out infinite;
}
@keyframes adminLoadingPulse {
  0%, 100% { opacity: 0.3; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
.danger-card {
  position: relative;
  border-color: var(--error-border);
}
.danger-card p + p {
  margin-top: var(--space-1);
}
.admin-layout input:not([type="checkbox"]) {
  transition: border-color var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.admin-layout input:not([type="checkbox"]):hover:not(:disabled) {
  border-color: var(--text3);
}
.admin-layout input:not([type="checkbox"]):active:not(:disabled) {
  transform: none;
}
.admin-layout input[type="checkbox"] {
  cursor: pointer;
}
.admin-layout .upload-selection-bar .select-all input[type="checkbox"]:disabled,
.admin-layout .admin-table th.select-col input[type="checkbox"]:disabled {
  border-color: color-mix(in srgb, var(--text3) 82%, var(--border2));
  background: color-mix(in srgb, var(--text3) 28%, var(--surface2));
  color: var(--text3);
  opacity: 1;
  cursor: not-allowed;
}
.admin-layout .selection-disabled {
  pointer-events: none;
}
.admin-layout button:not(:disabled) {
  transition: transform var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.admin-layout button:not(:disabled):hover {
  transform: none;
}
.admin-layout button:not(:disabled):active {
  transform: none;
}
.empty-state {
  padding: var(--space-4) 0 0;
  color: var(--text3);
  font-size: var(--fs-body);
  text-align: center;
}
.upload-empty-state {
  margin-top: var(--space-2);
  padding: var(--space-6) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg);
  text-align: center;
}
.upload-empty-state strong {
  display: block;
  margin-bottom: var(--space-2);
  color: var(--text);
  font-size: var(--fs-h1);
  font-weight: 600;
}
.upload-empty-state p {
  color: var(--text2);
  font-size: var(--fs-h2);
  line-height: var(--lh-body);
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
  font-size: var(--fs-sm);
}
.pagination-bar > div {
  display: flex;
  gap: var(--space-2);
}
.pagination-bar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.token-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--modal-bg);
}
.token-dialog {
  width: min(520px, calc(100vw - 24px));
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: var(--space-5);
  box-shadow: 0 24px 64px color-mix(in srgb, var(--shadow) 90%, transparent);
}
.token-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.token-dialog-header h2 {
  margin-bottom: var(--space-1);
}
.token-value {
  display: block;
  margin-top: var(--space-4);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--accent-h);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  overflow-wrap: anywhere;
  user-select: all;
}
.token-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.token-expiry {
  margin-top: var(--space-2);
}
@media (max-width: 760px) {
  .admin-header { flex-direction: column; }
  .admin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tabs button { padding: var(--space-2) var(--space-4); }
  .webhook-endpoint {
    align-items: stretch;
    flex-direction: column;
  }
  .webhook-url {
    max-width: 100%;
  }
  .webhook-endpoint-meta {
    justify-items: stretch;
  }
  .webhook-endpoint-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .webhook-endpoint-actions button {
    width: 100%;
  }
  .registration-token-row {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .registration-token-heading-actions {
    align-items: flex-end;
    flex-direction: column;
    gap: var(--space-2);
  }
  .registration-token-status {
    grid-column: 2;
  }
  .registration-token-row > button {
    grid-column: 1 / -1;
    width: 100%;
  }
}
@media (max-width: 600px) {
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
  .admin-header {
    padding: var(--space-4);
  }
  .admin-tabs {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
  }
  .admin-tabs-row {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) 32px;
    align-items: center;
    gap: 8px;
  }
  .admin-tabs-scroll-button {
    display: inline-flex;
    width: 32px;
    height: 40px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text3);
    box-shadow: none;
    transition: opacity var(--duration-fast) var(--ease-out), background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out);
  }
  .admin-tabs-scroll-button:not(:disabled):hover,
  .admin-tabs-scroll-button:not(:disabled):focus-visible {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: var(--text);
  }
  .admin-tabs-scroll-button:not(:disabled):focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
    outline-offset: 2px;
  }
  .admin-tabs-scroll-button:disabled {
    color: var(--text3);
    opacity: 0.3;
    cursor: default;
  }
  .admin-tabs-scroll-button svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .admin-tabs {
    grid-column: 2;
    min-width: 0;
    justify-self: stretch;
    width: 100%;
    scroll-padding-inline: 12px;
    scroll-snap-type: x proximity;
    touch-action: pan-x;
    -webkit-overflow-scrolling: touch;
  }
  .admin-tabs-scroll-button--left { grid-column: 1; }
  .admin-tabs-scroll-button--right { grid-column: 3; }
  .admin-tabs button { scroll-snap-align: center; }
  .admin-tabs button.active::after {
    top: 0;
    bottom: auto;
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
  .registration-expiry-picker {
    width: 100%;
  }
  .admin-layout input[type="checkbox"] {
    width: 18px;
    height: 18px;
  }
}
.admin-table td,
.admin-table th {
  padding: var(--space-2) var(--space-3);
}
.upload-name-cell {
  min-width: 220px;
  white-space: nowrap;
}
.upload-file-icon,
.upload-name-link {
  border: 0;
  background: transparent;
  color: var(--text);
  vertical-align: middle;
}
.upload-file-icon {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-right: var(--space-2);
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  box-sizing: border-box;
  color: var(--text2);
  vertical-align: middle;
}
.upload-name-link {
  display: inline-flex;
  align-items: baseline;
  padding: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 500;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upload-name-link:hover .upload-filename-base { color: var(--accent); }
.upload-filename-base {
  max-width: min(38vw, 300px);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upload-filename-ext {
  flex-shrink: 0;
  color: var(--text2) !important;
  white-space: nowrap;
}
.upload-owner-cell {
  white-space: nowrap;
}
.upload-sharex-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: var(--space-2);
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--bg1);
  color: var(--text2);
  font-size: var(--fs-xs);
  line-height: 1;
}
.upload-sharex-badge img {
  width: 14px;
  height: 14px;
  object-fit: contain;
}
.upload-hover-preview {
  position: fixed;
  z-index: 300;
  width: 232px;
  max-width: calc(100vw - 32px);
  overflow: hidden;
  padding: var(--space-2);
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg);
  background: var(--bg1);
  box-shadow: 0 16px 40px color-mix(in srgb, var(--shadow) 88%, transparent);
  pointer-events: none;
}
.upload-hover-preview img {
  display: block;
  width: 100%;
  max-height: 150px;
  border-radius: var(--radius-sm);
  background: var(--bg);
  object-fit: contain;
}
.upload-hover-name {
  overflow: hidden;
  margin-top: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upload-row-actions {
  min-width: 270px;
  text-align: right;
  white-space: nowrap;
}
.upload-action,
.upload-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 86px;
  min-height: 34px;
  margin-left: var(--space-2);
  border-radius: var(--radius-sm);
  text-decoration: none;
}
.upload-row-actions > .upload-action:first-child {
  min-width: 120px;
  padding-inline: var(--space-3);
}
.upload-row-menu {
  position: relative;
  display: inline-block;
}
.upload-more {
  min-width: 36px;
  padding-inline: var(--space-2);
  font-size: var(--fs-h2);
  line-height: 1;
}
.upload-row-menu-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 12;
  width: 156px;
  padding: 4px;
  border: 1px solid var(--border2);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: 0 14px 32px var(--shadow);
  text-align: left;
}
.upload-row-menu-panel .menu-action {
  display: block;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text2);
  text-align: left;
  text-decoration: none;
}
.upload-row-menu-panel .menu-action:hover:not(:disabled) {
  background: var(--surface2);
  color: var(--text);
}
.upload-row-menu-panel .menu-action.danger:hover:not(:disabled) {
  color: var(--red-h);
}
@media (max-width: 820px) {
  .upload-row-actions {
    min-width: 118px;
    width: 118px;
  }
  .upload-action,
  .upload-more {
    width: 30px;
    min-width: 30px;
    min-height: 30px;
    margin-left: var(--space-1);
    padding: 3px !important;
  }
  .upload-action span { display: none; }
  .upload-action svg { width: 14px; height: 14px; }
  .upload-name-cell { min-width: 190px; }
}
@media (max-width: 600px) {
  .admin-table tbody tr:hover:not(:has(input[type="checkbox"]:checked)) td {
    background: transparent;
  }
  .webhook-section-heading {
    align-items: flex-start;
  }
  .webhook-endpoint {
    padding: var(--space-3);
  }
  .webhook-endpoint-actions {
    grid-template-columns: 1fr;
  }
  .uploads-table {
    min-width: 0;
  }
  .uploads-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .uploads-table,
  .uploads-table tbody,
  .uploads-table tr,
  .uploads-table td {
    display: block;
    width: 100%;
  }
  .uploads-table tbody {
    display: grid;
    gap: var(--space-2);
  }
  .uploads-table tbody tr {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: var(--space-2) var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .uploads-table td {
    min-width: 0;
    padding: 0;
    border: 0;
  }
  .uploads-table .select-col {
    grid-column: 1;
    grid-row: 1 / span 6;
  }
  .uploads-table .upload-name-cell,
  .uploads-table td[data-label] {
    grid-column: 2;
  }
  .uploads-table .upload-name-cell {
    display: flex;
    align-items: center;
    text-align: left;
    min-width: 0;
    white-space: normal;
  }
  .uploads-table .upload-name-link {
    width: auto;
    max-width: calc(100% - 36px);
    min-width: 0;
    align-items: center;
  }
  .uploads-table .upload-filename-base {
    flex: 0 1 auto;
    max-width: none;
  }
  .uploads-table td[data-label] {
    display: flex;
    gap: var(--space-2);
    color: var(--text2);
    font-size: var(--fs-xs);
  }
  .uploads-table td[data-label]::before {
    content: attr(data-label);
    flex: 0 0 52px;
    color: var(--text3);
  }
  .uploads-table .upload-owner-cell > span:first-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .uploads-table .upload-row-actions {
    grid-column: 1 / -1;
    grid-row: auto;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-2);
    align-items: stretch;
    width: auto;
    min-width: 0;
    padding: 0;
    margin-top: var(--space-1);
  }
  .admin-layout .uploads-table .upload-row-actions .upload-action,
  .admin-layout .uploads-table .upload-row-actions .upload-more {
    width: 100%;
    min-width: 0;
    min-height: 40px;
    margin: 0;
    padding: 0 var(--space-2) !important;
  }
  .uploads-table .upload-action span {
    display: inline;
  }
  .uploads-table .upload-action svg {
    flex: 0 0 14px;
  }
  .uploads-table .upload-owner-cell {
    flex-wrap: wrap;
  }
  .users-table-scroll {
    overflow-x: visible;
    box-shadow: none;
  }
  .users-table {
    min-width: 0;
  }
  .users-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .users-table,
  .users-table tbody,
  .users-table tr,
  .users-table td {
    display: block;
    width: 100%;
  }
  .users-table tbody {
    display: grid;
    gap: var(--space-2);
  }
  .users-table tbody tr {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--surface) 92%, transparent);
  }
  .users-table td {
    min-width: 0;
    padding: 0;
    border: 0;
  }
  .users-table .user-name-cell,
  .users-table .user-actions-cell {
    grid-column: 1 / -1;
  }
  .users-table td[data-label]:not(.user-name-cell):not(.user-actions-cell) {
    display: grid;
    gap: 2px;
    color: var(--text2);
    font-size: var(--fs-sm);
    overflow-wrap: anywhere;
  }
  .users-table td[data-label]:not(.user-name-cell):not(.user-actions-cell)::before {
    content: attr(data-label);
    color: var(--text3);
    font-size: var(--fs-xs);
  }
  .users-table .user-name-cell > span {
    color: var(--text);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .users-table .user-uploads-cell {
    display: none;
  }
  .users-table .user-actions-cell {
    display: block;
    margin-top: var(--space-1);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .users-table .user-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
    min-width: 0;
    gap: var(--space-2);
  }
  .users-table .user-more,
  .users-table .user-actions > .btn-red {
    width: 100%;
    min-width: 0;
    min-height: 40px;
  }
  .users-table .user-more {
    font-size: var(--fs-sm);
  }
  .users-table .user-more-icon {
    display: none;
  }
  .users-table .user-more-label {
    display: inline;
  }
  /* Keep every audit column available on phones, but contain the wide table
     inside its own scroll viewport so it cannot widen the page. */
  .audit-table-scroll {
    display: block;
    box-sizing: border-box;
    min-width: 0;
    min-inline-size: 0;
    width: 100%;
    max-width: 100%;
    overflow-x: scroll;
    overflow-y: hidden;
    touch-action: pan-x;
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
  }
  .audit-table {
    min-width: 720px;
    width: max-content;
  }
}
@media (max-width: 480px) {
  .admin-grid { grid-template-columns: minmax(0, 1fr); }
}

.settings-page {
  width: min(100%, 980px);
}
.settings-fields {
  gap: var(--space-5) var(--space-4);
}
.settings-fields label > span {
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 600;
}
.settings-fields label > small {
  max-width: 42ch;
  line-height: 1.45;
}
.settings-fields input:not([type="checkbox"]) {
  width: 100%;
  min-height: 40px;
  margin-top: var(--space-2);
  background: color-mix(in srgb, var(--bg2) 78%, var(--surface));
}
.turnstile-key-field { display: grid; grid-template-rows: auto minmax(calc(1.45em * 2), auto) auto; align-content: start; }
.settings-group-branding .settings-fields label:last-child {
  grid-column: 1 / -1;
}
.settings-group-branding .settings-fields label:last-child input {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
@media (max-width: 700px) {
  .settings-group {
    grid-template-columns: 1fr;
    gap: var(--space-4);
  }
  .settings-footer {
    align-items: stretch;
    flex-direction: column;
  }
  .settings-footer p {
    margin-right: 0;
  }
  .settings-footer .btn-orange {
    width: 100%;
  }
  .settings-group-branding .settings-fields label:last-child {
    grid-column: 1 / -1;
  }
}

@media (min-width: 701px) and (max-width: 900px) {
  .settings-group-branding .settings-fields label > small {
    min-height: calc(1.45em * 2);
  }
  .settings-group-branding .settings-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (min-width: 901px) {
  .settings-group-branding .settings-fields label > small {
    min-height: calc(1.45em * 2);
  }
  .settings-group-branding .settings-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
