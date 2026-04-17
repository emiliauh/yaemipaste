<script setup lang="ts">
import { ref } from 'vue'
import { uploadFile, uploadText } from '../lib/api'
import ExpirySelector, { type ExpiryValue } from './ExpirySelector.vue'
import Toast from './Toast.vue'

const EXPIRY_KEY = 'rp_expiry'
const expiry = ref<ExpiryValue>((localStorage.getItem(EXPIRY_KEY) as ExpiryValue | null) ?? '14d')
const dragging = ref(false)
const textPaste = ref('')
const loading = ref(false)
const toast = ref<{ msg: string; type: 'success' | 'error' } | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const longPressing = ref(false)

function setExpiry(value: ExpiryValue) {
  expiry.value = value
  localStorage.setItem(EXPIRY_KEY, value)
}

function showToast(msg: string, type: 'success' | 'error' = 'success') {
  toast.value = { msg, type }
  setTimeout(() => (toast.value = null), 3000)
}

async function handleFiles(files: FileList | File[]) {
  loading.value = true
  const arr = Array.from(files)
  for (const f of arr) {
    try {
      const url = await uploadFile(f, expiry.value)
      await navigator.clipboard.writeText(url.trim())
      showToast(`Encrypted & copied: ${f.name}`)
    } catch (e: any) {
      showToast(e.message ?? 'Upload failed', 'error')
    }
  }
  loading.value = false
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
    const url = await uploadText(textPaste.value, expiry.value)
    await navigator.clipboard.writeText(url.trim())
    showToast('Text encrypted & copied')
    textPaste.value = ''
  } catch (e: any) {
    showToast(e.message ?? 'Upload failed', 'error')
  } finally {
    loading.value = false
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

    <Toast v-if="toast" :message="toast.msg" :type="toast.type" />
  </div>
</template>

<style scoped>
.files-tab { display: flex; flex-direction: column; gap: 12px; padding-bottom: 20px; }
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
  border-color: var(--orange);
  background: var(--bg1);
}
.divider { text-align: center; color: var(--text3); font-size: 12px; }
</style>
