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

      <div class="divider">paste text directly</div>

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
    </section>

  </div>
</template>

<style scoped>
.files-tab { display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: 18px; }
.upload-panel {
  position: relative;
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg1) 92%, transparent), color-mix(in srgb, var(--bg) 88%, transparent));
  box-shadow: 0 20px 48px color-mix(in srgb, var(--shadow) 60%, transparent);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  overflow: visible;
  padding: 22px;
}
.upload-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}
.upload-panel h1 {
  color: var(--text);
  font-size: var(--fs-display);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: var(--lh-tight);
  margin: 0;
}
.upload-panel p {
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  margin: var(--space-2) 0 0;
}
.upload-options {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  flex-wrap: wrap;
  min-width: min(100%, 360px);
}
.encrypt-toggle,
.name-toggle {
  border: 1px solid color-mix(in srgb, var(--border2) 82%, transparent);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg1) 84%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 38px;
  padding: 0 var(--space-3);
  color: var(--text2);
  font-size: var(--fs-sm);
  font-weight: 650;
  letter-spacing: -0.01em;
  width: fit-content;
  box-sizing: border-box;
}
.name-toggle {
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.name-toggle:hover {
  border-color: var(--border2);
  color: var(--text);
}
.name-toggle:active {
  transform: scale(0.97);
}
.encrypt-btn {
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.encrypt-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.encrypt-btn:not(:disabled):hover {
  border-color: var(--accent);
  color: var(--text);
  transform: translateY(-1px);
}
.encrypt-btn:not(:disabled):active {
  transform: translateY(0) scale(0.97);
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
.name-toggle input {
  appearance: none;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--border2);
  border-radius: 5px;
  background: var(--bg);
  display: inline-block;
  flex-shrink: 0;
  position: relative;
}
.name-toggle input:checked {
  border-color: var(--accent);
  background: var(--checked-bg);
}
.name-toggle input:checked::after {
  content: "";
  position: absolute;
  inset: 3px;
  background: var(--accent);
  border-radius: 2px;
}
.pw-input {
  width: 150px;
  min-height: 38px;
  font-size: var(--fs-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  box-sizing: border-box;
}
.password-wrap {
  position: relative;
}
.password-wrap .pw-input {
  padding-right: 38px;
}
.password-toggle {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--text2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.password-toggle:hover {
  color: var(--text);
}
.password-toggle:active {
  transform: translateY(-50%) scale(0.9);
}
.pw-field-enter-active,
.pw-field-leave-active {
  transition: opacity 0.18s ease, max-width 0.22s ease;
  overflow: hidden;
  max-width: 170px;
}
.pw-field-enter-from,
.pw-field-leave-to {
  opacity: 0;
  max-width: 0;
}
.share-result {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg1) 82%, transparent);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
}
.share-label {
  color: var(--text2);
  font-size: var(--fs-xs);
  text-transform: uppercase;
}
.share-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
}
.share-link-block {
  min-width: 0;
  max-width: 100%;
}
.share-file {
  display: block;
  color: var(--text2);
  font-size: var(--fs-xs);
  margin-bottom: 3px;
}
.share-mode {
  display: block;
  color: var(--text2);
  font-size: var(--fs-xs);
  text-transform: uppercase;
  margin-bottom: 3px;
}
.share-result a {
  color: var(--accent-h);
  font-size: var(--fs-sm);
  overflow-wrap: anywhere;
  text-decoration: none;
  transition: color var(--duration-fast) var(--ease-out);
}
.share-result a:hover {
  text-decoration: underline;
}
.share-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.upload-zone {
  border: 1px solid color-mix(in srgb, var(--border2) 88%, transparent);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--bg1) 60%, transparent);
  color: var(--text2);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 180px;
  padding: 34px 22px;
  text-align: center;
  transition: border-color var(--duration-base) var(--ease-out), background var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out);
}
.upload-zone svg {
  color: var(--text2);
  margin-bottom: 2px;
}
.upload-zone:hover,
.upload-zone.drag-over {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--bg1) 78%, transparent);
  transform: translateY(-2px);
}
.upload-zone:hover svg,
.upload-zone.drag-over svg {
  color: var(--accent);
}
.upload-zone:active {
  transform: translateY(0) scale(0.99);
}
.upload-zone-title {
  color: var(--text);
  font-size: var(--fs-h1);
  font-weight: 750;
  letter-spacing: -0.02em;
}
.upload-zone p {
  color: var(--text2);
  font-size: var(--fs-body);
  margin: 0;
}
.paste-area {
  border: 1px solid color-mix(in srgb, var(--border2) 76%, transparent);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg1) 72%, transparent);
  color: var(--text2);
  padding: 11px var(--space-4);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 42px;
  touch-action: manipulation;
  user-select: none;
  -webkit-touch-callout: none;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.paste-area span {
  font-size: var(--fs-sm);
  font-weight: 650;
}
.paste-area:hover {
  border-color: var(--text2);
  color: var(--text);
}
.paste-area:active {
  transform: scale(0.98);
}
.paste-area.pressing {
  border-color: var(--accent);
  background: var(--checked-bg);
  color: var(--accent);
}
.divider {
  color: var(--text3);
  font-size: var(--fs-xs);
  text-align: center;
}
.text-paste-input {
  width: 100%;
  min-height: 156px;
  resize: vertical;
  border-radius: var(--radius-md);
  padding: var(--space-4);
  line-height: var(--lh-body);
  box-sizing: border-box;
}
.text-actions-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 0;
  gap: var(--space-2);
}
.upload-progress {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg1) 82%, transparent);
  padding: var(--space-3);
}
.progress-row {
  display: flex;
  justify-content: space-between;
  color: var(--text2);
  font-size: var(--fs-xs);
  margin-bottom: 7px;
}
.progress-track {
  height: 7px;
  background: var(--bg);
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, var(--accent), var(--accent-h));
  transition: width 0.12s ease;
}
@media (max-width: 600px) {
  .files-tab {
    padding-bottom: 112px;
  }
  .upload-panel {
    border-radius: var(--radius-lg);
    padding: var(--space-4);
  }
  .upload-panel-head {
    flex-direction: column;
  }
  .upload-options {
    justify-content: flex-start;
    min-width: 0;
    width: 100%;
  }
  .upload-zone {
    min-height: 150px;
    padding: 26px 16px;
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
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
  }
}
.files-tab .btn-ghost,
.files-tab .btn-primary {
  transition: background var(--duration-fast) var(--ease-out), opacity var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.files-tab .btn-ghost:not(:disabled):active,
.files-tab .btn-primary:not(:disabled):active {
  transform: scale(0.97);
}
</style>
