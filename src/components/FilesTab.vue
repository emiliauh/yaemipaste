<script setup lang="ts">
import { ref, watch } from 'vue'
import { publicSiteOrigin, uploadFile, uploadText, type UploadProgress } from '../lib/api'
import { supportsBrowserEncryption } from '../lib/e2ee'
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
}
const shareLinks = ref<ShareLinkItem[]>([])
const uploadProgress = ref<UploadProgress | null>(null)
const encryptMode = ref<'none' | 'encrypt' | 'password'>('none')
const encryptPassword = ref('')
const showEncryptPassword = ref(false)
const browserEncryptionReady = supportsBrowserEncryption()
let shareLinkId = 0
const notificationStore = useNotificationStore()

watch(keepFileName, (value) => {
  localStorage.setItem(KEEP_NAME_KEY, value ? '1' : '0')
})

function cycleEncrypt() {
  if (!browserEncryptionReady) {
    showToast('Browser encryption requires HTTPS or localhost.', 'error')
    return
  }
  if (encryptMode.value === 'none') encryptMode.value = 'encrypt'
  else if (encryptMode.value === 'encrypt') encryptMode.value = 'password'
  else {
    encryptMode.value = 'none'
    encryptPassword.value = ''
    showEncryptPassword.value = false
  }
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

function absolutePublicUrl(value: string): string {
  return new URL(value, publicSiteOrigin()).toString()
}

function pushShareLink(name: string, previewUrl: string, _fileName: string) {
  const entry: ShareLinkItem = {
    id: ++shareLinkId,
    name,
    previewUrl: absolutePublicUrl(previewUrl),
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

    <section class="upload-panel" aria-label="Upload controls">
      <div class="upload-panel-head">
        <div>
          <h1>Share a file or paste</h1>
          <p>
            <template v-if="!browserEncryptionReady">Use HTTPS or localhost to enable browser encryption.</template>
            <template v-else-if="encryptMode === 'password'">Password-protected before upload.</template>
            <template v-else-if="encryptMode === 'encrypt'">Encrypted in this browser before upload.</template>
            <template v-else>Public short link, ready to copy.</template>
          </p>
        </div>
      </div>

      <div class="upload-options">
        <button
          type="button"
          class="encrypt-toggle encrypt-btn"
          :class="{ 'active-encrypt': encryptMode === 'encrypt', 'active-password': encryptMode === 'password' }"
          data-testid="encrypt-toggle"
          :disabled="!browserEncryptionReady"
          :title="browserEncryptionReady ? 'Cycle encryption mode' : 'Browser encryption requires HTTPS or localhost.'"
          @click="cycleEncrypt"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <span>{{ encryptMode === 'none' ? 'Encryption off' : encryptMode === 'encrypt' ? 'Encrypted link' : 'Password protected' }}</span>
        </button>
        <Transition name="pw-field">
          <div v-if="encryptMode === 'password'" class="password-wrap">
            <input
              v-model="encryptPassword"
              :type="showEncryptPassword ? 'text' : 'password'"
              class="pw-input"
              placeholder="Set password"
              autocomplete="new-password"
            />
            <button
              type="button"
              class="password-toggle"
              :aria-label="showEncryptPassword ? 'Hide password' : 'Show password'"
              :title="showEncryptPassword ? 'Hide password' : 'Show password'"
              @click="showEncryptPassword = !showEncryptPassword"
            >
              <svg v-if="showEncryptPassword" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M3 3l18 18"/>
                <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/>
                <path d="M9.9 4.2A10.8 10.8 0 0 1 12 4c5.3 0 9.5 4.2 10.5 8-.4 1.6-1.5 3.3-3 4.8"/>
                <path d="M6.2 6.2C4.3 7.7 2.9 9.8 2 12c1 3.8 5.2 8 10 8 1 0 2-.2 2.9-.5"/>
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M2 12s3.8-8 10-8 10 8 10 8-3.8 8-10 8-10-8-10-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
        </Transition>
        <label class="name-toggle" data-testid="keep-name-toggle">
          <input v-model="keepFileName" type="checkbox" />
          <span>Keep original name</span>
        </label>
      </div>
    </section>

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
      <div class="upload-zone-title">Drop files here</div>
      <p>or click to choose from your device</p>
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
      <span>{{ longPressing ? 'Release to paste' : 'Long-press to paste from clipboard' }}</span>
    </div>

    <div class="divider">Paste text directly</div>

    <!-- Text area -->
    <textarea
      v-model="textPaste"
      data-testid="text-paste"
      rows="6"
      placeholder="Paste text, logs, notes, or snippets..."
      class="text-paste-input"
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
          <a :href="share.previewUrl" target="_blank" rel="noopener">{{ share.previewUrl }}</a>
        </div>
        <div class="share-actions">
          <button class="btn-ghost" type="button" @click="copyShareUrl(share.previewUrl).then((ok) => showToast(ok ? 'Copied to clipboard' : 'Copy failed', ok ? 'success' : 'error'))">
            Copy
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.files-tab {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  padding-bottom: 18px;
}
.files-tab > :first-child,
.upload-panel,
.upload-options,
.upload-zone,
.paste-area,
.divider,
textarea,
.text-actions-row,
.upload-progress,
.share-result {
  grid-column: 1 / -1;
}
.upload-panel {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface) 97%, var(--accent-soft));
  display: grid;
  gap: 14px;
  padding: 22px;
  box-shadow:
    0 16px 38px color-mix(in srgb, var(--shadow) 18%, transparent),
    0 1px 0 color-mix(in srgb, var(--text) 7%, transparent) inset;
}
.upload-panel::after { display: none; }
.upload-panel-head {
  display: block;
  max-width: 620px;
}
.upload-panel h1 {
  color: var(--text);
  font-size: clamp(25px, 4vw, 34px);
  line-height: 1.05;
  font-weight: 700;
  letter-spacing: 0;
  text-wrap: balance;
}
.upload-panel p {
  margin-top: 9px;
  color: var(--text3);
  font-size: 13px;
  max-width: 54ch;
}
.name-toggle {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface2) 88%, transparent);
  min-height: 40px;
  padding: 0 12px;
  color: var(--text2);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  flex: 0 0 auto;
}
.name-toggle:hover {
  border-color: var(--border2);
  color: var(--text);
}
.upload-options {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.encrypt-toggle {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface2) 88%, transparent);
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-height: 40px;
  padding: 0 12px;
  color: var(--text2);
  font-size: 12px;
  font-weight: 600;
  width: fit-content;
  box-sizing: border-box;
}
.encrypt-btn {
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.encrypt-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.encrypt-btn:hover {
  border-color: color-mix(in srgb, var(--accent) 42%, var(--border2));
  color: var(--text);
  transform: translateY(-1px);
}
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
.name-toggle input { margin-top: 1px; }
.pw-input {
   width: 140px;
   min-height: 40px;
   font-size: 12px;
   padding: 0 10px;
   box-sizing: border-box;
}
.password-wrap {
  position: relative;
}
.password-wrap .pw-input {
  padding-right: 36px;
}
.password-toggle {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--text3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.password-toggle:hover {
  color: var(--text);
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
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface) 96%, var(--accent-soft));
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  box-shadow: 0 12px 28px color-mix(in srgb, var(--shadow) 16%, transparent);
}
.share-label {
  color: var(--text3);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: lowercase;
}
.share-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px;
  border-radius: 13px;
  background: color-mix(in srgb, var(--surface2) 70%, transparent);
}
.share-link-block {
  min-width: 0;
  max-width: 100%;
}
.share-file {
  display: block;
  color: var(--text3);
  font-size: 11px;
  font-weight: 600;
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
  color: var(--accent);
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
  margin-top: 4px;
  gap: 8px;
}
.text-actions-row button {
  scroll-margin-bottom: 300px;
}
.upload-progress {
  border: 1px solid var(--border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  padding: 12px 14px;
}
.progress-row {
  display: flex;
  justify-content: space-between;
  color: var(--text3);
  font-size: 11px;
  margin-bottom: 7px;
}
.progress-track {
  height: 9px;
  background: var(--bg);
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  width: 0;
  background: var(--accent);
  transition: width 0.12s ease;
}
.paste-area {
  border: 1px dashed var(--border2);
  border-radius: 14px;
  padding: 13px 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  touch-action: manipulation;
  user-select: none;
  -webkit-touch-callout: none;
  width: 100%;
}
.paste-area span {
  color: var(--text3);
  font-size: 12px;
}
.paste-area:hover { border-color: var(--text3); }
.paste-area.pressing {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent-soft) 55%, transparent);
}
.divider {
  text-align: left;
  color: var(--text3);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: lowercase;
}
textarea[data-testid="text-paste"] {
  min-height: 180px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  border-radius: 14px;
}
.text-paste-input {
  width: 100%;
  resize: vertical;
}
@media (max-width: 600px) {
  .files-tab {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding-bottom: 260px;
  }
  .text-actions-row {
    align-items: stretch;
    flex-direction: column-reverse;
  }
  .upload-panel {
    padding: 18px;
  }
  .upload-panel::after {
    width: 66px;
    height: 66px;
    right: 12px;
    top: 12px;
  }
  .upload-panel-head {
    flex-direction: column;
    gap: 12px;
  }
  .name-toggle,
  .encrypt-toggle,
  .password-wrap,
  .pw-input {
    width: 100%;
  }
  .upload-options {
    width: 100%;
  }
  .text-actions-row button {
    width: 100%;
  }
  .text-actions-row button:last-child {
    width: calc(100% - 96px);
    margin-right: auto;
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
    order: -1;
  }
}
</style>
