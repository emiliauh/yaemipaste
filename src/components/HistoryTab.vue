<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { listFiles, deleteFile, fileUrl, formatBytes, type PasteFile } from '../lib/api'
import Toast from './Toast.vue'
import FilePreview from './FilePreview.vue'

const files = ref<PasteFile[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const toast = ref<{ msg: string; type: 'success' | 'error' } | null>(null)
const sortKey = ref<'file_name' | 'file_size' | 'expires_at'>('file_name')
const sortDir = ref<1 | -1>(1)
const preview = ref<PasteFile | null>(null)
const deleting = ref<Set<string>>(new Set())

function showToast(msg: string, type: 'success' | 'error' = 'success') {
  toast.value = { msg, type }
  setTimeout(() => (toast.value = null), 3000)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    files.value = await listFiles()
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
    await navigator.clipboard.writeText(fileUrl(f.file_name))
    showToast('Copied to clipboard')
  } catch {
    showToast('Copy failed', 'error')
  }
}

async function del(f: PasteFile) {
  if (deleting.value.has(f.file_name)) return
  deleting.value.add(f.file_name)
  try {
    await deleteFile(f.file_name)
    files.value = files.value.filter((x) => x.file_name !== f.file_name)
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

function isImage(name: string) { return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name) }
function isVideo(name: string) { return /\.(mp4|webm|mkv|mov|avi)$/i.test(name) }
function isPreviewable(name: string) { return isImage(name) || isVideo(name) }

onMounted(load)
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

    <!-- Loading / error -->
    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="state-msg" style="color:var(--red-h)">{{ error }}</div>
    <div v-else-if="!filtered.length" class="state-msg">No files.</div>

    <!-- Table -->
    <div v-else class="table-wrap">
      <table class="file-table">
        <thead>
          <tr>
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
          >
            <td class="name">
              <span
                class="filename"
                :title="fileUrl(f.file_name)"
                @click="isPreviewable(f.file_name) ? (preview = f) : copy(f)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                  <polyline points="13 2 13 9 20 9"/>
                </svg>
                {{ f.file_name }}
              </span>
            </td>
            <td class="size">{{ formatBytes(f.file_size) }}</td>
            <td class="expiry">{{ f.expires_at ?? 'Never' }}</td>
            <td class="actions">
              <div class="action-row">
                <button class="btn-orange" style="padding:3px 10px;font-size:11px" @click="copy(f)">Copy</button>
                <button
                  class="btn-red"
                  style="padding:3px 10px;font-size:11px"
                  :disabled="deleting.has(f.file_name)"
                  @click="del(f)"
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
    <FilePreview v-if="preview" :file="preview" @close="preview = null" />

    <Toast v-if="toast" :message="toast.msg" :type="toast.type" />
  </div>
</template>

<style scoped>
.history-tab { display: flex; flex-direction: column; gap: 10px; padding-bottom: 20px; }
.toolbar { display: flex; align-items: center; gap: 8px; }
.search-wrap { position: relative; }
.search-wrap input { padding-right: 28px; }
.search-icon { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--text3); pointer-events: none; }
.table-wrap { overflow-x: auto; }
.sort-arrow { color: var(--text3); font-size: 10px; margin-left: 2px; }
.state-msg { color: var(--text2); font-size: 12px; padding: 20px 0; text-align: center; }
.filename { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.filename:hover { color: var(--orange); }
.action-row { display: flex; gap: 6px; justify-content: flex-end; }
</style>
