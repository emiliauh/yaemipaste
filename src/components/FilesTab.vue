<script setup lang="ts">
import { ref, watch } from 'vue'
import { publicFileUrl, publicSiteOrigin, uploadFile, uploadText, type UploadProgress } from '../lib/api'
import ExpirySelector from './ExpirySelector.vue'
import { defaultExpiryValue, isValidExpiryValue, type ExpiryValue } from '../lib/expiry'
import { useNotificationStore } from '../stores/notifications'

const EXPIRY_KEY = 'rp_expiry'
const KEEP_NAME_KEY = 'rp_keep_file_name'
const HISTORY_REFRESH_EVENT = 'rp:history-refresh'
const savedExpiry = localStorage.getItem(EXPIRY_KEY)
const keepNameSaved = localStorage.getItem(KEEP_NAME_KEY)
const expiry = ref<ExpiryValue>(isValidExpiryValue(savedExpiry) ? savedExpiry : defaultExpiryValue)
const keepFileName = ref(keepNameSaved !== '0')
const dragging = ref(false)
const textPaste = ref('')
const loading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const longPressing = ref(false)
interface ShareLinkItem {
  id: number
  name: string
  previewUrl: string
  embedUrl: string | null
  showingEmbed: boolean
}
const shareLinks = ref<ShareLinkItem[]>([])
const uploadProgress = ref<UploadProgress | null>(null)
const encryptMode = ref<'none' | 'encrypt' | 'password'>('none')
const encryptPassword = ref('')
let shareLinkId = 0
const notificationStore = useNotificationStore()

watch(keepFileName, (value) => {
  localStorage.setItem(KEEP_NAME_KEY, value ? '1' : '0')
})

function cycleEncrypt() {
  if (encryptMode.value === 'none') encryptMode.value = 'encrypt'
  else if (encryptMode.value === 'encrypt') encryptMode.value = 'password'
  else { encryptMode.value = 'none'; encryptPassword.value = '' }
}

function setProgress(progress: UploadProgress) {
  uploadProgress.value = progress
}

function setExpiry(value: ExpiryValue) {
  expiry.value = value
  localStorage.setItem(EXPIRY_KEY, value)
}

function showToast(msg: string, type: 'success' | 'error' = 'success') {
  notificationStore.push(msg, type)
}

function notifyHistoryRefresh() {
  window.dispatchEvent(new CustomEvent(HISTORY_REFRESH_EVENT))
}

function clearNotifications() {
  notificationStore.clear()
}

function isEmbeddableFileName(name: string): boolean {
  return /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico|mp4|webm|mov|m4v|ogv)$/i.test(name)
}

function absolutePublicUrl(value: string): string {
  return new URL(value, publicSiteOrigin()).toString()
}

function currentShareUrl(share: ShareLinkItem): string {
  if (share.showingEmbed && share.embedUrl) return share.embedUrl
  return share.previewUrl
}

function toggleShareLinkMode(shareId: number) {
  shareLinks.value = shareLinks.value.map((item) => {
    if (item.id !== shareId || !item.embedUrl) return item
    return { ...item, showingEmbed: !item.showingEmbed }
  })
}

function pushShareLink(name: string, previewUrl: string, fileName: string) {
  const isEncrypted = fileName.toLowerCase().endsWith('.rpenc')
  const embedUrl = !isEncrypted && isEmbeddableFileName(fileName)
    ? absolutePublicUrl(publicFileUrl(fileName))
    : null
  const entry: ShareLinkItem = {
    id: ++shareLinkId,
    name,
    previewUrl: absolutePublicUrl(previewUrl),
    embedUrl,
    showingEmbed: false,
  }
  shareLinks.value = [
    entry,
    ...shareLinks.value.filter((item) => item.previewUrl !== entry.previewUrl),
  ].slice(0, 20)
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
  if (loading.value) {
    showToast('Upload already in progress', 'error')
    return
  }
  if (encryptMode.value === 'password' && !encryptPassword.value.trim()) {
    showToast('Enter a password before uploading', 'error')
    return
  }
  loading.value = true
  const mode = encryptMode.value
  const pw = encryptPassword.value.trim()
  const shouldKeepFileName = keepFileName.value
  const selectedExpiry = expiry.value === 'never' ? undefined : expiry.value
  const arr = Array.from(files)
  for (const f of arr) {
    try {
      uploadProgress.value = { phase: mode !== 'none' ? 'encrypting' : 'uploading', percent: mode !== 'none' ? 0 : 1 }
      const upload = await uploadFile(f, {
        expiry: selectedExpiry,
        encrypt: mode === 'encrypt',
        password: mode === 'password' ? pw : undefined,
        keepFileName: shouldKeepFileName,
        onProgress: setProgress,
      })
      const url = upload.url.trim()
      pushShareLink(f.name, url, upload.fileName)
      const label = mode === 'password' ? 'Password-encrypted' : mode === 'encrypt' ? 'Encrypted' : 'Uploaded'
      if (await copyShareUrl(url)) showToast(`${label} & copied: ${f.name}`)
      else showToast(`${label}: ${f.name}. Copy the link below.`)
      notifyHistoryRefresh()
    } catch (e: any) {
      showToast(e.message ?? 'Upload failed', 'error')
    }
  }
  loading.value = false
  uploadProgress.value = null
  if (fileInput.value) fileInput.value.value = ''
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
  if (loading.value) {
    showToast('Upload already in progress', 'error')
    return
  }
  if (encryptMode.value === 'password' && !encryptPassword.value.trim()) {
    showToast('Enter a password before uploading', 'error')
    return
  }
  loading.value = true
  const mode = encryptMode.value
  const pw = encryptPassword.value.trim()
  const shouldKeepFileName = keepFileName.value
  const selectedExpiry = expiry.value === 'never' ? undefined : expiry.value
  try {
    uploadProgress.value = { phase: mode !== 'none' ? 'encrypting' : 'uploading', percent: mode !== 'none' ? 0 : 1 }
    const upload = await uploadText(textPaste.value, {
      expiry: selectedExpiry,
      encrypt: mode === 'encrypt',
      password: mode === 'password' ? pw : undefined,
      keepFileName: shouldKeepFileName,
      onProgress: setProgress,
    })
    const url = upload.url.trim()
    pushShareLink('paste.txt', url, upload.fileName)
    const label = mode === 'password' ? 'password-encrypted' : mode === 'encrypt' ? 'encrypted' : 'uploaded'
    if (await copyShareUrl(url)) showToast(`Text ${label} & copied`)
    else showToast(`Text ${label}. Copy the link below.`)
    textPaste.value = ''
    notifyHistoryRefresh()
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
        <div class="security-title">Upload security</div>
        <div class="security-copy">
          <template v-if="encryptMode === 'password'">Password mode: only someone with the password can view this file.</template>
          <template v-else-if="encryptMode === 'encrypt'">Strong mode: encrypted in your browser before upload.</template>
          <template v-else>Default mode: fast upload with clean short links.</template>
        </div>
      </div>
    </div>
    <div class="upload-options">
      <button
        type="button"
        class="encrypt-toggle encrypt-btn"
        :class="{ 'active-encrypt': encryptMode === 'encrypt', 'active-password': encryptMode === 'password' }"
        data-testid="encrypt-toggle"
        @click="cycleEncrypt"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <span>{{ encryptMode === 'none' ? 'encrypt?' : encryptMode === 'encrypt' ? 'Encrypt' : 'Password encrypt' }}</span>
      </button>
      <Transition name="pw-field">
        <input
          v-if="encryptMode === 'password'"
          v-model="encryptPassword"
          type="password"
          class="pw-input"
          placeholder="set password…"
          autocomplete="new-password"
        />
      </Transition>
      <label class="encrypt-toggle" data-testid="keep-name-toggle">
        <input v-model="keepFileName" type="checkbox" />
        <span>keep file name?</span>
      </label>
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

    <div class="text-actions-row">
      <button
        class="btn-ghost"
        type="button"
        data-testid="clear-notifications"
        :disabled="!notificationStore.notifications.length"
        @click="clearNotifications"
      >
        Clear Notifications
      </button>
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

    <div v-if="shareLinks.length" class="share-result">
      <div class="share-label">Latest share link</div>
      <div v-for="share in shareLinks" :key="share.id" class="share-row" data-testid="share-row">
        <div class="share-link-block">
          <span class="share-file">{{ share.name }}</span>
          <span v-if="share.embedUrl" class="share-mode" data-testid="share-link-mode">{{ share.showingEmbed ? 'Raw media URL' : 'Preview URL' }}</span>
          <a :href="currentShareUrl(share)" target="_blank" rel="noopener">{{ currentShareUrl(share) }}</a>
        </div>
        <div class="share-actions">
          <button
            v-if="share.embedUrl"
            class="btn-ghost"
            type="button"
            data-testid="share-link-mode-toggle"
            @click="toggleShareLinkMode(share.id)"
          >
            {{ share.showingEmbed ? 'Show preview URL' : 'Show raw media URL' }}
          </button>
          <button class="btn-ghost" type="button" @click="copyShareUrl(currentShareUrl(share)).then((ok) => showToast(ok ? 'Copied to clipboard' : 'Copy failed', ok ? 'success' : 'error'))">
            Copy
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.files-tab { display: flex; flex-direction: column; gap: 12px; padding-bottom: 18px; }
.security-strip {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: linear-gradient(90deg, var(--bg1), var(--subtle-grad-end));
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
.upload-options {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.encrypt-toggle {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg1);
  display: inline-flex;
  align-items: center;
  gap: 9px;
   min-height: 36px;
   padding: 0 10px;
   color: var(--text2);
   font-size: 12px;
   width: fit-content;
   box-sizing: border-box;
}
.encrypt-btn {
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.encrypt-btn:hover { border-color: var(--text3); }
.encrypt-btn.active-encrypt {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--checked-bg);
}
.encrypt-btn.active-password {
  border-color: var(--orange-h, #f0963a);
  color: var(--orange-h, #f0963a);
  background: color-mix(in srgb, var(--orange-h, #f0963a) 10%, transparent);
}
.encrypt-toggle input {
  appearance: none;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--border2);
  border-radius: 2px;
  background: var(--bg);
  display: inline-block;
  flex-shrink: 0;
  position: relative;
}
.encrypt-toggle input:checked {
  border-color: var(--accent);
  background: var(--checked-bg);
}
.encrypt-toggle input:checked::after {
  content: "";
  position: absolute;
  inset: 2px;
  background: var(--accent);
  border-radius: 1px;
}
.pw-input {
   width: 140px;
   min-height: 36px;
   font-size: 12px;
   padding: 0 10px;
   box-sizing: border-box;
}
.pw-field-enter-active,
.pw-field-leave-active {
  transition: opacity 0.18s ease, max-width 0.22s ease;
  overflow: hidden;
  max-width: 160px;
}
.pw-field-enter-from,
.pw-field-leave-to {
  opacity: 0;
  max-width: 0;
}
.share-result {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg1);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}
.share-label {
  color: var(--text3);
  font-size: 10px;
  text-transform: uppercase;
}
.share-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}
.share-link-block {
  min-width: 0;
  max-width: 100%;
}
.share-file {
  display: block;
  color: var(--text3);
  font-size: 11px;
  margin-bottom: 3px;
}
.share-mode {
  display: block;
  color: var(--text3);
  font-size: 10px;
  text-transform: uppercase;
  margin-bottom: 3px;
}
.share-result a {
  color: var(--accent-h);
  font-size: 12px;
  overflow-wrap: anywhere;
  text-decoration: none;
}
.share-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.text-actions-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
  gap: 8px;
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
  .files-tab {
    padding-bottom: 112px;
  }
  .text-actions-row {
    align-items: stretch;
    flex-direction: column-reverse;
  }
  .text-actions-row button {
    width: 100%;
  }
  .share-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .share-actions {
    display: inline-flex;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .share-result {
    padding: 12px;
  }
}
</style>
