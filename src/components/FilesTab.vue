<script setup lang="ts">
import { ref } from 'vue'
import { uploadFile, uploadText, type UploadProgress } from '../lib/api'
import ExpirySelector, { type ExpiryValue } from './ExpirySelector.vue'
import Toast from './Toast.vue'

const EXPIRY_KEY = 'rp_expiry'
const EXPIRY_VALUES: ExpiryValue[] = ['12h', '1d', '3d', '7d', '14d']
const savedExpiry = localStorage.getItem(EXPIRY_KEY) as ExpiryValue | null
const expiry = ref<ExpiryValue>(savedExpiry && EXPIRY_VALUES.includes(savedExpiry) ? savedExpiry : '14d')
const dragging = ref(false)
const textPaste = ref('')
const loading = ref(false)
const toast = ref<{ msg: string; type: 'success' | 'error' } | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const longPressing = ref(false)
const lastShareUrl = ref('')
const uploadProgress = ref<UploadProgress | null>(null)

function setProgress(progress: UploadProgress) {
  uploadProgress.value = progress
}

function setExpiry(value: ExpiryValue) {
  expiry.value = value
  localStorage.setItem(EXPIRY_KEY, value)
}

function showToast(msg: string, type: 'success' | 'error' = 'success') {
  toast.value = { msg, type }
  setTimeout(() => (toast.value = null), 3000)
}

async function copyShareUrl(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url.trim())
    return true
  } catch {
    return false
  }
}

async function handleFiles(files: FileList | File[]) {
  loading.value = true
  const arr = Array.from(files)
  for (const f of arr) {
    try {
      uploadProgress.value = { phase: 'encrypting', percent: 0 }
      const url = await uploadFile(f, expiry.value, setProgress)
      lastShareUrl.value = url.trim()
      if (await copyShareUrl(lastShareUrl.value)) showToast(`Encrypted & copied: ${f.name}`)
      else showToast(`Encrypted: ${f.name}. Copy the link below.`, 'error')
    } catch (e: any) {
      showToast(e.message ?? 'Upload failed', 'error')
    }
  }
  loading.value = false
  uploadProgress.value = null
}

function onDrop(e: DragEvent) {
  dragging.value = false
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files)
}

function onClickZone() {
  fileInput.value?.click()
}

function onFileChange(e: Event) {
  const t = e.target as HTMLInputElement
  if (t.files?.length) handleFiles(t.files)
}

async function submitText() {
  if (!textPaste.value.trim()) return
  loading.value = true
  try {
    uploadProgress.value = { phase: 'encrypting', percent: 0 }
    const url = await uploadText(textPaste.value, expiry.value, setProgress)
    lastShareUrl.value = url.trim()
    if (await copyShareUrl(lastShareUrl.value)) showToast('Text encrypted & copied')
    else showToast('Text encrypted. Copy the link below.', 'error')
    textPaste.value = ''
  } catch (e: any) {
    showToast(e.message ?? 'Upload failed', 'error')
  } finally {
    loading.value = false
    uploadProgress.value = null
  }
}

// Long-press paste support
let pressTimer: ReturnType<typeof setTimeout> | null = null
let longPressReady = false

function onPasteAreaLongPressStart(e: PointerEvent) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  longPressReady = false
  longPressing.value = true
  pressTimer = setTimeout(() => {
    longPressReady = true
  }, 550)
}

async function onPasteAreaLongPressEnd() {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = null
  longPressing.value = false

  if (!longPressReady) return
  longPressReady = false
  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      textPaste.value = text
      showToast('Pasted from clipboard')
    }
  } catch {
    showToast('Clipboard permission blocked', 'error')
  }
}

function onPasteAreaLongPressCancel() {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = null
  longPressReady = false
  longPressing.value = false
}
</script>

<template>
  <div class="files-tab">
    <ExpirySelector :model-value="expiry" @update:model-value="setExpiry" />

    <div class="security-strip">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="4" y="10" width="16" height="10" rx="2"/>
        <path d="M8 10V7a4 4 0 0 1 8 0v3"/>
      </svg>
      <div>
        <div class="security-title">End-to-end encrypted</div>
        <div class="security-copy">Files are sealed before upload. The key stays in the share link.</div>
      </div>
    </div>

    <!-- Drop zone -->
    <div
      class="upload-zone"
      :class="{ 'drag-over': dragging }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
      @click="onClickZone"
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polyline points="16 16 12 12 8 16"/>
        <line x1="12" y1="12" x2="12" y2="21"/>
        <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
      </svg>
      <div>drag &amp; drop or click to upload files</div>
      <input ref="fileInput" type="file" multiple style="display:none" @change="onFileChange" />
    </div>

    <!-- Long-press to paste -->
    <div
      class="paste-area"
      :class="{ pressing: longPressing }"
      data-testid="paste-area"
      @pointerdown="onPasteAreaLongPressStart"
      @pointerup="onPasteAreaLongPressEnd"
      @pointercancel="onPasteAreaLongPressCancel"
      @pointerleave="onPasteAreaLongPressCancel"
      @contextmenu.prevent
    >
      <span style="color:var(--text3); font-size:12px">{{ longPressing ? 'Release to paste' : 'Long-press here to paste' }}</span>
    </div>

    <div class="divider">— or — paste text directly</div>

    <!-- Text area -->
    <textarea
      v-model="textPaste"
      data-testid="text-paste"
      rows="6"
      placeholder="Paste your text here..."
      style="width:100%; resize:vertical"
    />

    <div style="display:flex; justify-content:flex-end; margin-top:10px">
      <button class="btn-primary" :disabled="loading || !textPaste.trim()" @click="submitText">
        {{ loading ? 'Uploading…' : 'Upload Text' }}
      </button>
    </div>

    <div v-if="uploadProgress" class="upload-progress" data-testid="upload-progress">
      <div class="progress-row">
        <span>{{ uploadProgress.phase === 'encrypting' ? 'Encrypting' : uploadProgress.phase === 'complete' ? 'Complete' : 'Uploading' }}</span>
        <span>{{ uploadProgress.percent }}%</span>
      </div>
      <div class="progress-track" role="progressbar" :aria-valuenow="uploadProgress.percent" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-fill" :style="{ width: `${uploadProgress.percent}%` }"></div>
      </div>
    </div>

    <div v-if="lastShareUrl" class="share-result">
      <div class="share-label">Latest encrypted link</div>
      <a :href="lastShareUrl" target="_blank" rel="noopener">{{ lastShareUrl }}</a>
      <button class="btn-ghost" type="button" @click="copyShareUrl(lastShareUrl).then((ok) => showToast(ok ? 'Copied to clipboard' : 'Copy failed', ok ? 'success' : 'error'))">
        Copy
      </button>
    </div>

    <Toast v-if="toast" :message="toast.msg" :type="toast.type" />
  </div>
</template>

<style scoped>
.files-tab { display: flex; flex-direction: column; gap: 12px; padding-bottom: 96px; }
.security-strip {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: linear-gradient(90deg, var(--bg1), #111111);
  color: var(--text2);
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
}
.security-strip svg {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}
.security-title {
  color: var(--text);
  font-size: 12px;
}
.security-copy {
  color: var(--text3);
  font-size: 11px;
}
.share-result {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg1);
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 10px;
  align-items: center;
  padding: 10px 12px;
}
.share-label {
  grid-column: 1 / -1;
  color: var(--text3);
  font-size: 10px;
  text-transform: uppercase;
}
.share-result a {
  color: var(--accent-h);
  font-size: 12px;
  overflow-wrap: anywhere;
  text-decoration: none;
}
.upload-progress {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg1);
  padding: 10px 12px;
}
.progress-row {
  display: flex;
  justify-content: space-between;
  color: var(--text3);
  font-size: 11px;
  margin-bottom: 7px;
}
.progress-track {
  height: 7px;
  background: var(--bg);
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, var(--accent), var(--accent-h));
  transition: width 0.12s ease;
}
.paste-area {
  border: 1px dashed var(--border2);
  border-radius: var(--radius);
  padding: 12px 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  touch-action: manipulation;
  user-select: none;
  -webkit-touch-callout: none;
}
.paste-area:hover { border-color: var(--text3); }
.paste-area.pressing {
  border-color: var(--accent);
  background: var(--bg1);
}
.divider { text-align: center; color: var(--text3); font-size: 12px; }

@media (max-width: 600px) {
  .share-result {
    grid-template-columns: 1fr;
  }
}
</style>
