<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { zipSync } from 'fflate'
import { listFiles, deleteFile, formatBytes, publicApiFileUrl, publicFileUrl, shareUrl, type PasteFile } from '../lib/api'
import { decryptEncryptedBlob, getStoredEncryptedFile } from '../lib/e2ee'
import FilePreview from './FilePreview.vue'
import { useNotificationStore } from '../stores/notifications'

interface PreviewState {
  file: PasteFile
  url: string
  name: string
  type: string
  x: number
  y: number
  loading: boolean
}

const files = ref<PasteFile[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const sortKey = ref<'file_name' | 'file_size' | 'expires_at'>('file_name')
const sortDir = ref<1 | -1>(1)
const preview = ref<PreviewState | null>(null)
const hoverPreview = ref<PreviewState | null>(null)
const deleting = ref<Set<string>>(new Set())
const selectedFiles = ref<Set<string>>(new Set())
const actionsOpen = ref(false)
const bulkDeleting = ref(false)
const bulkDownloading = ref(false)
const hoverEnabled = window.matchMedia('(hover: hover) and (pointer: fine)').matches
const notificationStore = useNotificationStore()
let hoverToken = 0

function showToast(msg: string, type: 'success' | 'error' = 'success') {
  notificationStore.push(msg, type)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    files.value = await listFiles()
    const knownNames = new Set(files.value.map((file) => file.file_name))
    selectedFiles.value = new Set([...selectedFiles.value].filter((name) => knownNames.has(name)))
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
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
      return String(av).localeCompare(String(bv)) * sortDir.value
    })
})

async function copy(f: PasteFile) {
  try {
    await navigator.clipboard.writeText(shareUrl(f.file_name))
    showToast('Copied to clipboard')
  } catch {
    showToast('Copy failed', 'error')
  }
}

async function del(f: PasteFile) {
  if (deleting.value.has(f.file_name)) return
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
  return getStoredEncryptedFile(f.file_name)?.name ?? f.file_name
}

function isImage(name: string) { return /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico)$/i.test(name) }
function isVideo(name: string) { return /\.(mp4|webm|mov|avi|mkv|ogv|m4v|3gp)$/i.test(name) }
function isPreviewable(f: PasteFile) { return isImage(previewName(f)) || isVideo(previewName(f)) }

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

const selectedInView = computed(() => filtered.value.filter((file) => selectedFiles.value.has(file.file_name)))
const selectedCount = computed(() => selectedFiles.value.size)
const hasSelection = computed(() => selectedCount.value > 0)
const allVisibleSelected = computed(() => filtered.value.length > 0 && selectedInView.value.length === filtered.value.length)

function toggleSelection(name: string, enabled: boolean) {
  const next = new Set(selectedFiles.value)
  if (enabled) next.add(name)
  else next.delete(name)
  selectedFiles.value = next
}

function toggleSelectAll(enabled: boolean) {
  const next = new Set(selectedFiles.value)
  if (enabled) {
    for (const file of filtered.value) next.add(file.file_name)
  } else {
    for (const file of filtered.value) next.delete(file.file_name)
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
  const selected = [...selectedInView.value]
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
  const selected = [...selectedInView.value]
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
  if (!stored || stored.key.startsWith('pw:')) {
    return {
      file: f,
      url: `${publicFileUrl(f.file_name)}?raw=1`,
      name: f.file_name,
      type: isImage(f.file_name) ? 'image/*' : 'video/*',
      x,
      y,
      loading: false,
    }
  }

  const response = await fetch(`${publicApiFileUrl(f.file_name)}?raw=1`)
  if (!response.ok) throw new Error('Preview download failed')
  const decrypted = await decryptEncryptedBlob(await response.blob(), stored.key)
  return {
    file: f,
    url: URL.createObjectURL(decrypted.blob),
    name: decrypted.metadata.name,
    type: decrypted.metadata.type,
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
  if (!isPreviewable(f)) return
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
  if (!isPreviewable(f)) {
    await copy(f)
    return
  }
  try {
    const next = await buildPreview(f)
    clearPreviewObjectUrl(preview.value)
    preview.value = next
  } catch (e: any) {
    showToast(e.message ?? 'Preview failed', 'error')
  }
}

function closePreview() {
  clearPreviewObjectUrl(preview.value)
  preview.value = null
}

watch(filtered, (nextFiles) => {
  if (!hoverPreview.value) return
  const stillVisible = nextFiles.some((item) => item.file_name === hoverPreview.value?.file.file_name)
  if (!stillVisible) hideHover()
})

onMounted(() => {
  void load()
  window.addEventListener('blur', hideHover)
  window.addEventListener('scroll', hideHover, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('blur', hideHover)
  window.removeEventListener('scroll', hideHover, true)
  clearPreviewObjectUrl(preview.value)
  clearPreviewObjectUrl(hoverPreview.value)
})

watch(filtered, (nextFiles) => {
  const visible = new Set(nextFiles.map((file) => file.file_name))
  if (!visible.size) actionsOpen.value = false
})
</script>

<template>
  <div class="history-tab">
    <!-- Toolbar -->
    <div class="toolbar">
      <button class="btn-red" style="padding:4px 12px;font-size:12px" :disabled="!files.length" @click="deleteAll">
        Delete All
      </button>
      <div class="search-wrap">
        <input v-model="search" type="text" placeholder="Search" style="width:180px" />
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
          :disabled="!filtered.length || bulkDeleting || bulkDownloading"
          aria-label="Select all files"
          @change="toggleSelectAll(($event.target as HTMLInputElement).checked)"
        />
        <span>Select all</span>
      </label>
      <span class="selection-count">{{ selectedCount }} selected</span>
      <div class="actions-menu-wrap">
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
                :disabled="!filtered.length || bulkDeleting || bulkDownloading"
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
            v-for="f in filtered"
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
                <svg v-if="getStoredEncryptedFile(f.file_name)" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="lock-icon" :title="isPasswordEncryptedFile(f) ? 'Password-encrypted' : 'Encrypted'">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                {{ previewName(f) }}
              </span>
            </td>
            <td class="size">{{ formatBytes(f.file_size) }}</td>
            <td class="expiry">{{ f.expires_at ?? 'Never' }}</td>
            <td class="actions">
              <div class="action-row">
                <button
                  class="btn-ghost"
                  style="padding:3px 8px;font-size:11px"
                  :title="canDownloadEncrypted(f) ? 'Download decrypted file' : 'Download file'"
                  aria-label="Download"
                  @click.stop="downloadFile(f)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
                <button class="btn-orange" style="padding:3px 10px;font-size:11px" @click.stop="copy(f)">Copy</button>
                <button
                  class="btn-red"
                  style="padding:3px 10px;font-size:11px"
                  :disabled="deleting.has(f.file_name)"
                  @click.stop="del(f)"
                >
                  Delete
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- File preview modal -->
    <div
      v-if="hoverPreview"
      class="hover-preview"
      :style="{ left: `${hoverPreview.x}px`, top: `${hoverPreview.y}px` }"
    >
      <div v-if="hoverPreview.loading" class="hover-loading">Decrypting…</div>
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
      @close="closePreview"
    />

  </div>
</template>

<style scoped>
.history-tab { display: flex; flex-direction: column; gap: 10px; padding-bottom: 20px; }
.toolbar { display: flex; align-items: center; gap: 8px; }
.bulk-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.select-all { display: inline-flex; align-items: center; gap: 6px; color: var(--text2); font-size: 12px; }
.selection-count { color: var(--text3); font-size: 11px; }
.actions-menu-wrap { position: relative; }
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
.search-wrap { position: relative; }
.search-wrap input { padding-right: 28px; }
.search-icon { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--text3); pointer-events: none; }
.table-wrap { overflow-x: auto; }
.sort-arrow { color: var(--text3); font-size: 10px; margin-left: 2px; }
.state-msg { color: var(--text2); font-size: 12px; padding: 20px 0; text-align: center; }
.select-col { width: 1px; }
.filename { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.lock-icon { color: var(--accent); flex-shrink: 0; }
@media (hover: hover) and (pointer: fine) {
  .filename:hover { color: var(--accent); }
}
.action-row { display: flex; gap: 6px; justify-content: flex-end; }
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
  color: var(--text3);
  font-size: 11px;
  padding: 36px 8px;
  text-align: center;
}
.hover-name {
  color: var(--text3);
  font-size: 10px;
  margin-top: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
