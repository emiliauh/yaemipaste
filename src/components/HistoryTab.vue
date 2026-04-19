<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { zipSync } from 'fflate'
import { getPasteApiBase, listFiles, deleteFile, formatBytes, getPublicFileMeta, publicApiFileUrl, publicFileUrl, shareUrl, uploadFile, type PasteFile, type PublicFileMeta } from '../lib/api'
import { decryptBlobWithPassword, decryptEncryptedBlob, encryptedShareUrl, getStoredEncryptedFile, isRustypasteEncryptedBlob } from '../lib/e2ee'
import FilePreview from './FilePreview.vue'
import { useNotificationStore } from '../stores/notifications'
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

type PageSize = 15 | 30 | 45
const PAGE_SIZES: PageSize[] = [15, 30, 45]
const HISTORY_REFRESH_EVENT = 'rp:history-refresh'
const AUTO_REFRESH_MS = 2_000
const PASSWORD_CHANGE_LIMIT = 3
const PASSWORD_CHANGE_COUNT_KEY = 'rp_pw_change_counts'
const HISTORY_WS_ENV = (import.meta.env.VITE_HISTORY_WS ?? '').trim()

const files = ref<PasteFile[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const sortKey = ref<'file_name' | 'file_size' | 'expires_at' | 'created_at'>('created_at')
const sortDir = ref<1 | -1>(-1)
const preview = ref<PreviewState | null>(null)
const hoverPreview = ref<PreviewState | null>(null)
const deleting = ref<Set<string>>(new Set())
const selectedFiles = ref<Set<string>>(new Set())
const actionsOpen = ref(false)
const rowMoreOpen = ref<string | null>(null)
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
const wsConnected = ref(false)
const compactFileNames = ref(window.matchMedia('(max-width: 600px)').matches)
const hoverEnabled = window.matchMedia('(hover: hover) and (pointer: fine)').matches
const notificationStore = useNotificationStore()
let hoverToken = 0
let previewToken = 0
let compactFileNamesMediaQuery: MediaQueryList | null = null

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
  if (!parsed.length) return
  files.value = parsed
  const knownNames = new Set(parsed.map((file) => file.file_name))
  selectedFiles.value = new Set([...selectedFiles.value].filter((name) => knownNames.has(name)))
  fileMetaMap.value = Object.fromEntries(Object.entries(fileMetaMap.value).filter(([name]) => knownNames.has(name)))
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
    const token = getAuthToken()
    if (!token) return null
    url.searchParams.set('token', token)
    return url.toString()
  } catch {
    return null
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    files.value = await listFiles()
    const knownNames = new Set(files.value.map((file) => file.file_name))
    selectedFiles.value = new Set([...selectedFiles.value].filter((name) => knownNames.has(name)))
    fileMetaMap.value = Object.fromEntries(Object.entries(fileMetaMap.value).filter(([name]) => knownNames.has(name)))
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function refreshSilently() {
  try {
    const nextFiles = await listFiles()
    files.value = nextFiles
    const knownNames = new Set(nextFiles.map((file) => file.file_name))
    selectedFiles.value = new Set([...selectedFiles.value].filter((name) => knownNames.has(name)))
    fileMetaMap.value = Object.fromEntries(Object.entries(fileMetaMap.value).filter(([name]) => knownNames.has(name)))
  } catch (e) {
    console.error('History auto-refresh failed', e)
  }
}

function normalizeShareXField(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function isExplicitShareXUploader(value: string): boolean {
  return value === 'sharex' || value.endsWith('(sharex)')
}

function isLegacyTokenMediaUpload(meta: PublicFileMeta): boolean {
  const uploader = normalizeShareXField(meta.uploader)
  if (uploader !== 'unknown (token user)') return false
  const mime = normalizeShareXField(meta.mime_type)
  if (!mime.startsWith('image/') && !mime.startsWith('video/')) return false
  const displayName = normalizeShareXField(meta.display_name)
  const fileName = normalizeShareXField(meta.file_name)
  return !!displayName && displayName === fileName
}

function hasShareXBadge(fileName: string): boolean {
  const meta = fileMetaMap.value[fileName]
  if (!meta) return false
  const source = normalizeShareXField(meta.source)
  if (source) return source === 'sharex'
  if (isExplicitShareXUploader(normalizeShareXField(meta.uploader))) return true
  return isLegacyTokenMediaUpload(meta)
}

async function ensureVisibleMeta() {
  const missing = paginatedFiles.value
    .map((file) => file.file_name)
    .filter((name) => !fileMetaMap.value[name])
  if (!missing.length) return
  const entries = await Promise.all(missing.map(async (fileName) => {
    try {
      const meta = await getPublicFileMeta(fileName)
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
    files.value = files.value.filter((x) => x.file_name !== f.file_name)
    selectedFiles.value.delete(f.file_name)
    showToast(`Deleted ${f.file_name}`)
  } catch (e: any) {
    showToast(e.message ?? 'Delete failed', 'error')
  } finally {
    deleting.value.delete(f.file_name)
  }
}

async function deleteAll() {
  if (!confirm(`Delete all ${files.value.length} files?`)) return
  for (const f of [...files.value]) await del(f)
}

function previewName(f: PasteFile) {
  const stored = getStoredEncryptedFile(f.file_name)
  if (stored?.name) return stored.name
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

function setPasswordChangeProgress(status: string, percent: number) {
  passwordChangeStatus.value = status
  passwordChangePercent.value = Math.max(0, Math.min(100, Math.round(percent)))
}

async function fetchEncryptedPayload(fileName: string, onProgress?: (percent: number) => void): Promise<Blob> {
  const response = await fetch(`${publicApiFileUrl(fileName)}?raw=1`, {
    cache: 'no-store',
    headers: { Authorization: getAuthToken() },
  })
  if (!response.ok) throw new Error('Could not download encrypted payload')
  const total = Number(response.headers.get('content-length') ?? 0)
  if (!response.body || !Number.isFinite(total) || total <= 0) {
    const payload = await response.blob()
    onProgress?.(100)
    if (!(await isRustypasteEncryptedBlob(payload))) throw new Error('File payload is not encrypted')
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
  if (!(await isRustypasteEncryptedBlob(payload))) throw new Error('File payload is not encrypted')
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
  if (type.startsWith('image/') || type.startsWith('video/')) return true
  return isImage(name) || isVideo(name)
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
    const textContent = isText(decrypted.metadata.name) ? await decrypted.blob.text() : undefined
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

const selectedFilesList = computed(() => files.value.filter((file) => selectedFiles.value.has(file.file_name)))
const selectedCount = computed(() => selectedFiles.value.size)
const hasSelection = computed(() => selectedCount.value > 0)
const allVisibleSelected = computed(
  () => paginatedFiles.value.length > 0 && paginatedFiles.value.every((file) => selectedFiles.value.has(file.file_name)),
)

function toggleSelection(name: string, enabled: boolean) {
  const next = new Set(selectedFiles.value)
  if (enabled) next.add(name)
  else next.delete(name)
  selectedFiles.value = next
}

function toggleSelectAll(enabled: boolean) {
  const next = new Set(selectedFiles.value)
  if (enabled) {
    for (const file of paginatedFiles.value) next.add(file.file_name)
  } else {
    for (const file of paginatedFiles.value) next.delete(file.file_name)
  }
  selectedFiles.value = next
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
        const response = await fetch(`${publicApiFileUrl(file.file_name)}?raw=1`, {
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

async function deleteSelected() {
  if (!hasSelection.value || bulkDeleting.value) return
  const selected = [...selectedFilesList.value]
  if (!selected.length) return
  if (!confirm(`Delete ${selected.length} selected file(s)?`)) return
  actionsOpen.value = false
  bulkDeleting.value = true
  let deletedCount = 0
  try {
    for (const file of selected) {
      try {
        await deleteFile(file.file_name)
        files.value = files.value.filter((item) => item.file_name !== file.file_name)
        selectedFiles.value.delete(file.file_name)
        deletedCount += 1
      } catch (error) {
        console.error('Bulk delete failed', { fileName: file.file_name, error })
      }
    }
    if (deletedCount) showToast(`Deleted ${deletedCount} file(s)`)
    if (deletedCount !== selected.length) showToast('Some selected files could not be deleted', 'error')
  } finally {
    bulkDeleting.value = false
  }
}

async function downloadFile(f: PasteFile) {
  const stored = getStoredEncryptedFile(f.file_name)
  if (stored?.key.startsWith('pw:')) {
    openPasswordPreviewModal(f, 'download')
    return
  }
  if (f.file_name.endsWith('.rpenc') && !stored) {
    showToast('Decryption key is required to download this encrypted file', 'error')
    return
  }
  try {
    const response = await fetch(`${publicApiFileUrl(f.file_name)}?raw=1`, {
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

async function buildPreview(f: PasteFile, x = 0, y = 0): Promise<PreviewState> {
  const stored = getStoredEncryptedFile(f.file_name)
  const kind = previewKind(f)
  if (!stored || stored.key.startsWith('pw:')) {
    const response = await fetch(publicFileUrl(f.file_name), {
      cache: 'no-store',
      headers: { Authorization: getAuthToken() },
    })
    if (!response.ok) throw new Error('Preview download failed')
    const payload = await response.blob()
    const textContent = kind === 'text' ? await payload.text() : undefined
    return {
      file: f,
      url: URL.createObjectURL(payload),
      name: previewName(f),
      type: response.headers.get('content-type')
        || (kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : kind === 'text' ? 'text/plain' : 'application/octet-stream'),
      textContent,
      x,
      y,
      loading: false,
    }
  }

  const response = await fetch(`${publicApiFileUrl(f.file_name)}?raw=1`, {
    cache: 'no-store',
    headers: { Authorization: getAuthToken() },
  })
  if (!response.ok) throw new Error('Preview download failed')
  const decrypted = await decryptEncryptedBlob(await response.blob(), stored.key)
  const textContent = kind === 'text' ? await decrypted.blob.text() : undefined
  return {
    file: f,
    url: URL.createObjectURL(decrypted.blob),
    name: decrypted.metadata.name,
    type: decrypted.metadata.type,
    textContent,
    x,
    y,
    loading: false,
  }
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
    const next = await buildPreview(f, e.clientX + 18, e.clientY + 18)
    if (token === hoverToken) hoverPreview.value = next
    else clearPreviewObjectUrl(next)
  } catch {
    if (token === hoverToken) hoverPreview.value = null
  }
}

function hideHover() {
  if (!hoverEnabled) return
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
  void refreshSilently()
}

function onWindowFocus() {
  void refreshSilently()
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') void refreshSilently()
}

function onCompactNamesMediaChange(event: MediaQueryListEvent) {
  compactFileNames.value = event.matches
}

onMounted(() => {
  void load()
  compactFileNamesMediaQuery = window.matchMedia('(max-width: 600px)')
  compactFileNames.value = compactFileNamesMediaQuery.matches
  compactFileNamesMediaQuery.addEventListener('change', onCompactNamesMediaChange)
  window.addEventListener('blur', hideHover)
  window.addEventListener('scroll', hideHover, true)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener(HISTORY_REFRESH_EVENT, onHistoryRefreshEvent)
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('pointerdown', onDocumentPointerDown)
  connectHistorySocket()
  refreshTimer = setInterval(() => {
    if (!wsConnected.value) void refreshSilently()
  }, AUTO_REFRESH_MS)
})
onBeforeUnmount(() => {
  compactFileNamesMediaQuery?.removeEventListener('change', onCompactNamesMediaChange)
  compactFileNamesMediaQuery = null
  window.removeEventListener('blur', hideHover)
  window.removeEventListener('scroll', hideHover, true)
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
})

</script>

<template>
  <div class="history-tab">
    <!-- Toolbar -->
    <div class="toolbar">
      <button class="btn-red toolbar-control toolbar-delete-all" :disabled="!files.length" @click="deleteAll">
        Delete All
      </button>
      <div class="search-wrap toolbar-control">
        <input v-model="search" type="text" placeholder="Search" />
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </div>
    </div>
    <div class="bulk-actions">
      <label class="select-all">
        <input
          type="checkbox"
          :checked="allVisibleSelected"
          :disabled="!paginatedFiles.length || bulkDeleting || bulkDownloading"
          aria-label="Select all files"
          @change="toggleSelectAll(($event.target as HTMLInputElement).checked)"
        />
        <span>Select all</span>
      </label>
      <span class="selection-count">{{ selectedCount }} selected</span>
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
          class="btn-ghost"
          style="padding:4px 10px;font-size:12px"
          :disabled="!hasSelection || bulkDeleting || bulkDownloading"
          aria-haspopup="menu"
          :aria-expanded="actionsOpen ? 'true' : 'false'"
          @click="actionsOpen = !actionsOpen"
        >
          Actions
        </button>
        <div v-if="actionsOpen" class="actions-menu" role="menu">
          <button
            class="btn-ghost"
            style="width:100%;justify-content:flex-start"
            :disabled="bulkDeleting || bulkDownloading"
            @click="downloadSelectedAsZip"
          >
            {{ bulkDownloading ? 'Downloading…' : 'Download Selected' }}
          </button>
          <button
            class="btn-red"
            style="width:100%;justify-content:flex-start"
            :disabled="bulkDeleting || bulkDownloading"
            @click="deleteSelected"
          >
            {{ bulkDeleting ? 'Deleting…' : 'Delete Selected' }}
          </button>
          <button
            class="btn-ghost"
            style="width:100%;justify-content:flex-start"
            :disabled="bulkDeleting || bulkDownloading"
            @click="clearSelection(); actionsOpen = false"
          >
            Clear Selection
          </button>
        </div>
      </div>
    </div>

    <!-- Loading / error -->
    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="state-msg" style="color:var(--red-h)">{{ error }}</div>
    <div v-else-if="!filtered.length" class="state-msg">No files.</div>

    <!-- Table -->
    <div v-else class="table-wrap" @mouseleave="hideHover">
      <table class="file-table">
        <thead>
          <tr>
            <th style="width:1px">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :disabled="!paginatedFiles.length || bulkDeleting || bulkDownloading"
                aria-label="Select all rows"
                @change="toggleSelectAll(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th class="sortable" @click="setSort('file_name')">
              Name <span class="sort-arrow">{{ sortKey === 'file_name' ? (sortDir === 1 ? '↑' : '↓') : '↕' }}</span>
            </th>
            <th class="sortable col-size" @click="setSort('file_size')">
              Size <span class="sort-arrow">{{ sortKey === 'file_size' ? (sortDir === 1 ? '↑' : '↓') : '↕' }}</span>
            </th>
            <th class="sortable col-expiry" @click="setSort('expires_at')">
              Expires At <span class="sort-arrow">{{ sortKey === 'expires_at' ? (sortDir === 1 ? '↑' : '↓') : '↕' }}</span>
            </th>
            <th style="width:1px"></th>
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
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                  <polyline points="13 2 13 9 20 9"/>
                </svg>
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
            <td class="expiry">{{ f.expires_at ?? 'Never' }}</td>
            <td class="actions">
              <div class="action-row">
                <button
                  class="btn-ghost action-btn"
                  style="padding:3px 10px;font-size:11px"
                  :title="canDownloadEncrypted(f) ? 'Download decrypted file' : 'Download file'"
                  aria-label="Download"
                  @click.stop="downloadFile(f)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  <span class="action-label">Download</span>
                </button>
                <button class="btn-orange action-btn" style="padding:3px 10px;font-size:11px" aria-label="Copy" @click.stop="copy(f)">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                  <span class="action-label">Copy</span>
                </button>
                <div class="row-more-wrap">
                  <button
                    class="btn-ghost row-more-btn action-btn"
                    style="padding:3px 10px;font-size:11px"
                    aria-label="More"
                    aria-haspopup="menu"
                    :aria-expanded="rowMoreOpen === f.file_name ? 'true' : 'false'"
                    @click.stop="rowMoreOpen = rowMoreOpen === f.file_name ? null : f.file_name"
                  >
                    ⋯
                  </button>
                  <div v-if="rowMoreOpen === f.file_name" class="row-item-menu" role="menu">
                    <button
                      v-if="isPasswordEncryptedFile(f)"
                      class="btn-ghost"
                      style="width:100%;justify-content:flex-start"
                      :disabled="!canChangeDecryptionPassword(f) || changingPassword"
                      @click.stop="openPasswordModal(f)"
                    >
                      Change decryption password
                    </button>
                    <div v-if="isPasswordEncryptedFile(f)" class="row-item-note">
                      {{ passwordChangesRemaining(f.file_name) }} / {{ PASSWORD_CHANGE_LIMIT }} changes remaining
                    </div>
                    <button
                      class="btn-red row-delete-btn"
                      style="width:100%;justify-content:flex-start"
                      :disabled="deleting.has(f.file_name)"
                      @click.stop="del(f)"
                    >
                      {{ deleting.has(f.file_name) ? 'Deleting…' : 'Delete' }}
                    </button>
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="pagination">
        <button
          class="btn-ghost"
          style="padding:4px 10px;font-size:12px"
          :disabled="currentPage <= 1"
          @click="goToPage(currentPage - 1)"
        >
          Previous
        </button>
        <span>Page {{ currentPage }} of {{ totalPages }}</span>
        <button
          class="btn-ghost"
          style="padding:4px 10px;font-size:12px"
          :disabled="currentPage >= totalPages"
          @click="goToPage(currentPage + 1)"
        >
          Next
        </button>
      </div>
    </div>

    <!-- File preview modal -->
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

    <div v-if="passwordModalOpen" class="modal-backdrop" @click.self="closePasswordModal">
      <div class="password-modal">
        <div class="password-modal-header">
          <strong>Change decryption password</strong>
          <button class="btn-ghost" style="padding:2px 8px" :disabled="changingPassword" @click="closePasswordModal">✕</button>
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
      <div class="password-modal">
        <div class="password-modal-header">
          <strong>{{ passwordPromptAction === 'download' ? 'Download password-encrypted file' : 'Preview password-encrypted file' }}</strong>
          <button class="btn-ghost" style="padding:2px 8px" :disabled="passwordPreviewBusy" @click="closePasswordPreviewModal">✕</button>
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

  </div>
</template>

<style scoped>
.history-tab { display: flex; flex-direction: column; gap: 10px; padding-bottom: 20px; }
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 210;
  background: var(--modal-bg);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
}
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.toolbar-control {
  min-height: 34px;
  border-radius: var(--radius);
  font-size: 12px;
}
.toolbar-delete-all {
  padding: 0 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bulk-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.select-all { display: inline-flex; align-items: center; gap: 6px; color: var(--text2); font-size: 12px; }
.selection-count { color: var(--text3); font-size: 11px; }
.actions-menu-wrap { position: relative; }
.page-size-wrap { display: inline-flex; align-items: center; gap: 8px; }
.page-size-label { color: var(--text3); font-size: 11px; }
.page-size-segment {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg);
}
.page-size-btn {
  border: 0;
  border-radius: 0;
  min-width: 34px;
  padding: 4px 8px;
  font-size: 12px;
  background: transparent;
  color: var(--text2);
}
.page-size-btn.active {
  background: var(--bg2);
  color: var(--text);
}
.page-size-btn:hover:not(.active) {
  background: var(--bg1);
  color: var(--text);
}
.actions-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 160px;
  padding: 6px;
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg1);
  box-shadow: 0 8px 24px var(--shadow);
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.search-wrap {
  position: relative;
  width: min(100%, 220px);
  display: inline-flex;
  align-items: center;
}
.search-wrap input {
  width: 100%;
  height: 100%;
  min-height: inherit;
  padding-right: 28px;
}
.search-icon { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--text3); pointer-events: none; }
.table-wrap { overflow-x: auto; }
.pagination {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  color: var(--text3);
  font-size: 11px;
}
.sort-arrow { color: var(--text3); font-size: 10px; margin-left: 2px; }
.state-msg { color: var(--text2); font-size: 12px; padding: 20px 0; text-align: center; }
.select-col { width: 1px; }
.filename { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.filename-text { min-width: 0; display: inline-flex; align-items: baseline; max-width: 100%; }
.filename-base {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.filename-ext { white-space: nowrap; flex-shrink: 0; }
.lock-icon { color: var(--accent); flex-shrink: 0; }
.sharex-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  object-fit: contain;
}
@media (hover: hover) and (pointer: fine) {
  .filename:hover { color: var(--accent); }
}
.file-table td.name { max-width: 0; width: auto; overflow: hidden; }
.action-row { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: nowrap; }
.action-btn { display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; }
.action-label { display: inline; }
.row-more-wrap { position: relative; }
.row-item-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  min-width: 220px;
  padding: 6px;
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg1);
  box-shadow: 0 8px 24px var(--shadow);
  z-index: 25;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row-item-note {
  color: var(--text3);
  font-size: 10px;
  padding: 0 2px 4px;
}
.row-delete-btn {
  border-color: var(--red);
  color: var(--red-h);
}
.row-delete-btn:hover:not(:disabled) {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
}
.password-modal {
  width: min(420px, calc(100vw - 24px));
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg1);
  padding: 14px;
}
.password-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.password-modal-copy {
  color: var(--text3);
  font-size: 11px;
  margin-bottom: 6px;
}
.password-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.password-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--text2);
}
.password-modal-error {
  color: var(--red-h);
  font-size: 12px;
  margin-top: 8px;
}
.password-modal-status {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text2);
  font-size: 12px;
}
.password-modal-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.busy-inline {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

@media (max-width: 600px) {
  .toolbar {
    align-items: stretch;
  }
  .toolbar-control,
  .search-wrap {
    width: 100%;
  }
  .table-wrap { overflow-x: hidden; }
  .file-table { table-layout: fixed; width: 100%; }
  .file-table th:last-child,
  .file-table td.actions { width: 118px; }
  .filename { width: 100%; min-width: 0; }
  .action-label { display: none; }
  .action-btn {
    min-width: 30px;
    width: 30px;
    padding: 3px !important;
  }
  .action-btn svg { margin-right: 0 !important; }
  .row-item-menu {
    right: 0;
    left: auto;
    max-width: calc(100vw - 20px);
  }
  .pagination {
    justify-content: space-between;
    gap: 6px;
    font-size: 10px;
  }
}
.hover-preview {
  position: fixed;
  z-index: 300;
  width: 220px;
  max-width: calc(100vw - 32px);
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  background: var(--bg1);
  padding: 6px;
  pointer-events: none;
  box-shadow: 0 8px 24px var(--shadow);
}
.hover-preview img,
.hover-preview video {
  display: block;
  width: 100%;
  max-height: 150px;
  object-fit: contain;
  background: var(--bg);
}
.hover-loading {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text3);
  font-size: 11px;
  padding: 36px 8px;
  justify-content: center;
  width: 100%;
}
.loading-spinner {
  width: 12px;
  height: 12px;
  border-radius: 999px;
  border: 2px solid var(--border2);
  border-top-color: var(--orange);
  animation: spin 0.8s linear infinite;
}
.hover-name {
  color: var(--text3);
  font-size: 10px;
  margin-top: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
