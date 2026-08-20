<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { zipSync } from 'fflate'
import { fileUrl, formatTimestamp, getPasteApiBase, listFiles, deleteFile, formatBytes, getPublicFileMeta, publicPathRawFileUrl, shareUrl, uploadFile, type PasteFile, type PublicFileMeta } from '../lib/api'
import { decryptBlobWithPassword, decryptEncryptedBlob, encryptedShareUrl, getStoredEncryptedFile, isEncryptedBlob, rememberEncryptedFile } from '../lib/e2ee'
import FilePreview from './FilePreview.vue'
import ActionConfirmDialog from './ActionConfirmDialog.vue'
import SortArrow from './SortArrow.vue'
import { useNotificationStore } from '../stores/notifications'
import { usePublicSettings } from '../lib/publicSettings'
import sharexLogoUrl from '../assets/sharex-logo-white-transparent.png'

interface PreviewState {
  file: PasteFile
  url: string
  name: string
  type: string
  textContent?: string
  x: number
  y: number
  loading: boolean
}

interface CachedPreview {
  blob: Blob
  name: string
  type: string
  textContent?: string
}

type DeleteConfirmMode = 'all' | 'selected'

type PageSize = 15 | 30 | 45
const PAGE_SIZES: PageSize[] = [15, 30, 45]
const HISTORY_REFRESH_EVENT = 'rp:history-refresh'
const AUTO_REFRESH_MS = 2_000
const PASSWORD_CHANGE_LIMIT = 3
const PASSWORD_CHANGE_COUNT_KEY = 'rp_pw_change_counts'
const HISTORY_WS_ENV = (import.meta.env.VITE_HISTORY_WS ?? '').trim()
const TEXT_PREVIEW_BYTES = 256 * 1024
const TEXT_PREVIEW_CHARS = 32_000
const PREVIEW_CACHE_MAX_BYTES = 64 * 1024 * 1024
const PREVIEW_CACHE_ENTRY_MAX_BYTES = 24 * 1024 * 1024
const DELETE_CONCURRENCY = 6

const files = ref<PasteFile[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const searching = ref(false)
const sortKey = ref<'file_name' | 'file_size' | 'expires_at' | 'created_at'>('created_at')
const sortDir = ref<1 | -1>(-1)
const preview = ref<PreviewState | null>(null)
const hoverPreview = ref<PreviewState | null>(null)
const deleting = ref<Set<string>>(new Set())
const selectedFiles = ref<Set<string>>(new Set())
const actionsOpen = ref(false)
const rowMoreOpen = ref<string | null>(null)
const copiedFileName = ref<string | null>(null)
const bulkDeleting = ref(false)
const bulkDownloading = ref(false)
const pageSize = ref<PageSize>(15)
const currentPage = ref(1)
const actionsMenuRef = ref<HTMLElement | null>(null)
const fileMetaMap = ref<Record<string, PublicFileMeta>>({})
const passwordModalOpen = ref(false)
const passwordModalFile = ref<PasteFile | null>(null)
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const changingPassword = ref(false)
const passwordChangeError = ref('')
const passwordChangeStatus = ref('')
const passwordChangePercent = ref(0)
const passwordPreviewOpen = ref(false)
const passwordPreviewFile = ref<PasteFile | null>(null)
const passwordPreviewValue = ref('')
const passwordPreviewBusy = ref(false)
const passwordPreviewError = ref('')
const passwordPromptAction = ref<'preview' | 'download'>('preview')
const keyPreviewOpen = ref(false)
const keyPreviewFile = ref<PasteFile | null>(null)
const keyPreviewValue = ref('')
const keyPreviewBusy = ref(false)
const keyPreviewError = ref('')
const keyPromptAction = ref<'preview' | 'download'>('preview')
const deleteConfirmOpen = ref(false)
const deleteConfirmMode = ref<DeleteConfirmMode>('selected')
const deleteAcknowledged = ref(false)
const wsConnected = ref(false)
const compactFileNames = ref(window.matchMedia('(max-width: 820px)').matches)
const hoverEnabled = window.matchMedia('(hover: hover) and (pointer: fine)').matches
const notificationStore = useNotificationStore()
const router = useRouter()
const { refreshPublicSettings } = usePublicSettings()
let hoverToken = 0
let previewToken = 0
let compactFileNamesMediaQuery: MediaQueryList | null = null
let hoverAbortController: AbortController | null = null
let previewCacheBytes = 0
let historyRequestSequence = 0
let copiedFileTimer: ReturnType<typeof setTimeout> | null = null
let searchIndicatorTimer: ReturnType<typeof setTimeout> | null = null
const previewCache = new Map<string, CachedPreview>()
// A successful delete can race the periodic/WebSocket refresh with a briefly
// stale server snapshot. Keep the row hidden until a snapshot confirms that
// the server has removed it, so the UI never resurrects deleted history.
const optimisticDeletedFiles = new Set<string>()

function reconcileHistoryFiles(nextFiles: PasteFile[]): PasteFile[] {
  const serverNames = new Set(nextFiles.map((file) => file.file_name))
  for (const fileName of optimisticDeletedFiles) {
    if (!serverNames.has(fileName)) optimisticDeletedFiles.delete(fileName)
  }
  return nextFiles.filter((file) => !optimisticDeletedFiles.has(file.file_name))
}

async function readPreviewText(blob: Blob): Promise<string> {
  const previewText = await blob.slice(0, TEXT_PREVIEW_BYTES).text()
  if (blob.size > TEXT_PREVIEW_BYTES || previewText.length > TEXT_PREVIEW_CHARS) {
    return `${previewText.slice(0, TEXT_PREVIEW_CHARS)}\n\n…`
  }
  return previewText
}

function showToast(msg: string, type: 'success' | 'error' = 'success') {
  notificationStore.push(msg, type)
}

function readPasswordChangeCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PASSWORD_CHANGE_COUNT_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const next: Record<string, number> = {}
    for (const [name, count] of Object.entries(parsed as Record<string, unknown>)) {
      if (Number.isFinite(count) && Number(count) >= 0) next[name] = Number(count)
    }
    return next
  } catch {
    return {}
  }
}

function writePasswordChangeCounts(counts: Record<string, number>) {
  localStorage.setItem(PASSWORD_CHANGE_COUNT_KEY, JSON.stringify(counts))
}

function getPasswordChangeCount(fileName: string): number {
  return readPasswordChangeCounts()[fileName] ?? 0
}

function setPasswordChangeCount(fileName: string, count: number) {
  const counts = readPasswordChangeCounts()
  counts[fileName] = count
  writePasswordChangeCounts(counts)
}

function passwordChangesRemaining(fileName: string): number {
  return Math.max(0, PASSWORD_CHANGE_LIMIT - getPasswordChangeCount(fileName))
}

function mapRawHistoryFile(raw: Record<string, unknown>): PasteFile | null {
  if (typeof raw.file_name !== 'string' || !raw.file_name) return null
  const fileSize = Number(raw.file_size)
  return {
    file_name: raw.file_name,
    file_size: Number.isFinite(fileSize) ? fileSize : 0,
    expires_at: typeof raw.expires_at_utc === 'string' ? raw.expires_at_utc : null,
    created_at: typeof raw.creation_date_utc === 'string' ? raw.creation_date_utc : null,
  }
}

function applyHistorySnapshot(rawFiles: unknown[]) {
  const parsed: PasteFile[] = []
  for (const item of rawFiles) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const normalized = mapRawHistoryFile(item as Record<string, unknown>)
    if (normalized) parsed.push(normalized)
  }
  const reconciled = reconcileHistoryFiles(parsed)
  if (sameHistoryList(files.value, reconciled)) return
  files.value = reconciled
  const knownNames = new Set(files.value.map((file) => file.file_name))
  selectedFiles.value = new Set([...selectedFiles.value].filter((name) => knownNames.has(name)))
  fileMetaMap.value = Object.fromEntries(Object.entries(fileMetaMap.value).filter(([name]) => knownNames.has(name)))
}

function sameHistoryList(a: PasteFile[], b: PasteFile[]): boolean {
  if (a.length !== b.length) return false
  return a.every((file, index) => {
    const other = b[index]
    return file.file_name === other.file_name
      && file.file_size === other.file_size
      && file.expires_at === other.expires_at
      && file.created_at === other.created_at
  })
}

function resolveHistorySocketUrl(): string | null {
  const base = HISTORY_WS_ENV || (() => {
    try {
      const url = new URL(getPasteApiBase(), window.location.origin)
      const proto = url.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${proto}//${url.host}/ws/history`
    } catch {
      return ''
    }
  })()
  if (!base) return null
  try {
    const url = new URL(base, window.location.origin)
    if (window.location.protocol === 'https:' && url.protocol !== 'wss:') return null
    return getAuthToken() ? url.toString() : null
  } catch {
    return null
  }
}

async function load() {
  const sequence = ++historyRequestSequence
  files.value = []
  selectedFiles.value = new Set()
  fileMetaMap.value = {}
  loading.value = true
  error.value = ''
  try {
    const nextFiles = await listFiles()
    if (sequence !== historyRequestSequence) return
    files.value = reconcileHistoryFiles(nextFiles)
    const knownNames = new Set(files.value.map((file) => file.file_name))
    selectedFiles.value = new Set([...selectedFiles.value].filter((name) => knownNames.has(name)))
    fileMetaMap.value = Object.fromEntries(Object.entries(fileMetaMap.value).filter(([name]) => knownNames.has(name)))
    await ensureVisibleMeta()
  } catch (e: any) {
    if (sequence === historyRequestSequence) error.value = e.message
  } finally {
    if (sequence === historyRequestSequence) loading.value = false
  }
}

async function refreshSilently() {
  const sequence = ++historyRequestSequence
  try {
    const nextFiles = await listFiles()
    if (sequence !== historyRequestSequence) return
    const reconciled = reconcileHistoryFiles(nextFiles)
    if (sameHistoryList(files.value, reconciled)) return
    files.value = reconciled
    const knownNames = new Set(files.value.map((file) => file.file_name))
    selectedFiles.value = new Set([...selectedFiles.value].filter((name) => knownNames.has(name)))
    fileMetaMap.value = Object.fromEntries(Object.entries(fileMetaMap.value).filter(([name]) => knownNames.has(name)))
    await ensureVisibleMeta()
  } catch (e) {
    console.error('History auto-refresh failed', e)
  } finally {
    // A focus/refresh request can supersede the initial load. The active
    // request still owns the loading indicator and must release it.
    if (sequence === historyRequestSequence) loading.value = false
  }
}

function normalizeShareXField(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function hasShareXBadge(fileName: string): boolean {
  const meta = fileMetaMap.value[fileName]
  return normalizeShareXField(meta?.source) === 'sharex'
}

async function ensureVisibleMeta() {
  const missing = paginatedFiles.value
    .map((file) => file.file_name)
    .filter((name) => !fileMetaMap.value[name])
  if (!missing.length) return
  const entries = await Promise.all(missing.map(async (fileName) => {
    try {
      const meta = await getPublicFileMeta(fileName, true)
      return [fileName, meta] as const
    } catch {
      return null
    }
  }))
  const next = { ...fileMetaMap.value }
  for (const entry of entries) {
    if (!entry) continue
    next[entry[0]] = entry[1]
  }
  fileMetaMap.value = next
}

function setSort(key: typeof sortKey.value) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 1 ? -1 : 1
  else { sortKey.value = key; sortDir.value = 1 }
}

const filtered = computed(() => {
  const q = search.value.toLowerCase()
  return [...files.value]
    .filter((f) => f.file_name.toLowerCase().includes(q))
    .sort((a, b) => {
      const av = a[sortKey.value] ?? ''
      const bv = b[sortKey.value] ?? ''
      if (sortKey.value === 'file_size') return (Number(av) - Number(bv)) * sortDir.value
      if (sortKey.value === 'created_at') {
        const at = av ? Date.parse(String(av)) : 0
        const bt = bv ? Date.parse(String(bv)) : 0
        return (at - bt) * sortDir.value
      }
      return String(av).localeCompare(String(bv)) * sortDir.value
    })
})
const totalBytes = computed(() => files.value.reduce((sum, file) => sum + file.file_size, 0))
const encryptedCount = computed(() => files.value.filter(isEncryptedFile).length)
const expiringCount = computed(() => files.value.filter((file) => !!file.expires_at).length)
const latestFileDate = computed(() => {
  const timestamps = files.value
    .map((file) => file.created_at ? Date.parse(file.created_at) : 0)
    .filter((time) => Number.isFinite(time) && time > 0)
  if (!timestamps.length) return 'No uploads yet'
  return new Date(Math.max(...timestamps)).toLocaleString()
})
const deleteConfirmFiles = computed(() => deleteConfirmMode.value === 'all' ? files.value : selectedFilesList.value)
const deleteConfirmCount = computed(() => deleteConfirmFiles.value.length)
const deleteConfirmTitle = computed(() => deleteConfirmMode.value === 'all' ? 'Delete all files?' : 'Delete selected files?')
const deleteConfirmMessage = computed(() => {
  const count = deleteConfirmCount.value
  if (deleteConfirmMode.value === 'all') return `This will permanently delete ${count} file${count === 1 ? '' : 's'} from your history.`
  return `This will permanently delete ${count} selected file${count === 1 ? '' : 's'}.`
})

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)))
const paginatedFiles = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

async function copy(f: PasteFile) {
  try {
    const stored = getStoredEncryptedFile(f.file_name)
    const link = stored ? encryptedShareUrl(f.file_name, stored.key, stored.origin) : shareUrl(f.file_name)
    await navigator.clipboard.writeText(link)
    copiedFileName.value = f.file_name
    if (copiedFileTimer) clearTimeout(copiedFileTimer)
    copiedFileTimer = setTimeout(() => {
      if (copiedFileName.value === f.file_name) copiedFileName.value = null
      copiedFileTimer = null
    }, 1000)
    showToast(stored ? 'Copied link with decryption key' : 'Copied to clipboard')
  } catch {
    showToast('Copy failed', 'error')
  }
}

async function del(f: PasteFile) {
  if (deleting.value.has(f.file_name)) return
  if (rowMoreOpen.value === f.file_name) closeRowMoreMenu()
  if (passwordModalOpen.value && passwordModalFile.value?.file_name === f.file_name) closePasswordModal()
  if (passwordPreviewOpen.value && passwordPreviewFile.value?.file_name === f.file_name) closePasswordPreviewModal()
  if (hoverPreview.value?.file.file_name === f.file_name) hideHover()
  if (preview.value?.file.file_name === f.file_name) closePreview()
  deleting.value.add(f.file_name)
  try {
    await deleteFile(f.file_name)
    optimisticDeletedFiles.add(f.file_name)
    files.value = files.value.filter((x) => x.file_name !== f.file_name)
    selectedFiles.value.delete(f.file_name)
    showToast(`Deleted ${f.file_name}`)
  } catch (e: any) {
    showToast(e.message ?? 'Delete failed', 'error')
  } finally {
    deleting.value.delete(f.file_name)
  }
}

function requestDeleteAll() {
  if (!files.value.length || bulkDeleting.value) return
  deleteConfirmMode.value = 'all'
  deleteAcknowledged.value = false
  deleteConfirmOpen.value = true
  actionsOpen.value = false
  closeRowMoreMenu()
}

async function deleteAll() {
  const result = await deleteNamesConcurrently(files.value.map((file) => file.file_name))
  if (result.deleted) showToast(`Deleted ${result.deleted} file(s)`)
  if (result.failed) showToast(`${result.failed} file(s) could not be deleted`, 'error')
}

function previewName(f: PasteFile) {
  const stored = getStoredEncryptedFile(f.file_name)
  if (stored?.name) return stored.name
  const metadataName = fileMetaMap.value[f.file_name]?.display_name?.trim()
  if (metadataName) return metadataName
  if (f.file_name.toLowerCase().endsWith('.rpenc')) return f.file_name.slice(0, -6)
  return f.file_name
}

function isEncryptedFile(f: PasteFile): boolean {
  return f.file_name.toLowerCase().endsWith('.rpenc') || !!getStoredEncryptedFile(f.file_name)
}

function compactPreviewName(name: string, maxBase = 15): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  if (stem.length <= maxBase) return name
  return ext ? `${stem.slice(0, maxBase)}...${ext}` : `${stem.slice(0, maxBase)}...`
}

function displayName(f: PasteFile): string {
  const full = previewName(f)
  return compactFileNames.value ? compactPreviewName(full) : full
}

function splitDisplayName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' }
  return {
    base: name.slice(0, dot),
    ext: name.slice(dot),
  }
}

function displayBaseName(f: PasteFile): string {
  return splitDisplayName(displayName(f)).base
}

function displayExtension(f: PasteFile): string {
  return splitDisplayName(displayName(f)).ext
}

function isImage(name: string) { return /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico)$/i.test(name) }
function isVideo(name: string) { return /\.(mp4|webm|mov|avi|mkv|ogv|m4v|3gp)$/i.test(name) }
function isText(name: string) { return /\.(txt|md|markdown|csv|log|json|xml|ya?ml|toml|ini|conf|cfg|js|ts|tsx|jsx|py|rs|go|java|c|cc|cpp|h|hpp|css|html?)$/i.test(name) }
function previewKind(f: PasteFile): 'image' | 'video' | 'text' | 'none' {
  const mime = (fileMetaMap.value[f.file_name]?.mime_type ?? '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('text/')) return 'text'
  const name = previewName(f)
  if (isImage(name)) return 'image'
  if (isVideo(name)) return 'video'
  if (isText(name)) return 'text'
  return 'none'
}

function canInlinePreview(f: PasteFile): boolean {
  const stored = getStoredEncryptedFile(f.file_name)
  if (previewKind(f) === 'none') return false
  if (f.file_name.toLowerCase().endsWith('.rpenc')) return !!stored && !stored.key.startsWith('pw:')
  return true
}

function clearPreviewObjectUrl(state: PreviewState | null) {
  if (state?.url.startsWith('blob:')) URL.revokeObjectURL(state.url)
}

function previewCacheKey(file: PasteFile): string {
  return file.file_name
}

function cachedPreview(file: PasteFile): CachedPreview | null {
  const key = previewCacheKey(file)
  const entry = previewCache.get(key)
  if (!entry) return null
  // Refresh the entry's position to keep the cache least-recently-used.
  previewCache.delete(key)
  previewCache.set(key, entry)
  return entry
}

function cachePreview(file: PasteFile, entry: CachedPreview) {
  if (entry.blob.size > PREVIEW_CACHE_ENTRY_MAX_BYTES) return
  const key = previewCacheKey(file)
  const previous = previewCache.get(key)
  if (previous) previewCacheBytes -= previous.blob.size
  previewCache.set(key, entry)
  previewCacheBytes += entry.blob.size
  while (previewCacheBytes > PREVIEW_CACHE_MAX_BYTES) {
    const oldest = previewCache.entries().next().value as [string, CachedPreview] | undefined
    if (!oldest) break
    previewCache.delete(oldest[0])
    previewCacheBytes -= oldest[1].blob.size
  }
}

function previewStateFromCache(file: PasteFile, cached: CachedPreview, x: number, y: number): PreviewState {
  return {
    file,
    url: URL.createObjectURL(cached.blob),
    name: cached.name,
    type: cached.type,
    textContent: cached.textContent,
    x,
    y,
    loading: false,
  }
}

function isPasswordEncryptedFile(f: PasteFile): boolean {
  return getStoredEncryptedFile(f.file_name)?.key.startsWith('pw:') ?? false
}

function canDownloadEncrypted(f: PasteFile): boolean {
  const stored = getStoredEncryptedFile(f.file_name)
  return !!stored && !stored.key.startsWith('pw:')
}

function canChangeDecryptionPassword(f: PasteFile): boolean {
  return isPasswordEncryptedFile(f) && passwordChangesRemaining(f.file_name) > 0
}

function closeRowMoreMenu() {
  rowMoreOpen.value = null
}

function openPasswordModal(file: PasteFile) {
  if (!isPasswordEncryptedFile(file)) {
    showToast('Only password-encrypted files can change decryption password', 'error')
    return
  }
  if (!canChangeDecryptionPassword(file)) {
    showToast('Password change limit reached for this file', 'error')
    return
  }
  passwordModalOpen.value = true
  passwordModalFile.value = file
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  passwordChangeError.value = ''
  closeRowMoreMenu()
}

function doClosePasswordModal(force: boolean) {
  if (changingPassword.value && !force) return
  passwordModalOpen.value = false
  passwordModalFile.value = null
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  passwordChangeError.value = ''
  passwordChangeStatus.value = ''
  passwordChangePercent.value = 0
}

function closePasswordModal() {
  doClosePasswordModal(false)
}

function doClosePasswordPreviewModal(force: boolean) {
  if (passwordPreviewBusy.value && !force) return
  passwordPreviewOpen.value = false
  passwordPreviewFile.value = null
  passwordPreviewValue.value = ''
  passwordPreviewError.value = ''
  passwordPromptAction.value = 'preview'
}

function closePasswordPreviewModal() {
  doClosePasswordPreviewModal(false)
}

function openPasswordPreviewModal(file: PasteFile, action: 'preview' | 'download' = 'preview') {
  passwordPreviewOpen.value = true
  passwordPreviewFile.value = file
  passwordPreviewValue.value = ''
  passwordPreviewError.value = ''
  passwordPromptAction.value = action
}

function doCloseKeyPreviewModal(force: boolean) {
  if (keyPreviewBusy.value && !force) return
  keyPreviewOpen.value = false
  keyPreviewFile.value = null
  keyPreviewValue.value = ''
  keyPreviewError.value = ''
  keyPromptAction.value = 'preview'
}

function closeKeyPreviewModal() {
  doCloseKeyPreviewModal(false)
}

function openKeyPreviewModal(file: PasteFile, action: 'preview' | 'download' = 'preview') {
  keyPreviewOpen.value = true
  keyPreviewFile.value = file
  keyPreviewValue.value = ''
  keyPreviewError.value = ''
  keyPromptAction.value = action
}

function setPasswordChangeProgress(status: string, percent: number) {
  passwordChangeStatus.value = status
  passwordChangePercent.value = Math.max(0, Math.min(100, Math.round(percent)))
}

async function fetchEncryptedPayload(fileName: string, onProgress?: (percent: number) => void): Promise<Blob> {
  const response = await fetch(fileUrl(fileName), {
    cache: 'no-store',
    headers: { Authorization: getAuthToken() },
  })
  if (!response.ok) throw new Error('Could not download encrypted payload')
  const total = Number(response.headers.get('content-length') ?? 0)
  if (!response.body || !Number.isFinite(total) || total <= 0) {
    const payload = await response.blob()
    onProgress?.(100)
    if (!(await isEncryptedBlob(payload))) throw new Error('File payload is not encrypted')
    return payload
  }
  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let loaded = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    chunks.push(copy.buffer)
    loaded += value.byteLength
    onProgress?.(Math.max(1, Math.min(99, (loaded / total) * 100)))
  }
  onProgress?.(100)
  const payload = new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' })
  if (!(await isEncryptedBlob(payload))) throw new Error('File payload is not encrypted')
  return payload
}

async function submitPasswordChange() {
  const file = passwordModalFile.value
  if (!file) return
  const stored = getStoredEncryptedFile(file.file_name)
  if (!stored || !stored.key.startsWith('pw:')) {
    passwordChangeError.value = 'Password key is not available for this file.'
    return
  }
  if (!canChangeDecryptionPassword(file)) {
    passwordChangeError.value = 'Password change limit reached for this file.'
    return
  }
  if (!currentPassword.value.trim()) {
    passwordChangeError.value = 'Current password is required.'
    return
  }
  if (newPassword.value.length < 4) {
    passwordChangeError.value = 'New password must be at least 4 characters.'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    passwordChangeError.value = 'New passwords do not match.'
    return
  }
  if (newPassword.value === currentPassword.value) {
    passwordChangeError.value = 'New password must be different from the current password.'
    return
  }

  passwordChangeError.value = ''
  changingPassword.value = true
  setPasswordChangeProgress('Downloading encrypted file…', 0)
  try {
    const payload = await fetchEncryptedPayload(file.file_name, (percent) => {
      setPasswordChangeProgress('Downloading encrypted file…', percent * 0.4)
    })
    setPasswordChangeProgress('Decrypting with current password…', 40)
    const decrypted = await decryptBlobWithPassword(payload, currentPassword.value, stored.key.slice(3))
    const baseName = file.file_name.endsWith('.rpenc') ? file.file_name.slice(0, -6) : decrypted.metadata.name
    const plainFile = new File([decrypted.blob], baseName, {
      type: decrypted.metadata.type || 'application/octet-stream',
    })
    setPasswordChangeProgress('Uploading new encrypted file…', 45)
    const upload = await uploadFile(plainFile, {
      password: newPassword.value,
      keepFileName: true,
      onProgress: (progress) => {
        if (progress.phase === 'encrypting') {
          setPasswordChangeProgress('Uploading new encrypted file…', 45 + (progress.percent / 100) * 30)
          return
        }
        if (progress.phase === 'uploading') {
          setPasswordChangeProgress('Uploading new encrypted file…', 75 + (progress.percent / 100) * 24)
          return
        }
        setPasswordChangeProgress('Uploading new encrypted file…', 99)
      },
    })
    const nextFileName = upload.fileName
    setPasswordChangeProgress('Finalizing history…', 100)
    const nextCount = getPasswordChangeCount(file.file_name) + 1
    setPasswordChangeCount(file.file_name, nextCount)
    if (nextFileName && nextFileName !== file.file_name) setPasswordChangeCount(nextFileName, nextCount)
    showToast('Decryption password updated')
    closeRowMoreMenu()
    doClosePasswordModal(true)
    void (async () => {
      try {
        if (nextFileName && nextFileName !== file.file_name) {
          await deleteFile(file.file_name)
          files.value = files.value.filter((item) => item.file_name !== file.file_name)
          selectedFiles.value.delete(file.file_name)
        }
        await refreshSilently()
      } catch (error) {
        console.error('Password change post-refresh failed', error)
      }
    })()
  } catch (e: any) {
    passwordChangeError.value = e.message ?? 'Could not change decryption password'
  } finally {
    changingPassword.value = false
    passwordChangeStatus.value = ''
    passwordChangePercent.value = 0
  }
}

function isPreviewMimeType(type: string, name: string): boolean {
  if (type.startsWith('image/') || type.startsWith('video/') || type.startsWith('text/')) return true
  return isImage(name) || isVideo(name) || isText(name)
}

async function submitPasswordPreview() {
  const file = passwordPreviewFile.value
  if (!file) return
  const stored = getStoredEncryptedFile(file.file_name)
  if (!stored || !stored.key.startsWith('pw:')) {
    passwordPreviewError.value = 'Password key is not available for this file.'
    return
  }
  if (!passwordPreviewValue.value.trim()) {
    passwordPreviewError.value = 'Decryption password is required.'
    return
  }
  passwordPreviewError.value = ''
  passwordPreviewBusy.value = true
  try {
    const payload = await fetchEncryptedPayload(file.file_name)
    const decrypted = await decryptBlobWithPassword(payload, passwordPreviewValue.value, stored.key.slice(3))
    if (passwordPromptAction.value === 'download') {
      triggerDownload(decrypted.blob, decrypted.metadata.name)
      doClosePasswordPreviewModal(true)
      return
    }
    if (!isPreviewMimeType(decrypted.metadata.type, decrypted.metadata.name)) {
      throw new Error('This password-encrypted file type has no inline preview')
    }
    const textContent = isText(decrypted.metadata.name) ? await readPreviewText(decrypted.blob) : undefined
    clearPreviewObjectUrl(preview.value)
    preview.value = {
      file,
      url: URL.createObjectURL(decrypted.blob),
      name: decrypted.metadata.name,
      type: decrypted.metadata.type,
      textContent,
      x: 0,
      y: 0,
      loading: false,
    }
    doClosePasswordPreviewModal(true)
  } catch (e: any) {
    passwordPreviewError.value = e.message ?? 'Could not decrypt preview'
  } finally {
    passwordPreviewBusy.value = false
  }
}

async function submitKeyPreview() {
  const file = keyPreviewFile.value
  const key = keyPreviewValue.value.trim()
  if (!file) return
  if (!key) {
    keyPreviewError.value = 'Decryption key is required.'
    return
  }
  keyPreviewError.value = ''
  keyPreviewBusy.value = true
  try {
    const payload = await fetchEncryptedPayload(file.file_name)
    const decrypted = await decryptEncryptedBlob(payload, key)
    // Only retain keys that successfully decrypt the authenticated payload.
    rememberEncryptedFile(file.file_name, key, decrypted.metadata, window.location.origin)
    if (keyPromptAction.value === 'download') {
      triggerDownload(decrypted.blob, decrypted.metadata.name)
      doCloseKeyPreviewModal(true)
      return
    }
    doCloseKeyPreviewModal(true)
    await openPreview(file)
  } catch (e: any) {
    keyPreviewError.value = e.message ?? 'Could not decrypt preview'
  } finally {
    keyPreviewBusy.value = false
  }
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

function getAuthToken(): string {
  return localStorage.getItem('rp_token') ?? sessionStorage.getItem('rp_token') ?? ''
}

const accountRequired = computed(() => !getAuthToken())

const selectedFilesList = computed(() => files.value.filter((file) => selectedFiles.value.has(file.file_name)))
const selectedCount = computed(() => selectedFiles.value.size)
const hasSelection = computed(() => selectedCount.value > 0)
const allVisibleSelected = computed(
  () => paginatedFiles.value.length > 0 && paginatedFiles.value.every((file) => selectedFiles.value.has(file.file_name)),
)
const allFilteredSelected = computed(
  () => filtered.value.length > 0 && filtered.value.every((file) => selectedFiles.value.has(file.file_name)),
)

function toggleSelection(name: string, enabled: boolean) {
  const next = new Set(selectedFiles.value)
  if (enabled) next.add(name)
  else next.delete(name)
  selectedFiles.value = next
}

function toggleSelectAll(enabled: boolean) {
  if (!enabled && allFilteredSelected.value) {
    clearSelection()
    return
  }
  const next = new Set(selectedFiles.value)
  if (enabled) {
    for (const file of paginatedFiles.value) next.add(file.file_name)
  } else {
    for (const file of paginatedFiles.value) next.delete(file.file_name)
  }
  selectedFiles.value = next
}

function selectAllFiltered() {
  selectedFiles.value = new Set(filtered.value.map((file) => file.file_name))
}

function clearSelection() {
  selectedFiles.value = new Set()
}

function uniqueArchiveName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const extIndex = name.lastIndexOf('.')
  const hasExt = extIndex > 0
  const stem = hasExt ? name.slice(0, extIndex) : name
  const ext = hasExt ? name.slice(extIndex) : ''
  let counter = 2
  while (used.has(`${stem}-${counter}${ext}`)) counter += 1
  const finalName = `${stem}-${counter}${ext}`
  used.add(finalName)
  return finalName
}

async function downloadSelectedAsZip() {
  if (!hasSelection.value || bulkDownloading.value) return
  bulkDownloading.value = true
  actionsOpen.value = false
  const auth = getAuthToken()
  const selected = [...selectedFilesList.value]
  const entries: Record<string, Uint8Array> = {}
  const names = new Set<string>()
  const failed: string[] = []
  try {
    for (const file of selected) {
      try {
        const response = await fetch(fileUrl(file.file_name), {
          headers: { Authorization: auth },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        entries[uniqueArchiveName(file.file_name, names)] = bytes
      } catch (error) {
        console.error('Bulk download entry failed', { fileName: file.file_name, error })
        failed.push(file.file_name)
      }
    }
    const archiveEntries = Object.keys(entries)
    if (!archiveEntries.length) throw new Error('Download failed for all selected files')
    const archive = zipSync(entries, { level: 0 })
    const archiveBytes = Uint8Array.from(archive)
    triggerDownload(
      new Blob([archiveBytes], { type: 'application/zip' }),
      `yaemipaste-history-${Date.now()}.zip`,
    )
    if (failed.length) showToast(`Downloaded ${archiveEntries.length} file(s), ${failed.length} failed`, 'error')
    else showToast(`Downloaded ${archiveEntries.length} file(s)`)
  } catch (e: any) {
    showToast(e.message ?? 'Bulk download failed', 'error')
  } finally {
    bulkDownloading.value = false
  }
}

function requestDeleteSelected() {
  if (!hasSelection.value || bulkDeleting.value) return
  deleteConfirmMode.value = 'selected'
  deleteAcknowledged.value = false
  deleteConfirmOpen.value = true
  actionsOpen.value = false
  closeRowMoreMenu()
}

function closeDeleteConfirm() {
  if (bulkDeleting.value) return
  deleteConfirmOpen.value = false
  deleteAcknowledged.value = false
}

async function confirmDelete() {
  if (!deleteConfirmCount.value || !deleteAcknowledged.value || bulkDeleting.value) return
  if (deleteConfirmMode.value === 'all') {
    bulkDeleting.value = true
    try {
      await deleteAll()
      deleteConfirmOpen.value = false
    } finally {
      bulkDeleting.value = false
    }
    return
  }
  await deleteSelected()
  deleteConfirmOpen.value = false
}

async function deleteSelected() {
  if (!hasSelection.value || bulkDeleting.value) return
  const selected = [...selectedFilesList.value]
  if (!selected.length) return
  actionsOpen.value = false
  bulkDeleting.value = true
  try {
    const result = await deleteNamesConcurrently(selected.map((file) => file.file_name))
    if (result.deleted) showToast(`Deleted ${result.deleted} file(s)`)
    if (result.failed) showToast(`${result.failed} file(s) could not be deleted`, 'error')
  } finally {
    bulkDeleting.value = false
  }
}

async function deleteNamesConcurrently(names: string[]): Promise<{ deleted: number; failed: number }> {
  const deletedNames = new Set<string>()
  let cursor = 0
  let failed = 0
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor]
      cursor += 1
      try {
        await deleteFile(name)
        deletedNames.add(name)
      } catch (error) {
        failed += 1
        console.error('Bulk delete failed', { fileName: name, error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, names.length) }, () => worker()))
  if (deletedNames.size) {
    for (const name of deletedNames) optimisticDeletedFiles.add(name)
    files.value = files.value.filter((file) => !deletedNames.has(file.file_name))
    selectedFiles.value = new Set([...selectedFiles.value].filter((name) => !deletedNames.has(name)))
  }
  return { deleted: deletedNames.size, failed }
}

async function downloadFile(f: PasteFile) {
  const stored = getStoredEncryptedFile(f.file_name)
  if (stored?.key.startsWith('pw:')) {
    openPasswordPreviewModal(f, 'download')
    return
  }
  if (f.file_name.endsWith('.rpenc') && !stored) {
    openKeyPreviewModal(f, 'download')
    return
  }
  try {
    const response = await fetch(fileUrl(f.file_name), {
      headers: { Authorization: getAuthToken() },
    })
    if (!response.ok) throw new Error('Download failed')
    const payload = await response.blob()
    if (canDownloadEncrypted(f) && stored) {
      const decrypted = await decryptEncryptedBlob(payload, stored.key)
      triggerDownload(decrypted.blob, decrypted.metadata.name)
      return
    }
    triggerDownload(payload, f.file_name)
  } catch (e: any) {
    showToast(e.message ?? 'Download failed', 'error')
  }
}

async function buildPreview(f: PasteFile, x = 0, y = 0, signal?: AbortSignal): Promise<PreviewState> {
  const cached = cachedPreview(f)
  if (cached) return previewStateFromCache(f, cached, x, y)
  const stored = getStoredEncryptedFile(f.file_name)
  const kind = previewKind(f)
  const fetchPreviewPayload = async (): Promise<Response> => {
    const apiUrl = fileUrl(f.file_name)
    try {
      const response = await fetch(apiUrl, {
        cache: 'no-store',
        headers: { Authorization: getAuthToken() },
        signal,
      })
      if (response.ok) return response
    } catch (error) {
      if ((error as DOMException | null)?.name === 'AbortError') throw error
    }
    const fallbackUrl = publicPathRawFileUrl(f.file_name)
    if (fallbackUrl === apiUrl) throw new Error('Preview download failed')
    const fallback = await fetch(fallbackUrl, { cache: 'no-store', signal })
    if (!fallback.ok) throw new Error('Preview download failed')
    return fallback
  }
  if (!stored || stored.key.startsWith('pw:')) {
    const response = await fetchPreviewPayload()
    const payload = await response.blob()
    const textContent = kind === 'text' ? await readPreviewText(payload) : undefined
    const cachedPreviewResult: CachedPreview = {
      blob: payload,
      name: previewName(f),
      type: response.headers.get('content-type')
        || (kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : kind === 'text' ? 'text/plain' : 'application/octet-stream'),
      textContent,
    }
    cachePreview(f, cachedPreviewResult)
    return previewStateFromCache(f, cachedPreviewResult, x, y)
  }

  const response = await fetchPreviewPayload()
  const decrypted = await decryptEncryptedBlob(await response.blob(), stored.key)
  const textContent = kind === 'text' ? await readPreviewText(decrypted.blob) : undefined
  const cachedPreviewResult: CachedPreview = {
    blob: decrypted.blob,
    name: decrypted.metadata.name,
    type: decrypted.metadata.type,
    textContent,
  }
  cachePreview(f, cachedPreviewResult)
  return previewStateFromCache(f, cachedPreviewResult, x, y)
}

function moveHover(e: MouseEvent) {
  if (!hoverPreview.value) return
  hoverPreview.value.x = e.clientX + 18
  hoverPreview.value.y = e.clientY + 18
}

async function showHover(f: PasteFile, e: MouseEvent) {
  if (!hoverEnabled) return
  if (previewKind(f) === 'text') return
  if (!canInlinePreview(f)) return
  hoverAbortController?.abort()
  const controller = new AbortController()
  hoverAbortController = controller
  const token = ++hoverToken
  clearPreviewObjectUrl(hoverPreview.value)
  hoverPreview.value = {
    file: f,
    url: '',
    name: previewName(f),
    type: isImage(previewName(f)) ? 'image/*' : 'video/*',
    x: e.clientX + 18,
    y: e.clientY + 18,
    loading: true,
  }
  try {
    const next = await buildPreview(f, e.clientX + 18, e.clientY + 18, controller.signal)
    if (token === hoverToken) hoverPreview.value = next
    else clearPreviewObjectUrl(next)
  } catch (error) {
    if ((error as DOMException | null)?.name === 'AbortError') return
    if (token === hoverToken) hoverPreview.value = null
  } finally {
    if (hoverAbortController === controller) hoverAbortController = null
  }
}

function hideHover() {
  if (!hoverEnabled) return
  hoverAbortController?.abort()
  hoverAbortController = null
  hoverToken += 1
  clearPreviewObjectUrl(hoverPreview.value)
  hoverPreview.value = null
}

async function openPreview(f: PasteFile) {
  const stored = getStoredEncryptedFile(f.file_name)
  if (stored?.key.startsWith('pw:')) {
    openPasswordPreviewModal(f, 'preview')
    return
  }
  if (f.file_name.endsWith('.rpenc') && !stored) {
    openKeyPreviewModal(f, 'preview')
    return
  }
  const token = ++previewToken
  clearPreviewObjectUrl(preview.value)
  preview.value = {
    file: f,
    url: '',
    name: previewName(f),
    type: isImage(previewName(f)) ? 'image/*' : 'application/octet-stream',
    x: 0,
    y: 0,
    loading: true,
  }
  if (!canInlinePreview(f)) {
    if (token === previewToken && preview.value?.file.file_name === f.file_name) {
      preview.value = { ...preview.value, loading: false }
    }
    return
  }
  try {
    const next = await buildPreview(f)
    if (token !== previewToken || preview.value?.file.file_name !== f.file_name) {
      clearPreviewObjectUrl(next)
      return
    }
    clearPreviewObjectUrl(preview.value)
    preview.value = next
  } catch (e: any) {
    if (token === previewToken && preview.value?.file.file_name === f.file_name) {
      closePreview()
    }
    showToast(e.message ?? 'Preview failed', 'error')
  }
}

function closePreview() {
  previewToken += 1
  clearPreviewObjectUrl(preview.value)
  preview.value = null
}

function setPageSize(nextSize: PageSize) {
  if (pageSize.value === nextSize) return
  pageSize.value = nextSize
  currentPage.value = 1
}

function goToPage(nextPage: number) {
  currentPage.value = Math.min(totalPages.value, Math.max(1, nextPage))
}

watch(filtered, (nextFiles) => {
  if (!hoverPreview.value) return
  const stillVisible = nextFiles.some((item) => item.file_name === hoverPreview.value?.file.file_name)
  if (!stillVisible) hideHover()
})

watch(paginatedFiles, () => {
  void ensureVisibleMeta()
}, { immediate: true })

watch([search, sortKey, sortDir], () => {
  currentPage.value = 1
})

watch(search, () => {
  searching.value = true
  if (searchIndicatorTimer) clearTimeout(searchIndicatorTimer)
  searchIndicatorTimer = setTimeout(() => {
    searching.value = false
    searchIndicatorTimer = null
  }, 240)
})

watch(filtered, () => {
  currentPage.value = Math.min(currentPage.value, totalPages.value)
  if (!paginatedFiles.value.length) {
    actionsOpen.value = false
    closeRowMoreMenu()
  }
})

function onDocumentPointerDown(event: PointerEvent) {
  const target = event.target as Node | null
  if (actionsOpen.value && actionsMenuRef.value && target && !actionsMenuRef.value.contains(target)) {
    actionsOpen.value = false
  }
  const element = target instanceof Element ? target : null
  if (rowMoreOpen.value && (!element || !element.closest('.row-more-wrap'))) {
    closeRowMoreMenu()
  }
}

function closeMenusOnScroll() {
  actionsOpen.value = false
  closeRowMoreMenu()
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
let historySocket: WebSocket | null = null
let historySocketReconnectTimer: ReturnType<typeof setTimeout> | null = null
let historySocketReconnectDelay = 1_000

function clearHistorySocketReconnect() {
  if (!historySocketReconnectTimer) return
  clearTimeout(historySocketReconnectTimer)
  historySocketReconnectTimer = null
}

function closeHistorySocket() {
  wsConnected.value = false
  if (historySocket) {
    historySocket.onopen = null
    historySocket.onmessage = null
    historySocket.onerror = null
    historySocket.onclose = null
    historySocket.close()
    historySocket = null
  }
  clearHistorySocketReconnect()
}

function scheduleHistorySocketReconnect() {
  if (historySocketReconnectTimer) return
  const delay = historySocketReconnectDelay
  historySocketReconnectDelay = Math.min(30_000, Math.round(historySocketReconnectDelay * 1.8))
  historySocketReconnectTimer = setTimeout(() => {
    historySocketReconnectTimer = null
    connectHistorySocket()
  }, delay + Math.floor(Math.random() * 400))
}

function handleHistorySocketMessage(payload: unknown) {
  if (Array.isArray(payload)) {
    applyHistorySnapshot(payload)
    return
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
  const packet = payload as Record<string, unknown>
  if (Array.isArray(packet.files)) {
    applyHistorySnapshot(packet.files)
    return
  }
  if (packet.type === 'history_refresh') {
    void refreshSilently()
  }
}

function connectHistorySocket() {
  const socketUrl = resolveHistorySocketUrl()
  if (!socketUrl) return
  closeHistorySocket()
  try {
    historySocket = new WebSocket(socketUrl)
  } catch {
    scheduleHistorySocketReconnect()
    return
  }

  historySocket.onopen = () => {
    wsConnected.value = true
    historySocketReconnectDelay = 1_000
    const token = getAuthToken()
    if (token && historySocket) {
      try {
        historySocket.send(JSON.stringify({ type: 'subscribe', channel: 'history', token }))
      } catch {
        // ignore servers that do not accept messages
      }
    }
  }

  historySocket.onmessage = (event) => {
    if (!event.data) return
    let parsed: unknown = null
    try {
      parsed = typeof event.data === 'string' ? JSON.parse(event.data) : null
    } catch {
      return
    }
    handleHistorySocketMessage(parsed)
  }

  historySocket.onerror = () => {
    wsConnected.value = false
  }

  historySocket.onclose = () => {
    wsConnected.value = false
    historySocket = null
    scheduleHistorySocketReconnect()
  }
}

function onHistoryRefreshEvent() {
  if (accountRequired.value) return
  void refreshSilently()
}

function onWindowFocus() {
  actionsOpen.value = false
  closeRowMoreMenu()
  hideHover()
  if (accountRequired.value) return
  void refreshSilently()
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    actionsOpen.value = false
    closeRowMoreMenu()
    hideHover()
    return
  }
  if (!accountRequired.value) void refreshSilently()
}

function onCompactNamesMediaChange(event: MediaQueryListEvent) {
  compactFileNames.value = event.matches
}

onMounted(async () => {
  await refreshPublicSettings()
  if (accountRequired.value) loading.value = false
  else void load()
  compactFileNamesMediaQuery = window.matchMedia('(max-width: 820px)')
  compactFileNames.value = compactFileNamesMediaQuery.matches
  compactFileNamesMediaQuery.addEventListener('change', onCompactNamesMediaChange)
  window.addEventListener('blur', hideHover)
  window.addEventListener('scroll', hideHover, true)
  window.addEventListener('scroll', closeMenusOnScroll, true)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener(HISTORY_REFRESH_EVENT, onHistoryRefreshEvent)
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('pointerdown', onDocumentPointerDown)
  if (!accountRequired.value) {
    connectHistorySocket()
    refreshTimer = setInterval(() => {
      if (!wsConnected.value) void refreshSilently()
    }, AUTO_REFRESH_MS)
  }
})
onBeforeUnmount(() => {
  hoverAbortController?.abort()
  compactFileNamesMediaQuery?.removeEventListener('change', onCompactNamesMediaChange)
  compactFileNamesMediaQuery = null
  window.removeEventListener('blur', hideHover)
  window.removeEventListener('scroll', hideHover, true)
  window.removeEventListener('scroll', closeMenusOnScroll, true)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener(HISTORY_REFRESH_EVENT, onHistoryRefreshEvent)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  closeHistorySocket()
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  clearPreviewObjectUrl(preview.value)
  clearPreviewObjectUrl(hoverPreview.value)
  if (copiedFileTimer) clearTimeout(copiedFileTimer)
  if (searchIndicatorTimer) clearTimeout(searchIndicatorTimer)
})

</script>

<template>
  <div class="history-tab">
    <section class="history-hero" aria-labelledby="history-title">
      <div class="history-hero-copy">
        <h2 id="history-title">History</h2>
        <p>Find, copy, or delete anything you've uploaded.</p>
      </div>
      <!-- Zeroed totals read as "you have no files" rather than "sign in", so
           the summary is withheld until there is an account behind it. -->
      <div v-if="!accountRequired" class="history-summary" aria-label="History summary">
        <div class="summary-card">
          <span class="summary-label">Active files</span>
          <strong>{{ files.length }}</strong>
        </div>
        <div class="summary-card">
          <span class="summary-label">Storage</span>
          <strong>{{ formatBytes(totalBytes) }}</strong>
        </div>
        <div class="summary-card">
          <span class="summary-label">Encrypted</span>
          <strong>{{ encryptedCount }}</strong>
        </div>
        <div class="summary-card">
          <span class="summary-label">Expiring</span>
          <strong>{{ expiringCount }}</strong>
        </div>
      </div>
    </section>

    <section class="history-panel" aria-label="History controls and files">
      <div v-if="!accountRequired" class="toolbar">
          <div class="toolbar-main">
            <div class="search-wrap toolbar-control">
            <input v-model="search" type="text" placeholder="" :aria-label="`Search ${files.length} uploads`" />
            <span v-if="!search" class="search-placeholder" aria-hidden="true">Search <strong>{{ files.length }}</strong> uploads</span>
            <svg v-if="searching" class="search-icon search-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="8" stroke-opacity=".28"/><path d="M20 12a8 8 0 0 0-8-8"/>
            </svg>
            <button v-else-if="search" class="search-clear" type="button" aria-label="Clear search" title="Clear search" @click="search = ''">×</button>
            <svg v-else class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </div>
        </div>
        <button class="btn-red toolbar-control toolbar-delete-all" :disabled="!files.length || bulkDeleting" @click="requestDeleteAll">
          Delete all
        </button>
      </div>

      <div v-if="!accountRequired" class="bulk-actions">
        <label class="select-all">
          <input
            type="checkbox"
            :checked="allVisibleSelected"
            :disabled="!paginatedFiles.length || bulkDeleting || bulkDownloading"
            aria-label="Select all files"
            @change="toggleSelectAll(($event.target as HTMLInputElement).checked)"
          />
          <span>Select page</span>
        </label>
        <span class="selection-count">{{ selectedCount }} selected</span>
        <button
          v-if="hasSelection"
          class="clear-selection"
          type="button"
          :disabled="bulkDeleting || bulkDownloading"
          @click="clearSelection"
        >
          Clear
        </button>
        <button
          v-if="totalPages > 1 && allVisibleSelected && !allFilteredSelected"
          class="select-all-pages"
          type="button"
          :disabled="bulkDeleting || bulkDownloading"
          @click="selectAllFiltered"
        >
          Select all {{ filtered.length }} files
        </button>
        <span v-else-if="totalPages > 1 && allFilteredSelected" class="all-pages-selected">
          All {{ filtered.length }} pages selected
        </span>
        <span class="history-meta">Latest: {{ latestFileDate }}</span>
        <div class="page-size-wrap">
          <span class="page-size-label">Per page</span>
          <div class="page-size-segment" role="group" aria-label="Per page">
            <button
              v-for="size in PAGE_SIZES"
              :key="size"
              class="page-size-btn"
              :class="{ active: pageSize === size }"
              :aria-pressed="pageSize === size ? 'true' : 'false'"
              @click="setPageSize(size)"
            >
              {{ size }}
            </button>
          </div>
        </div>
        <div ref="actionsMenuRef" class="actions-menu-wrap">
          <button
            class="btn-ghost bulk-action-trigger"
            :disabled="!hasSelection || bulkDeleting || bulkDownloading"
            aria-haspopup="menu"
            :aria-expanded="actionsOpen ? 'true' : 'false'"
            @click="actionsOpen = !actionsOpen"
          >
            Actions
          </button>
          <Transition name="dropdown-fade">
            <div v-if="actionsOpen" class="actions-menu" role="menu">
              <button
                class="menu-action"
                :disabled="bulkDeleting || bulkDownloading"
                @click="downloadSelectedAsZip"
              >
                {{ bulkDownloading ? 'Downloading…' : 'Download selected' }}
              </button>
              <button
                class="menu-action danger"
                :disabled="bulkDeleting || bulkDownloading"
                @click="requestDeleteSelected"
              >
                {{ bulkDeleting ? 'Deleting…' : 'Delete selected' }}
              </button>
              <button
                class="menu-action"
                :disabled="bulkDeleting || bulkDownloading"
                @click="clearSelection(); actionsOpen = false"
              >
                Clear selection
              </button>
            </div>
          </Transition>
        </div>
      </div>

      <div v-if="accountRequired" class="state-card account-state" data-testid="history-account-state">
        <span class="state-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
            <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
          </svg>
        </span>
        <strong>History needs an account</strong>
        <p>Anyone can see a public upload, but your history is only visible to you.</p>
        <button class="btn-primary account-action" type="button" @click="router.push('/login')">Log in to view history</button>
      </div>

      <div v-else-if="loading" class="skeleton-table" aria-label="Loading history">
        <div class="skeleton-toolbar"></div>
        <div v-for="row in 6" :key="row" class="skeleton-row">
          <span class="skeleton-check"></span>
          <span class="skeleton-name"></span>
          <span class="skeleton-size"></span>
          <span class="skeleton-actions"></span>
        </div>
      </div>

      <div v-else-if="error" class="state-card error-state" role="alert">
        <strong>History unavailable</strong>
        <p>{{ error }}</p>
      </div>

      <div v-else-if="!filtered.length" class="state-card">
        <template v-if="search">
          <strong>No matching files</strong>
          <p>Try a different filename or clear the search field.</p>
        </template>
        <template v-else>
          <strong>You haven’t uploaded any files yet.</strong>
          <p>Want to upload your first?</p>
          <button class="btn-ghost empty-action" type="button" @click.stop.prevent="router.push('/files')">
            Upload
          </button>
        </template>
      </div>

      <div v-else class="table-wrap" @mouseleave="hideHover">
        <table class="file-table">
          <thead>
            <tr>
              <th class="select-col">
                <input
                  type="checkbox"
                  :checked="allVisibleSelected"
                  :disabled="!paginatedFiles.length || bulkDeleting || bulkDownloading"
                  aria-label="Select all rows"
                  @change="toggleSelectAll(($event.target as HTMLInputElement).checked)"
                />
              </th>
              <th class="sortable" @click="setSort('file_name')">
                Name <SortArrow :active="sortKey === 'file_name'" :dir="sortDir" />
              </th>
              <th class="sortable col-size" @click="setSort('file_size')">
                Size <SortArrow :active="sortKey === 'file_size'" :dir="sortDir" />
              </th>
              <th class="sortable col-expiry" @click="setSort('expires_at')">
                Expires <SortArrow :active="sortKey === 'expires_at'" :dir="sortDir" />
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="f in paginatedFiles"
              :key="f.file_name"
              class="file-row"
              @mouseenter="showHover(f, $event)"
              @mousemove="moveHover"
              @mouseleave="hideHover"
            >
              <td class="select-col">
                <input
                  type="checkbox"
                  :checked="selectedFiles.has(f.file_name)"
                  :aria-label="`Select ${f.file_name}`"
                  :disabled="bulkDeleting || bulkDownloading"
                  @change="toggleSelection(f.file_name, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td class="name">
                <span
                  class="filename"
                  :title="shareUrl(f.file_name)"
                  @click.stop="openPreview(f)"
                >
                  <span class="file-icon" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                      <polyline points="13 2 13 9 20 9"/>
                    </svg>
                  </span>
                  <svg v-if="isEncryptedFile(f)" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="lock-icon" :title="isPasswordEncryptedFile(f) ? 'Password-encrypted' : 'Encrypted'">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                  <img
                    v-if="hasShareXBadge(f.file_name)"
                    class="sharex-icon"
                    :src="sharexLogoUrl"
                    title="Captured and uploaded with ShareX"
                    aria-label="Uploaded with ShareX"
                    alt="Uploaded with ShareX"
                  />
                  <span class="filename-text">
                    <span class="filename-base">{{ displayBaseName(f) }}</span>
                    <span v-if="displayExtension(f)" class="filename-ext">{{ displayExtension(f) }}</span>
                  </span>
                </span>
              </td>
              <td class="size">{{ formatBytes(f.file_size) }}</td>
              <td class="expiry">{{ f.expires_at ? formatTimestamp(f.expires_at) : 'Never' }}</td>
              <td class="actions">
                <div class="action-row">
                  <button
                    class="btn-ghost action-btn"
                    :title="canDownloadEncrypted(f) ? 'Download decrypted file' : 'Download file'"
                    aria-label="Download"
                    @click.stop="downloadFile(f)"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <span class="action-label">Download</span>
                  </button>
                  <button class="btn-orange action-btn" :aria-label="copiedFileName === f.file_name ? 'Copied' : 'Copy'" @click.stop="copy(f)">
                    <Transition name="copy-feedback" mode="out-in">
                      <svg v-if="copiedFileName === f.file_name" key="copied" class="copy-feedback-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>
                      <svg v-else key="copy" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                    </Transition>
                    <span class="action-label">{{ copiedFileName === f.file_name ? 'Copied' : 'Copy' }}</span>
                  </button>
                  <div class="row-more-wrap">
                    <button
                      class="btn-ghost row-more-btn action-btn"
                      aria-label="More"
                      aria-haspopup="menu"
                      :aria-expanded="rowMoreOpen === f.file_name ? 'true' : 'false'"
                      @click.stop="rowMoreOpen = rowMoreOpen === f.file_name ? null : f.file_name"
                    >
                      ⋯
                    </button>
                    <Transition name="dropdown-fade">
                      <div v-if="rowMoreOpen === f.file_name" class="row-item-menu" role="menu">
                        <button
                          v-if="isPasswordEncryptedFile(f)"
                          class="menu-action"
                          :disabled="!canChangeDecryptionPassword(f) || changingPassword"
                          @click.stop="openPasswordModal(f)"
                        >
                          Change decryption password
                        </button>
                        <div v-if="isPasswordEncryptedFile(f)" class="row-item-note">
                          {{ passwordChangesRemaining(f.file_name) }} / {{ PASSWORD_CHANGE_LIMIT }} changes remaining
                        </div>
                        <button
                          class="menu-action danger"
                          :disabled="deleting.has(f.file_name)"
                          @click.stop="del(f)"
                        >
                          {{ deleting.has(f.file_name) ? 'Deleting…' : 'Delete' }}
                        </button>
                      </div>
                    </Transition>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="pagination">
          <button
            class="btn-ghost pagination-btn"
            :disabled="currentPage <= 1"
            @click="goToPage(currentPage - 1)"
          >
            Previous
          </button>
          <span>Page {{ currentPage }} of {{ totalPages }}</span>
          <button
            class="btn-ghost pagination-btn"
            :disabled="currentPage >= totalPages"
            @click="goToPage(currentPage + 1)"
          >
            Next
          </button>
        </div>
      </div>
    </section>

    <div
      v-if="hoverPreview"
      class="hover-preview"
      :style="{ left: `${hoverPreview.x}px`, top: `${hoverPreview.y}px` }"
    >
      <div v-if="hoverPreview.loading" class="hover-loading">
        <span class="loading-spinner" aria-hidden="true"></span>
        <span>Decrypting…</span>
      </div>
      <img v-else-if="hoverPreview.type.startsWith('image/')" :src="hoverPreview.url" :alt="hoverPreview.name" />
      <video v-else :src="hoverPreview.url" muted playsinline />
      <div class="hover-name">{{ hoverPreview.name }}</div>
    </div>

    <FilePreview
      v-if="preview"
      :file="preview.file"
      :source-url="preview.url"
      :display-name="preview.name"
      :mime-type="preview.type"
      :text-content="preview.textContent"
      :loading="preview.loading"
      @download="downloadFile"
      @close="closePreview"
    />

    <ActionConfirmDialog
      v-if="deleteConfirmOpen"
      v-model:acknowledged="deleteAcknowledged"
      :title="deleteConfirmTitle"
      :message="deleteConfirmMessage"
      :detail="`${deleteConfirmCount} item${deleteConfirmCount === 1 ? '' : 's'} · Permanent deletion`"
      confirm-label="Confirm delete"
      acknowledgement="I understand that these files will be permanently deleted."
      :busy="bulkDeleting"
      danger
      @close="closeDeleteConfirm"
      @confirm="confirmDelete"
    />

    <div v-if="passwordModalOpen" class="modal-backdrop" @click.self="closePasswordModal">
      <div class="password-modal" role="dialog" aria-modal="true" aria-labelledby="password-change-title">
        <div class="password-modal-header">
          <strong id="password-change-title">Change decryption password</strong>
          <button class="modal-close btn-ghost icon-close" :disabled="changingPassword" aria-label="Close password dialog" @click="closePasswordModal">✕</button>
        </div>
        <div class="password-modal-copy">
          Updating this re-encrypts the file and refreshes your owner link.
        </div>
        <div class="password-modal-copy">
          {{ passwordModalFile ? `${passwordChangesRemaining(passwordModalFile.file_name)} / ${PASSWORD_CHANGE_LIMIT} changes remaining` : '' }}
        </div>
        <div class="password-form">
          <label>
            Current password
            <input v-model="currentPassword" type="password" autocomplete="current-password" :disabled="changingPassword" />
          </label>
          <label>
            New password
            <input v-model="newPassword" type="password" autocomplete="new-password" :disabled="changingPassword" />
          </label>
          <label>
            Confirm new password
            <input v-model="confirmPassword" type="password" autocomplete="new-password" :disabled="changingPassword" />
          </label>
        </div>
        <div v-if="passwordChangeError" class="password-modal-error">{{ passwordChangeError }}</div>
        <div v-if="changingPassword" class="password-modal-status" aria-live="polite">
          <span class="loading-spinner" aria-hidden="true"></span>
          <span>{{ `${passwordChangeStatus || 'Updating…'} (${passwordChangePercent}%)` }}</span>
        </div>
        <div class="password-modal-actions">
          <button class="btn-ghost" :disabled="changingPassword" @click="closePasswordModal">Cancel</button>
          <button class="btn-primary" :disabled="changingPassword" @click="submitPasswordChange">
            <span v-if="changingPassword" class="busy-inline">
              <span class="loading-spinner" aria-hidden="true"></span>
              <span>Updating…</span>
            </span>
            <span v-else>Save password</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="passwordPreviewOpen" class="modal-backdrop" @click.self="closePasswordPreviewModal">
      <div class="password-modal" role="dialog" aria-modal="true" aria-labelledby="password-preview-title">
        <div class="password-modal-header">
          <strong id="password-preview-title">{{ passwordPromptAction === 'download' ? 'Download password-encrypted file' : 'Preview password-encrypted file' }}</strong>
          <button class="modal-close btn-ghost icon-close" :disabled="passwordPreviewBusy" aria-label="Close password prompt" @click="closePasswordPreviewModal">✕</button>
        </div>
        <div class="password-modal-copy">
          {{ passwordPromptAction === 'download'
            ? 'Enter the decryption password to download this file.'
            : 'Enter the decryption password to preview this file in-app.' }}
        </div>
        <div class="password-form">
          <label>
            Decryption password
            <input
              v-model="passwordPreviewValue"
              type="password"
              autocomplete="current-password"
              :disabled="passwordPreviewBusy"
              @keydown.enter.prevent="submitPasswordPreview"
            />
          </label>
        </div>
        <div v-if="passwordPreviewError" class="password-modal-error">{{ passwordPreviewError }}</div>
        <div class="password-modal-actions">
          <button class="btn-ghost" :disabled="passwordPreviewBusy" @click="closePasswordPreviewModal">Cancel</button>
          <button class="btn-primary" :disabled="passwordPreviewBusy || !passwordPreviewValue.trim()" @click="submitPasswordPreview">
            <span v-if="passwordPreviewBusy" class="busy-inline">
              <span class="loading-spinner" aria-hidden="true"></span>
              <span>Decrypting…</span>
            </span>
            <span v-else>{{ passwordPromptAction === 'download' ? 'Download file' : 'Preview file' }}</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="keyPreviewOpen" class="modal-backdrop" @click.self="closeKeyPreviewModal">
      <div class="password-modal" role="dialog" aria-modal="true" aria-labelledby="key-preview-title">
        <div class="password-modal-header">
          <strong id="key-preview-title">{{ keyPromptAction === 'download' ? 'Download encrypted file' : 'Preview encrypted file' }}</strong>
          <button class="modal-close btn-ghost icon-close" :disabled="keyPreviewBusy" aria-label="Close key prompt" @click="closeKeyPreviewModal">✕</button>
        </div>
        <div class="password-modal-copy">
          {{ keyPromptAction === 'download'
            ? 'Enter the decryption key to download this file.'
            : 'Enter the decryption key to preview this file in-app.' }}
        </div>
        <div class="password-form">
          <label>
            Decryption key
            <input
              v-model="keyPreviewValue"
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              :disabled="keyPreviewBusy"
              @keydown.enter.prevent="submitKeyPreview"
            />
          </label>
        </div>
        <div v-if="keyPreviewError" class="password-modal-error">{{ keyPreviewError }}</div>
        <div class="password-modal-actions">
          <button class="btn-ghost" :disabled="keyPreviewBusy" @click="closeKeyPreviewModal">Cancel</button>
          <button class="btn-primary" :disabled="keyPreviewBusy || !keyPreviewValue.trim()" @click="submitKeyPreview">
            <span v-if="keyPreviewBusy" class="busy-inline">
              <span class="loading-spinner" aria-hidden="true"></span>
              <span>Decrypting…</span>
            </span>
            <span v-else>{{ keyPromptAction === 'download' ? 'Download file' : 'Preview file' }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history-tab {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: 24px;
}
.history-hero,
.history-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: none;
}

.history-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: clamp(18px, 3vw, 24px);
  overflow: hidden;
}

.history-hero-copy {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.history-hero h2 {
  color: var(--text);
  font-size: var(--fs-display);
  line-height: var(--lh-tight);
  font-weight: 650;
  letter-spacing: -0.025em;
  margin: 0;
}

.history-hero p {
  max-width: 58ch;
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  margin: 0;
}

.history-summary {
  flex: 0 1 auto;
  display: grid;
  grid-template-columns: repeat(4, minmax(96px, 1fr));
  gap: var(--space-2);
}

.summary-card {
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg2);
}

.summary-label {
  display: block;
  margin-bottom: 2px;
  color: var(--text3);
  font-size: 11px;
  font-weight: 600;
}

.summary-card strong {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: clamp(18px, 2vw, 24px);
  line-height: var(--lh-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-panel {
  padding: var(--space-4);
  background: var(--surface);
  overflow: hidden;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  background: color-mix(in srgb, var(--bg) 76%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
}

.toolbar-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 360px;
  min-width: 0;
}

.toolbar-control {
  min-height: 38px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
}

.toolbar-delete-all {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--space-3);
}

.search-wrap {
  position: relative;
  width: min(100%, 360px);
  display: inline-flex;
  align-items: center;
}

.search-wrap input {
  width: 100%;
  height: 100%;
  min-height: inherit;
  padding-right: 34px;
  background: color-mix(in srgb, var(--bg2) 72%, var(--bg));
  border-color: var(--border);
}

.search-placeholder {
  position: absolute;
  left: 11px;
  right: 34px;
  overflow: hidden;
  color: var(--text3);
  pointer-events: none;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.search-placeholder strong {
  color: var(--text2);
  font-weight: 700;
}
.search-wrap input:focus + .search-placeholder {
  opacity: 0;
}

.search-icon {
  position: absolute;
  right: 11px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text3);
  pointer-events: none;
}

.bulk-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding: var(--space-3) 0;
}

.select-all {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-sm);
}

.selection-count,
.history-meta {
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

.history-meta {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text3);
}

.actions-menu-wrap { position: relative; }

.bulk-action-trigger,
.pagination-btn,
.action-btn {
  padding: var(--space-1) var(--space-3);
  font-size: var(--fs-sm);
}

.page-size-wrap {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.page-size-label {
  color: var(--text2);
  font-size: var(--fs-xs);
}

.page-size-segment {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--bg);
}

.page-size-btn {
  min-width: 36px;
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text2);
  font-size: var(--fs-sm);
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.page-size-btn.active {
  background: var(--bg2);
  color: var(--text);
}

.page-size-btn:hover:not(.active) {
  background: var(--bg1);
  color: var(--text);
}

.page-size-btn:active { transform: none; }

.actions-menu,
.row-item-menu {
  position: absolute;
  min-width: 190px;
  padding: var(--space-2);
  border: 1px solid var(--border2);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg1) 96%, var(--bg));
  box-shadow: 0 16px 40px color-mix(in srgb, var(--shadow) 86%, transparent);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.actions-menu {
  top: calc(100% + 8px);
  right: 0;
  z-index: 20;
}

.row-item-menu {
  right: 0;
  top: calc(100% + 8px);
  min-width: 232px;
  z-index: 25;
}

.menu-action {
  width: 100%;
  display: inline-flex;
  justify-content: flex-start;
  padding: var(--space-2) var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text2);
  text-align: left;
}

.menu-action:hover:not(:disabled) {
  border-color: var(--border);
  background: var(--bg2);
  color: var(--text);
}

.menu-action.danger {
  color: var(--red-h);
}

.menu-action.danger:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--red) 55%, var(--border));
  background: var(--danger-bg);
  color: var(--red-h);
}

.skeleton-table {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) 0 0;
}

.skeleton-toolbar,
.skeleton-row {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: linear-gradient(90deg, var(--bg) 0%, var(--bg2) 48%, var(--bg) 100%);
  background-size: 220% 100%;
  animation: skeletonPulse 1.4s var(--ease-out) infinite;
}

.skeleton-toolbar {
  height: 42px;
}

.skeleton-row {
  display: grid;
  grid-template-columns: 24px minmax(140px, 1fr) 84px 136px;
  gap: var(--space-3);
  align-items: center;
  min-height: 48px;
  padding: var(--space-3);
}

.skeleton-row span {
  display: block;
  height: 12px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text3) 28%, transparent);
}

.skeleton-check {
  width: 14px;
  height: 14px !important;
}

.skeleton-name { width: min(100%, 320px); }
.skeleton-size { width: 64px; }
.skeleton-actions { width: 118px; justify-self: end; }

.state-card {
  margin-top: var(--space-2);
  padding: var(--space-6) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg);
  text-align: center;
}

.state-card strong {
  display: block;
  margin-bottom: var(--space-2);
  color: var(--text);
  font-size: var(--fs-h2);
}

.state-card p {
  max-width: 54ch;
  margin: 0 auto;
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}
.empty-action {
  margin-top: var(--space-4);
  min-height: 38px;
  padding-inline: var(--space-4);
  border-color: var(--border2);
  color: var(--text2);
}
.empty-action:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border2));
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text);
}
.account-state {
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
}

.state-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: var(--space-3);
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
}

.state-icon svg {
  width: 19px;
  height: 19px;
}

/* The sole action on an otherwise empty page, so it carries the same accent
   fill as the sidebar's guest login rather than the muted .btn-primary base. */
.account-action {
  margin-top: var(--space-4);
  min-height: 40px;
  padding-inline: var(--space-5);
  border-color: transparent;
  background: var(--accent);
  color: var(--bg);
}

.account-action:hover:not(:disabled) {
  border-color: transparent;
  background: var(--accent-h);
}

.error-state {
  border-color: var(--error-border);
  background: var(--danger-bg);
}

.table-wrap {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
  overflow: hidden;
}

.file-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
}

.file-table th {
  background: color-mix(in srgb, var(--bg1) 70%, var(--bg));
}

.file-table th:first-child,
.file-table td:first-child { padding-left: var(--space-3); }

.file-table th:last-child,
.file-table td:last-child { padding-right: var(--space-3); }

.file-table th.col-size,
.file-table td.size { width: 112px; }

.file-table th.col-expiry,
.file-table td.expiry { width: 168px; }

.file-table th:last-child,
.file-table td.actions { width: 248px; }

.file-table td {
  height: 48px;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}

.file-table tr:hover td {
  background: color-mix(in srgb, var(--bg2) 42%, transparent);
}

.file-table th.select-col,
.file-table td.select-col {
  width: 42px;
  padding-right: 0;
  padding-left: 0;
  text-align: center;
  vertical-align: middle;
}

.file-table th.select-col input,
.file-table td.select-col input {
  display: block;
  margin: 0 auto;
}

.filename {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out), opacity var(--duration-fast) var(--ease-out);
}

.filename:active { opacity: 0.7; }

.file-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg1);
  color: var(--text2);
}

.filename-text {
  min-width: 0;
  display: inline-flex;
  align-items: baseline;
  max-width: 100%;
}

.filename-base {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filename-ext {
  white-space: nowrap;
  flex-shrink: 0;
  color: var(--text2);
}

.lock-icon {
  color: var(--text2);
  flex-shrink: 0;
}

.sharex-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  object-fit: contain;
}

@media (hover: hover) and (pointer: fine) {
  .filename:hover { color: var(--accent); }
}

.file-table td.name {
  max-width: 0;
  width: auto;
  overflow: hidden;
}

.action-row {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
  flex-wrap: nowrap;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  white-space: nowrap;
  min-height: 30px;
}

.action-btn svg { flex: 0 0 auto; }
.action-label { display: inline; }
.row-more-wrap { position: relative; }

.row-item-note {
  color: var(--text2);
  font-size: var(--fs-xs);
  padding: var(--space-1) var(--space-3) var(--space-2);
}

.pagination {
  padding: var(--space-3);
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-xs);
  border-top: 1px solid var(--border);
}

.password-modal,
.confirm-modal {
  width: min(440px, calc(100vw - 24px));
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg);
  background: var(--bg1);
  padding: var(--space-4);
  box-shadow: 0 24px 64px color-mix(in srgb, var(--shadow) 90%, transparent);
}

.confirm-modal {
  width: min(460px, calc(100vw - 24px));
}

.modal-icon {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text);
  background: var(--bg);
  font-weight: 700;
}

.modal-icon.danger {
  border-color: color-mix(in srgb, var(--red) 55%, var(--border));
  color: var(--red-h);
  background: var(--danger-bg);
}

.password-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}

.password-modal-header strong {
  color: var(--text);
  font-size: var(--fs-h2);
}

.password-modal-copy {
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  margin-bottom: var(--space-2);
}

.confirm-detail {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-3);
}

.confirm-detail span {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text2);
  font-size: var(--fs-xs);
  background: var(--bg);
}

.password-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.password-form label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: var(--text2);
  font-size: var(--fs-xs);
}

.password-form input {
  background: var(--bg);
  border-color: var(--border);
}

.password-modal-error {
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--error-border);
  border-radius: var(--radius-sm);
  background: var(--danger-bg);
  color: var(--red-h);
  font-size: var(--fs-sm);
}

.password-modal-status {
  margin-top: var(--space-2);
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text2);
  font-size: var(--fs-sm);
}

.password-modal-actions {
  margin-top: var(--space-4);
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.confirm-danger {
  border-color: color-mix(in srgb, var(--red) 55%, var(--border));
  color: var(--red-h);
}

.confirm-danger:hover:not(:disabled) {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
}

.busy-inline {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.hover-preview {
  position: fixed;
  z-index: 300;
  width: 232px;
  max-width: calc(100vw - 32px);
  border: 1px solid var(--border2);
  border-radius: var(--radius-md);
  background: var(--bg1);
  padding: var(--space-2);
  pointer-events: none;
  box-shadow: 0 16px 40px color-mix(in srgb, var(--shadow) 86%, transparent);
}

.hover-preview img,
.hover-preview video {
  display: block;
  width: 100%;
  max-height: 150px;
  object-fit: contain;
  border-radius: var(--radius-sm);
  background: var(--bg);
}

.hover-loading {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  padding: 36px var(--space-2);
  color: var(--text2);
  font-size: var(--fs-xs);
}

.loading-spinner {
  width: 12px;
  height: 12px;
  border-radius: var(--radius-full);
  border: 2px solid var(--border2);
  border-top-color: var(--text2);
  animation: spin 0.8s linear infinite;
}

.hover-name {
  margin-top: var(--space-2);
  overflow: hidden;
  color: var(--text2);
  font-size: var(--fs-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-tab .btn-ghost,
.history-tab .btn-primary,
.history-tab .btn-red,
.history-tab .btn-orange,
.history-tab .menu-action {
  transition: background var(--duration-fast) var(--ease-out), opacity var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}

.history-tab .btn-ghost:not(:disabled):active,
.history-tab .btn-primary:not(:disabled):active,
.history-tab .btn-red:not(:disabled):active,
.history-tab .btn-orange:not(:disabled):active,
.history-tab .menu-action:not(:disabled):active {
  transform: scale(0.96);
}

@media (max-width: 820px) {
  .history-hero {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }

  .history-summary {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .page-size-wrap {
    margin-left: 0;
  }
}

@media (max-width: 600px) {
  .history-panel,
  .history-hero {
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }

  .history-summary,
  .skeleton-row {
    grid-template-columns: 1fr 1fr;
  }

  .state-card {
    padding: var(--space-5) var(--space-3);
  }

  .account-action {
    width: 100%;
  }

  .toolbar {
    align-items: stretch;
  }

  .toolbar-main,
  .toolbar-control,
  .search-wrap,
  .toolbar-delete-all {
    width: 100%;
  }

  .file-table { width: 100%; }
  .file-table th:last-child,
  .file-table td.actions { width: 118px; }
  .filename { width: 100%; min-width: 0; }
  .action-label { display: none; }
  .action-btn {
    min-width: 30px;
    width: 30px;
    padding: 3px !important;
  }
  .row-item-menu {
    right: 0;
    left: auto;
    max-width: calc(100vw - 20px);
  }
  .pagination {
    justify-content: space-between;
    gap: var(--space-2);
    font-size: var(--fs-xs);
  }
}

@media (min-width: 601px) and (max-width: 820px) {
  .file-table { width: 100%; }
  .file-table th.col-size,
  .file-table td.size { width: 84px; }
  .file-table th.col-expiry,
  .file-table td.expiry { width: 110px; }
  .file-table th:last-child,
  .file-table td.actions { width: 110px; }
  .filename { width: 100%; min-width: 0; }
  .action-label { display: none; }
  .action-btn {
    min-width: 30px;
    width: 30px;
    padding: 3px !important;
  }
  .row-item-menu {
    right: 0;
    left: auto;
    max-width: calc(100vw - 20px);
  }
}

@keyframes skeletonPulse {
  0% { background-position: 120% 0; }
  100% { background-position: -120% 0; }
}

@keyframes spin { to { transform: rotate(360deg); } }
</style>
