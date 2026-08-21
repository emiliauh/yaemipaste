<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { formatGigabytes, publicSiteOrigin, uploadFile, uploadText, type UploadProgress } from '../lib/api'
import { supportsBrowserEncryption } from '../lib/e2ee'
import ExpirySelector from './ExpirySelector.vue'
import { defaultExpiryValue, isValidExpiryValue, type ExpiryValue } from '../lib/expiry'
import { useNotificationStore } from '../stores/notifications'
import { usePublicSettings } from '../lib/publicSettings'

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
const expirySelector = ref<{ collapse: () => void } | null>(null)
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
const { publicSettings, refreshPublicSettings } = usePublicSettings()
const fileSizeLimitLabel = computed(() => publicSettings.value.file_size_limit_bytes > 0 ? formatGigabytes(publicSettings.value.file_size_limit_bytes) : '')
void refreshPublicSettings()

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
  nextTick(() => {
    document.querySelector('.share-result')?.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior })
  })
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
  expirySelector.value?.collapse()
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
    expirySelector.value?.collapse()
  }
}

// Long-press paste support
let pressTimer: ReturnType<typeof setTimeout> | null = null
let longPressReady = false

/**
 * Extract the files (and fall back to plain text) from a clipboard paste.
 * Used by both Ctrl/Cmd+V and the long-press paste button so images and
 * small files pasted from the clipboard upload like a drop or file pick.
 */
async function handleClipboardPaste(source: ClipboardEvent | null, readFromClipboardApi = false) {
  // Prefer the synchronous clipboardData items from a real paste event (files
  // are available there without extra permission prompts).
  const items = source?.clipboardData?.items;
  if (items) {
    const files: File[] = [];
    let text = '';
    for (const item of Array.from(items)) {
      const file = item.kind === 'file' ? item.getAsFile() : null;
      if (file) files.push(file);
      else if (item.kind === 'string' && item.type === 'text/plain') {
        text += await new Promise<string>((resolve) => item.getAsString((value) => resolve(value)));
      }
    }
    if (files.length) {
      handleFiles(files)
      return true;
    }
    if (text) {
      textPaste.value = text;
      showToast('Pasted from clipboard');
      return true;
    }
  }

  // Fall back to the async clipboard API (needed when there is no live paste
  // event, e.g. the long-press button) so image files still upload.
  if (readFromClipboardApi && typeof navigator.clipboard?.read === 'function') {
    try {
      const clipboardItems = await navigator.clipboard.read();
      const files: File[] = [];
      let text = '';
      for (const clipboardItem of clipboardItems) {
        for (const type of clipboardItem.types) {
          if (type.startsWith('image/') || type === 'text/plain') {
            const blob = await clipboardItem.getType(type);
            if (type.startsWith('image/')) {
              const ext = type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
              files.push(new File([blob], 'clipboard.' + ext, { type }));
            } else {
              text += await blob.text();
            }
          }
        }
      }
      if (files.length) {
        handleFiles(files)
        return true;
      }
      if (text) {
        textPaste.value = text;
        showToast('Pasted from clipboard');
        return true;
      }
    } catch {
      // Permission denied or unsupported; fall through to the caller's error path.
    }
  }
  return false;
}

function onGlobalPaste(e: ClipboardEvent) {
  // Ignore pastes targeted at inputs/textareas (they handle text natively and
  // the textarea already submits its own paste), but still capture file pastes.
  const target = e.target as HTMLElement | null;
  const isEditable = target && (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName));
  const hasFiles = Array.from(e.clipboardData?.items ?? []).some((item) => item.kind === 'file');
  if (hasFiles) {
    e.preventDefault();
    void handleClipboardPaste(e);
    return;
  }
  // Plain text paste: only capture it when not inside an editable field so
  // normal text editing still works. The paste area above uses the long-press
  // path and fills the textarea itself.
  if (!isEditable && !target?.closest('.files-tab')) return;
  if (!isEditable) {
    e.preventDefault();
    void handleClipboardPaste(e);
  }
}

onMounted(() => window.addEventListener('paste', onGlobalPaste));
onBeforeUnmount(() => window.removeEventListener('paste', onGlobalPaste));

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
    const handled = await handleClipboardPaste(null, true)
    if (handled) return;
    // No image/file was available; fall back to plain text for the text area.
    const text = await navigator.clipboard.readText()
    if (text) {
      textPaste.value = text
      showToast('Pasted from clipboard');
      return;
    }
    showToast('Nothing to paste', 'error')
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
    <ExpirySelector ref="expirySelector" :model-value="expiry" @update:model-value="setExpiry" />

    <header class="page-head">
      <div class="page-head-copy">
        <h1>Share a file or paste</h1>
        <p class="page-sub">
          <template v-if="!browserEncryptionReady">Use HTTPS or localhost to enable browser encryption.</template>
          <template v-else-if="encryptMode === 'password'">Password-protected before upload.</template>
          <template v-else-if="encryptMode === 'encrypt'">Encrypted in this browser before upload.</template>
          <template v-else>Public short link, ready to copy.</template>
        </p>
        <p v-if="fileSizeLimitLabel" class="upload-limit-note">Maximum file size: <strong>{{ fileSizeLimitLabel }}</strong></p>
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
    </header>

    <section class="upload-panel" aria-label="Upload controls">

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
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  overflow: visible;
  padding: var(--space-5);
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-3);
}
.page-head-copy {
  min-width: 0;
}
.page-head h1 {
  color: var(--text);
  font-size: var(--fs-display);
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: var(--lh-tight);
  margin: 0;
}
.page-head .page-sub {
  color: var(--text2);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  margin: var(--space-2) 0 0;
}
.upload-limit-note {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--bg2);
  color: var(--text2);
  font-size: var(--fs-xs);
}
.upload-limit-note strong {
  color: var(--text);
  font-weight: 600;
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
  border-radius: var(--radius);
  background: var(--surface2);
  box-shadow: none;
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
.encrypt-btn {
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.encrypt-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.encrypt-btn:not(:disabled):hover {
  border-color: var(--border2);
  background: color-mix(in srgb, var(--bg1) 55%, transparent);
  color: var(--text);
}
.encrypt-btn:not(:disabled):active {
  transform: none;
}
.encrypt-btn.active-encrypt {
  border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--bg1));
}
.encrypt-btn.active-encrypt:not(:disabled):hover {
  border-color: var(--accent);
  color: var(--accent-h);
  background: color-mix(in srgb, var(--accent) 18%, var(--bg1));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
}
.encrypt-btn.active-password {
  border-color: color-mix(in srgb, var(--orange-h) 68%, var(--border));
  color: var(--orange-h);
  background: color-mix(in srgb, var(--orange-h) 12%, var(--bg1));
}
.encrypt-btn.active-password:not(:disabled):hover {
  border-color: var(--orange-h);
  color: var(--orange-h);
  background: color-mix(in srgb, var(--orange-h) 18%, var(--bg1));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--orange-h) 16%, transparent);
}
.name-toggle input {
  width: 17px;
  height: 17px;
  flex-basis: 17px;
}
.pw-input {
  width: 150px;
  min-height: 38px;
  font-size: var(--fs-sm);
  padding: 0 var(--space-3);
  border-radius: var(--radius);
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
  font-weight: 600;
  letter-spacing: 0.01em;
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
  border: 1.5px dashed var(--border2);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg1) 55%, transparent);
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
  transition: border-color var(--duration-base) var(--ease-out), background var(--duration-base) var(--ease-out);
}
.upload-zone svg {
  color: var(--text2);
  margin-bottom: 2px;
}
.upload-zone:hover,
.upload-zone.drag-over {
  border-color: var(--ring);
  background: color-mix(in srgb, var(--bg1) 78%, transparent);
}
.upload-zone:hover svg,
.upload-zone.drag-over svg {
  color: var(--accent);
}
.upload-zone-title {
  color: var(--text);
  font-size: var(--fs-h1);
  font-weight: 600;
  letter-spacing: -0.015em;
}
.upload-zone p {
  color: var(--text2);
  font-size: var(--fs-body);
  margin: 0;
}
.paste-area {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg2);
  color: var(--text2);
  padding: var(--space-3) var(--space-4);
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
  font-weight: 500;
}
.paste-area:hover {
  border-color: var(--border2);
  color: var(--text);
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
  background: var(--bg1);
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
  background: var(--accent);
  transition: width 0.12s ease;
}
@media (min-width: 601px) and (max-height: 820px) {
  .files-tab {
    gap: 8px;
  }

  .upload-panel {
    gap: 10px;
    padding: 16px 18px;
  }

  .page-head h1 {
    font-size: clamp(22px, 3vw, 28px);
  }

  .page-head .page-sub {
    margin-top: 5px;
  }

  .upload-zone {
    padding: 28px 18px;
  }

  .paste-area {
    min-height: 38px;
    padding: 9px 12px;
  }

  textarea[data-testid="text-paste"],
  .text-paste-input {
    height: clamp(124px, 21dvh, 180px);
    min-height: clamp(124px, 21dvh, 180px);
  }

  .text-actions-row {
    margin-top: 0;
  }
}

@media (max-width: 600px) {
  .files-tab {
    padding-bottom: 112px;
  }
  .upload-panel {
    border-radius: var(--radius-lg);
    padding: var(--space-4);
  }
  .page-head {
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
    scroll-margin-bottom: calc(var(--mobile-bar-space) + var(--space-2));
  }
}
@media (min-width: 601px) and (max-width: 960px) {
  /* Intermediate widths squeeze the title next to the upload controls;
     stack the header like the mobile layout instead. */
  .page-head {
    flex-direction: column;
    align-items: flex-start;
  }
  .upload-options {
    justify-content: flex-start;
    min-width: 0;
    width: 100%;
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
